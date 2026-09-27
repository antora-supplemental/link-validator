#!/usr/bin/env node
'use strict'
/** Convert link-validator report.json → minimal JUnit XML for GitLab/CI. */
const fs = require('fs')
const reportPath = process.argv[2] || 'link-report.json'
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
const invalid = report.invalid || []
function escape (s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
const cases = invalid.map((r) => {
  const name = escape((r.url || 'url') + ' [' + (r.classification || '') + ']')
  const msg = escape((r.sources || []).join(', ') || '')
  return '    <testcase classname="link-validator" name="' + name + '"><failure message="' + msg + '">' +
    escape(JSON.stringify(r)) + '</failure></testcase>'
})
const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<testsuite name="link-validator" tests="' + Math.max(invalid.length, 1) + '" failures="' + invalid.length + '">',
  invalid.length ? cases.join('\n') : '    <testcase classname="link-validator" name="no-invalid-links"/>',
  '</testsuite>',
  ''
].join('\n')
process.stdout.write(xml)
