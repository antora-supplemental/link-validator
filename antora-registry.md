---
name: "Link Validator"
description: "Antora extension: validate outbound http(s) links, triage page, WARN logs. Core CLI in asciidoc-link-validator."
---

# Overview

Registers on `sitePublished`, checks outbound links via `@antora-supplemental/asciidoc-link-validator`, and publishes `link-validator/report.json` plus a triage UI.

## Install

```bash
pnpm add -D @antora-supplemental/link-validator
```

## Playbook

```yaml
antora:
  extensions:
    - '@antora-supplemental/link-validator'
```

## Related

* https://github.com/antora-supplemental/asciidoc-link-validator
