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
})
