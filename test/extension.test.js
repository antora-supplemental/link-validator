'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

describe('link-validator extension', () => {
  it('exports register', () => {
    const ext = require('../lib/extension.js')
    assert.equal(typeof ext, 'function')
    assert.equal(typeof ext.register, 'function')
  })

  it('register is a no-op when skip:true', () => {
    const ext = require('../lib/extension.js')
    const calls = []
    const fake = {
      on (...args) { calls.push(args) },
      getLogger () { return { warn () {}, info () {} } },
    }
    ext.register.call(fake, { config: { skip: true } })
    assert.equal(calls.length, 0)
  })

  it('register hooks sitePublished', () => {
    const ext = require('../lib/extension.js')
    const handlers = {}
    const fake = {
      on (event, fn) { handlers[event] = fn },
      getLogger () { return { warn () {}, info () {} } },
    }
    ext.register.call(fake, { config: {} })
    assert.equal(typeof handlers.sitePublished, 'function')
  })

  it('core exports groupings and triage actions used by extension', () => {
    const core = require('@antora-supplemental/asciidoc-link-validator')
    assert.equal(typeof core.buildGroupings, 'function')
    assert.equal(typeof core.normalizeCiTrigger, 'function')
    assert.equal(typeof core.buildTriageHtml, 'function')
    const html = core.buildTriageHtml({
      ciTrigger: { enabled: true, dispatchUrl: 'https://proxy.example/dispatch' },
    })
    assert.match(html, /lv-group-by/)
    assert.match(html, /lv-ci-trigger/)
  })

  it('ui assets exist', () => {
    const fs = require('node:fs')
    const ospath = require('node:path')
    assert.ok(fs.existsSync(ospath.join(__dirname, '..', 'ui', 'js', 'link-validator.js')))
    assert.ok(fs.existsSync(ospath.join(__dirname, '..', 'ui', 'css', 'link-validator.css')))
    const js = fs.readFileSync(ospath.join(__dirname, '..', 'ui', 'js', 'link-validator.js'), 'utf8')
    assert.match(js, /encodeMailto/)
    assert.match(js, /triggerCi/)
    assert.match(js, /activeGroupingKey/)
  })
  it('exports registryMeta and core buildReportHistory', () => {
    const ext = require('../lib/extension.js')
    assert.ok(ext.registryMeta)
    assert.equal(ext.registryMeta.purpose, 'link-validation')
    const core = require('@antora-supplemental/asciidoc-link-validator')
    assert.equal(typeof core.buildReportHistory, 'function')
  })
})
