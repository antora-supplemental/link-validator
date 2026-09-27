'use strict'

/** Self-register metadata for extension-lister / antora-supplemental registry. */
module.exports = {
  name: 'Link Validator',
  packageName: '@antora-supplemental/link-validator',
  purpose: 'link-validation',
  layer: 'bolt-on',
  chassis: 'bolt-on',
  pipeline: true,
  asciidoctor: false,
  lifecycleHooks: ['sitePublished'],
  processorSubtypes: [],
  description: 'Antora extension: validate outbound http(s) links, triage page, WARN logs',
  homepage: 'https://github.com/antora-supplemental/link-validator',
  related: ['https://github.com/antora-supplemental/asciidoc-link-validator'],
}
