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
} = core

const PKG = '@antora-supplemental/link-validator'
const REPORT_DIR = 'link-validator'

/**
 * Antora extension: validate outbound http(s) links after site publish.
 * Core checking lives in @antora-supplemental/asciidoc-link-validator.
 *
 * Config (playbook antora.extensions entry):
 * - failLevel: 'none' | 'error' (default none)
 * - concurrency, timeoutMs, suppressionsFile, reportEmail
 * - checkImages, baselinePath, writeBaseline, softFail403
 * - includeFragments: reserved stub
 * - skip: boolean
 * - ciTrigger: { enabled, provider, dispatchUrl, statusUrl, workflowId, ref, label, pollIntervalMs }
 * - groupingDefault: 'byDestination' | 'bySourcePage' | 'byStatus' | 'byHost' (optional override)
 */
function register ({ config = {} } = {}) {
  const context = this
  if (config.skip) return

  const opts = normalizeConfig(config)

  context.on('sitePublished', async ({ playbook, siteCatalog, contentCatalog }) => {
    const logger = typeof context.getLogger === 'function'
      ? context.getLogger(PKG)
      : { warn: (...a) => console.warn(`[${PKG}]`, ...a), info: (...a) => console.log(`[${PKG}]`, ...a) }

    const playbookDir = playbook.dir || process.cwd()
    const outDir = ospath.resolve(playbookDir, playbook.output?.dir || 'build/site')
    const reportDir = ospath.join(outDir, REPORT_DIR)

    const entries = collectFromCatalog(contentCatalog, opts)
    const suppressionsPath = opts.suppressionsFile
      ? ospath.resolve(playbookDir, opts.suppressionsFile)
      : ospath.resolve(playbookDir, '.antora-link-suppressions.yml')
    const rules = loadSuppressions(suppressionsPath)

    const checked = await checkUrls(entries, {
      concurrency: opts.concurrency,
      timeoutMs: opts.timeoutMs,
      softFail403: opts.softFail403,
    })

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
      meta: {
        reportEmail: opts.reportEmail,
        failLevel: opts.failLevel,
        softFail403: opts.softFail403,
        includeFragments: opts.includeFragments,
        ciTrigger,
      },
    })

    for (const inv of report.invalid) {
      const src = inv.sources?.length ? inv.sources.join(', ') : '(unknown page)'
      logger.warn(
        `invalid link ${inv.url} [${inv.classification}${inv.status != null ? '/' + inv.status : ''}] from ${src}`
      )
    }

    fs.mkdirSync(reportDir, { recursive: true })
    const reportJsonPath = ospath.join(reportDir, 'report.json')
    fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
    fs.writeFileSync(ospath.join(reportDir, 'report.md'), formatMarkdown(report), 'utf8')

    // Archive a timestamped copy for triage history listing
    const stamp = (report.generatedAt || new Date().toISOString()).replace(/[:.]/g, '-')
    const archiveName = `report-${stamp}.json`
    try {
      fs.writeFileSync(ospath.join(reportDir, archiveName), JSON.stringify(report, null, 2) + '\n', 'utf8')
    } catch (_) {}

    const triageHtml = buildTriageHtml({
      title: 'Link Validator',
      reportPath: './report.json',
      cssHref: './link-validator.css',
      jsHref: './link-validator.js',
      reportEmail: opts.reportEmail,
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

    if (opts.writeBaseline && opts.baselinePath) {
      writeBaseline(ospath.resolve(playbookDir, opts.baselinePath), report)
    }

    if (opts.failLevel === 'error' && report.invalid.length) {
      throw new Error(`[${PKG}] ${report.invalid.length} invalid link(s); see ${reportJsonPath}`)
    }

    logger.info?.(
      `wrote ${reportJsonPath} (invalid=${report.summary.invalid}, newly=${report.summary.newlyInvalid}, group=${report.summary.groupingDefault})`
    )
  })
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
  }
}

function collectFromCatalog (contentCatalog, opts) {
  const map = new Map()
  if (!contentCatalog || typeof contentCatalog.findBy !== 'function') return []

  for (const page of contentCatalog.findBy({ family: 'page' }) || []) {
    if (!page.out && !page.pub) continue
    const sourcePage = page.pub?.url || page.out?.path || page.src?.path || '(page)'
    let html = ''
    if (page.contents) {
      html = Buffer.isBuffer(page.contents) ? page.contents.toString('utf8') : String(page.contents)
    }
    let asciidoc = ''
    const abspath = page.src?.abspath
    if (abspath && fs.existsSync(abspath)) {
      try { asciidoc = fs.readFileSync(abspath, 'utf8') } catch (_) {}
    } else if (page.src?.contents) {
      asciidoc = Buffer.isBuffer(page.src.contents)
        ? page.src.contents.toString('utf8')
        : String(page.src.contents)
    }

    for (const e of extractFromContent({
      html,
      asciidoc,
      sourcePage,
      checkImages: opts.checkImages,
    })) {
      // Attach lightweight source map when cheap
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
  return [...map.values()]
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
