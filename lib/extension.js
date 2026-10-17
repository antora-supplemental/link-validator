'use strict'

const fs = require('node:fs')
const ospath = require('node:path')

const core = require('@antora-supplemental/asciidoc-link-validator')
const {
  extractFromContent,
  checkUrls,
  loadSuppressions,
  filterSuppressed,
  buildReport,
  formatMarkdown,
  readBaseline,
  writeBaseline,
  buildTriageHtml,
  normalizeCiTrigger,
  buildReportHistory,
  createProgress,
  resolveInvalidationLists,
} = core

const registryMeta = require('./registry-meta.js')
// Local fallback if core is an older pin without createProgress
const { createProgress: localCreateProgress } = require('./progress.js')

const PKG = '@antora-supplemental/link-validator'
const TOOL = 'link-validator'
const REPORT_DIR = 'link-validator'

/**
 * Antora extension: validate outbound http(s) links from classified page sources.
 *
 * Runs on contentClassified (earliest hook with classified pages + source paths)
 * so preface + progress stream during the build rather than only at sitePublished.
 * Report/UI files are written on sitePublished (output dir + siteCatalog).
 *
 * Note: Antora may buffer logger output until a hook returns; we log immediately
 * at contentClassified entry. Interim progress uses the Antora logger (discrete
 * throttled lines). For local TTY CLI use, prefer asciidoc-link-validator.
 *
 * Config (playbook antora.extensions entry):
 * - failLevel: 'none' | 'error' (default none)
 * - concurrency, timeoutMs, suppressionsFile, reportEmail
 * - checkImages, baselinePath, writeBaseline, softFail403
 * - cacheEnabled, cachePath, cacheMaxAgeMs, cacheBypass
 * - invalidateSources, invalidateUrls (also env LINK_VALIDATOR_INVALIDATE_*)
 * - reportRateLimited: include exhausted 429 in invalid (default false)
 * - includeFragments: reserved stub
 * - skip: boolean
 * - ciTrigger: { enabled, provider, dispatchUrl, statusUrl, workflowId, ref, label, pollIntervalMs }
 * - groupingDefault: 'byDestination' | 'bySourcePage' | 'byStatus' | 'byHost' (optional override)
 *
 * CI: pass GITHUB_TOKEN via env (never embed tokens in the playbook).
 */
