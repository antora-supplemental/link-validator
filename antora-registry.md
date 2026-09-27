---
name: "Link Validator"
description: "Antora extension: validate outbound http(s) links, triage page, WARN logs. Core CLI in asciidoc-link-validator."
purpose: "link-validation"
layer: "bolt-on"
chassis: "bolt-on"
pipeline: true
asciidoctor: false
lifecycleHooks:
  - sitePublished
processorSubtypes: []
related:
  - https://github.com/antora-supplemental/asciidoc-link-validator
---

# Overview

Registers on `sitePublished`, checks outbound links via `@antora-supplemental/asciidoc-link-validator`, and publishes `link-validator/report.json` plus a triage UI with groupings and shared triage actions (CI trigger + mailto + copy).

## Install

```bash
pnpm add -D github:antora-supplemental/link-validator#main
```

## Playbook

```yaml
antora:
  extensions:
    - require: '@antora-supplemental/link-validator'
      reportEmail: support@devcentr.org
      ciTrigger:
        enabled: true
        provider: github
        dispatchUrl: https://example.com/link-validator-proxy/dispatch
        statusUrl: https://example.com/link-validator-proxy/status
```

## Registry metadata

| Field | Value |
| --- | --- |
| purpose | link-validation |
| layer / chassis | bolt-on |
| pipeline vs asciidoctor | pipeline (`sitePublished`) |
| processor subtypes | n/a |

## Related

* https://github.com/antora-supplemental/asciidoc-link-validator