function register ({ config = {} } = {}) {
  const context = this
  if (config.skip) return

  const opts = normalizeConfig(config)
  /** @type {null | { report: object, playbookDir: string, outDir: string }} */
  let pending = null

  context.on('contentClassified', async ({ playbook, contentCatalog }) => {
    const logger = getLogger(context)
    const makeProgress = typeof createProgress === 'function' ? createProgress : localCreateProgress
    const progress = makeProgress({ id: TOOL, logger })

    progress.starting('starting outbound link check')

    const playbookDir = playbook.dir || process.cwd()
    const cachePath = opts.cachePath
      ? ospath.resolve(playbookDir, opts.cachePath)
      : ospath.resolve(playbookDir, '.link-check-cache.json')

    const { entries, pageCount } = collectFromCatalog(contentCatalog, opts, progress)

    progress.enumDone(pageCount, entries.length + ' links')

    const suppressionsPath = opts.suppressionsFile
      ? ospath.resolve(playbookDir, opts.suppressionsFile)
      : ospath.resolve(playbookDir, '.antora-link-suppressions.yml')
    const rules = loadSuppressions(suppressionsPath)

    const invalidation = resolveInvalidationLists({
      invalidateSources: opts.invalidateSources,
      invalidateUrls: opts.invalidateUrls,
    })

    const checked = await checkUrls(entries, {
      concurrency: opts.concurrency,
      timeoutMs: opts.timeoutMs,
      softFail403: opts.softFail403,
      cacheEnabled: opts.cacheEnabled,
      cachePath,
      cacheMaxAgeMs: opts.cacheMaxAgeMs,
      cacheBypass: opts.cacheBypass,
      invalidateSources: invalidation.invalidateSources,
      invalidateUrls: invalidation.invalidateUrls,
      reportRateLimited: opts.reportRateLimited,
      onProgress (done, total) { progress.tick(done, total) },
    })

    const cachedCount = checked._meta?.cached ?? checked.filter((r) => r.fromCache).length

    const { active, suppressed } = filterSuppressed(checked, rules)
    const baseline = opts.baselinePath
      ? readBaseline(ospath.resolve(playbookDir, opts.baselinePath))
      : null

    const ciTrigger = normalizeCiTrigger(opts.ciTrigger)

    const report = buildReport({
      results: active,
      suppressed,
      baseline,
      groupingDefault: opts.groupingDefault,
      reportRateLimited: opts.reportRateLimited,
      meta: {
        reportEmail: opts.reportEmail,
        failLevel: opts.failLevel,
        softFail403: opts.softFail403,
        includeFragments: opts.includeFragments,
        ciTrigger,
        cacheEnabled: opts.cacheEnabled,
        cachePath: opts.cacheEnabled ? cachePath : null,
        githubAuth: Boolean(checked._meta?.githubAuth),
        invalidateSources: invalidation.invalidateSources,
        invalidateUrls: invalidation.invalidateUrls,
      },
    })

    const rateLimited = report.deferred?.filter((r) => r.classification === 'rate-limited').length || 0

    if (report.summary.invalid > 0) {
      logger.warn(
        `${TOOL}: ${report.summary.invalid} invalid link(s) after live checks ` +
        `(rate-limited=${rateLimited}, cached=${cachedCount}, deferred=${report.summary.deferred || 0}); ` +
        'see link-validator/report.json'
      )
    } else {
      logger.info?.(
        `${TOOL}: check complete (invalid=0, rate-limited=${rateLimited}, cached=${cachedCount}, ` +
        `links=${entries.length})`
      )
    }

    progress.done(
      `check complete (invalid=${report.summary.invalid}, newly=${report.summary.newlyInvalid}, links=${entries.length})`
    )

    const outDir = ospath.resolve(playbookDir, playbook.output?.dir || 'build/site')
    pending = { report, playbookDir, outDir, ciTrigger, opts }
  })

  context.on('sitePublished', async ({ playbook, siteCatalog }) => {
    const logger = getLogger(context)
    if (!pending) {
      logger.info?.(`${TOOL}: no pending report (contentClassified did not run); skipping write`)
      return
    }

    const { report, playbookDir, outDir, ciTrigger, opts: extOpts } = pending
    const reportDir = ospath.join(outDir, REPORT_DIR)
    fs.mkdirSync(reportDir, { recursive: true })
    const reportJsonPath = ospath.join(reportDir, 'report.json')

    const stamp = (report.generatedAt || new Date().toISOString()).replace(/[:.]/g, '-')
    const archiveName = `report-${stamp}.json`
    report.meta = report.meta || {}
    report.meta.reportHistory = buildReportHistory(reportDir, {
      limit: extOpts.reportHistoryLimit || 20,
      excludeNames: [archiveName],
    })

    fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
    fs.writeFileSync(ospath.join(reportDir, 'report.md'), formatMarkdown(report), 'utf8')

    try {
      const archived = { ...report, meta: { ...report.meta, reportHistory: undefined } }
      delete archived.meta.reportHistory
      fs.writeFileSync(ospath.join(reportDir, archiveName), JSON.stringify(archived, null, 2) + '\n', 'utf8')
    } catch (_) {}

    const triageHtml = buildTriageHtml({
      title: 'Link Validator',
      reportPath: './report.json',
      cssHref: './link-validator.css',
      jsHref: './link-validator.js',
      reportEmail: extOpts.reportEmail,
      ciTrigger,
    })
    fs.writeFileSync(ospath.join(reportDir, 'index.html'), triageHtml, 'utf8')

    copyUiAsset(ospath.join(__dirname, '..', 'ui', 'js', 'link-validator.js'), ospath.join(reportDir, 'link-validator.js'))
    copyUiAsset(ospath.join(__dirname, '..', 'ui', 'css', 'link-validator.css'), ospath.join(reportDir, 'link-validator.css'))
    copyUiAsset(
      ospath.join(__dirname, '..', 'ui', 'partials', 'footer-link-validator.hbs'),
      ospath.join(reportDir, 'footer-link-validator.hbs')
    )

    if (siteCatalog && typeof siteCatalog.addFile === 'function') {
      addSiteFile(siteCatalog, 'link-validator/report.json', fs.readFileSync(reportJsonPath))
      addSiteFile(siteCatalog, 'link-validator/index.html', Buffer.from(triageHtml))
      addSiteFile(siteCatalog, 'link-validator/report.md', fs.readFileSync(ospath.join(reportDir, 'report.md')))
    }

    if (extOpts.writeBaseline && extOpts.baselinePath) {
      writeBaseline(ospath.resolve(playbookDir, extOpts.baselinePath), report)
    }

    logger.info?.(
      `${TOOL}: wrote ${reportJsonPath} (invalid=${report.summary.invalid}, ` +
      `deferred=${report.summary.deferred || 0}, cached=${report.summary.cached || 0}, ` +
      `group=${report.summary.groupingDefault})`
    )

    if (extOpts.failLevel === 'error' && report.invalid.length) {
      throw new Error(`[${PKG}] ${report.invalid.length} invalid link(s); see ${reportJsonPath}`)
    }
  })
}

function getLogger (context) {
  return typeof context.getLogger === 'function'
    ? context.getLogger(PKG)
    : {
      warn: (...a) => console.warn(`[${PKG}]`, ...a),
      info: (...a) => console.log(`[${PKG}]`, ...a),
    }
}

function normalizeConfig (config) {
  return {
    failLevel: config.failLevel || 'none',
    concurrency: Number(config.concurrency) || 8,
    timeoutMs: Number(config.timeoutMs) || 10000,
    suppressionsFile: config.suppressionsFile || null,
    reportEmail: config.reportEmail || 'support@devcentr.org',
    checkImages: config.checkImages !== false,
    baselinePath: config.baselinePath || null,
    writeBaseline: Boolean(config.writeBaseline),
    softFail403: config.softFail403 !== false,
    includeFragments: Boolean(config.includeFragments),
    ciTrigger: config.ciTrigger || {},
    groupingDefault: config.groupingDefault || null,
    reportHistoryLimit: Number(config.reportHistoryLimit) || 20,
    cacheEnabled: config.cacheEnabled !== false,
    cachePath: config.cachePath || '.link-check-cache.json',
    cacheMaxAgeMs: config.cacheMaxAgeMs != null ? Number(config.cacheMaxAgeMs) : null,
    cacheBypass: Boolean(config.cacheBypass) ||
      String(process.env.LINK_VALIDATOR_CACHE_BYPASS || '').toLowerCase() === 'true',
    invalidateSources: config.invalidateSources || [],
    invalidateUrls: config.invalidateUrls || [],
    reportRateLimited: Boolean(config.reportRateLimited),
  }
}

/**
 * Collect outbound URLs from classified pages, preferring source .adoc paths.
 * Animates page enumeration via progress.enumStart/enumTick.
 */
function collectFromCatalog (contentCatalog, opts, progress) {
  const map = new Map()
  let pageCount = 0
  if (!contentCatalog || typeof contentCatalog.findBy !== 'function') {
    progress.enumStart('pages')
    progress.enumDone(0, '0 links')
    return { entries: [], pageCount: 0 }
  }

  const pages = contentCatalog.findBy({ family: 'page' }) || []
  progress.enumStart('pages')

  for (const page of pages) {
    // Prefer pages that will publish; still allow src-only classified files.
    if (!page.out && !page.pub && !page.src) continue
    pageCount += 1
    progress.enumTick(pageCount)

    const sourcePage = page.pub?.url || page.out?.path || page.src?.path || '(page)'
    let html = ''
    // At contentClassified, contents may still be source; treat as asciidoc fallback only.
    // Prefer reading .adoc from abspath for outbound URL extraction.
    let asciidoc = ''
    const abspath = page.src?.abspath
    if (abspath && fs.existsSync(abspath)) {
      try { asciidoc = fs.readFileSync(abspath, 'utf8') } catch (_) {}
    } else if (page.src?.contents) {
      asciidoc = Buffer.isBuffer(page.src.contents)
        ? page.src.contents.toString('utf8')
        : String(page.src.contents)
    } else if (page.contents) {
      // Fallback: page.contents before conversion is often AsciiDoc source
      asciidoc = Buffer.isBuffer(page.contents) ? page.contents.toString('utf8') : String(page.contents)
    }

    for (const e of extractFromContent({
      html,
      asciidoc,
      sourcePage,
      checkImages: opts.checkImages,
    })) {
      e.sourceMap = e.sourceMap || {
        page: sourcePage,
        component: page.src?.component,
        module: page.src?.module,
        version: page.src?.version,
        path: page.src?.path,
      }
      if (map.has(e.url)) {
        const cur = map.get(e.url)
        for (const s of e.sources) {
          if (!cur.sources.includes(s)) cur.sources.push(s)
        }
        if (!cur.sourceMaps) cur.sourceMaps = cur.sourceMap ? [cur.sourceMap] : []
        if (e.sourceMap) cur.sourceMaps.push(e.sourceMap)
      } else {
        e.sourceMaps = e.sourceMap ? [e.sourceMap] : []
        map.set(e.url, e)
      }
    }
  }
  return { entries: [...map.values()], pageCount }
}

function copyUiAsset (from, to) {
  try {
    if (fs.existsSync(from)) fs.copyFileSync(from, to)
  } catch (_) {}
}

function addSiteFile (siteCatalog, pathOut, contents) {
  try {
    siteCatalog.addFile({
      contents: Buffer.isBuffer(contents) ? contents : Buffer.from(contents),
      out: { path: pathOut },
      pub: { url: '/' + pathOut.replace(/\\/g, '/'), absolute: false },
    })
  } catch (_) {}
}

module.exports = register
module.exports.register = register
module.exports.registryMeta = registryMeta
