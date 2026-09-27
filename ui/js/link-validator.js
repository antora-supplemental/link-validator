;(function () {
  'use strict'

  var cfg = window.LINK_VALIDATOR_CONFIG || {}
  var reportUrl = cfg.reportUrl || window.LINK_VALIDATOR_REPORT_URL || './report.json'
  var reportEmail = cfg.reportEmail || window.LINK_VALIDATOR_REPORT_EMAIL || 'support@devcentr.org'
  var ciTrigger = cfg.ciTrigger || { enabled: false }
  var report = null
  var filterCurrentPage = false
  var newlyOnly = false
  var groupMode = 'auto'
  var pollTimer = null

  function $(id) { return document.getElementById(id) }

  function currentPagePath () {
    try {
      return new URL(window.location.href).pathname
    } catch (_) {
      return window.location.pathname || ''
    }
  }

  function deltaLabel (url) {
    if (!report) return ''
    if ((report.newlyInvalid || []).some(function (r) { return r.url === url })) return 'newly'
    if ((report.stillInvalid || []).some(function (r) { return r.url === url })) return 'still'
    if ((report.recovered || []).some(function (r) { return r.url === url })) return 'recovered'
    return ''
  }

  function rowsToShow () {
    if (!report) return []
    var rows = report.invalid || []
    if (newlyOnly) rows = report.newlyInvalid || []
    if (filterCurrentPage) {
      var page = currentPagePath()
      rows = rows.filter(function (r) {
        return (r.sources || []).some(function (s) {
          return s === page || page.endsWith(s) || s.endsWith(page.replace(/^\//, ''))
        })
      })
    }
    return rows
  }

  function activeGroupingKey () {
    if (groupMode === 'auto') {
      return (report && report.groupings && report.groupings.default) || 'bySourcePage'
    }
    return groupMode
  }

  function encodeMailto (rep) {
    var email = (rep.meta && rep.meta.reportEmail) || reportEmail
    var s = rep.summary || {}
    var subject = encodeURIComponent('Link Validator — ' + (s.invalid || 0) + ' invalid link(s)')
    var lines = [
      'Link Validator report (' + (rep.generatedAt || '') + ')',
      '',
      'Checked: ' + (s.checked || 0),
      'OK: ' + (s.ok || 0),
      'Invalid: ' + (s.invalid || 0),
      'Newly invalid: ' + (s.newlyInvalid || 0),
      'Still invalid: ' + (s.stillInvalid || 0),
      'Recovered: ' + (s.recovered || 0),
      'Default grouping: ' + (s.groupingDefault || (rep.groupings && rep.groupings.default) || ''),
      '',
      'Invalid links:'
    ]
    ;(rep.invalid || []).slice(0, 80).forEach(function (r) {
      var src = (r.sources && r.sources.length) ? ' [' + r.sources.join('; ') + ']' : ''
      lines.push('  - ' + r.url + ' => ' + r.classification +
        (r.status != null ? ' (' + r.status + ')' : '') + src)
    })
    var body = encodeURIComponent(lines.join('\n'))
    return 'mailto:' + email + '?subject=' + subject + '&body=' + body
  }

  function renderSummary () {
    var el = $('lv-summary')
    if (!el || !report) return
    var s = report.summary || {}
    var def = s.groupingDefault || (report.groupings && report.groupings.default) || 'bySourcePage'
    el.innerHTML =
      '<ul class="lv-summary-list">' +
      '<li>Checked: <strong>' + (s.checked || 0) + '</strong></li>' +
      '<li>OK: <strong>' + (s.ok || 0) + '</strong></li>' +
      '<li>Invalid: <strong>' + (s.invalid || 0) + '</strong></li>' +
      '<li>Newly invalid: <strong>' + (s.newlyInvalid || 0) + '</strong></li>' +
      '<li>Recovered: <strong>' + (s.recovered || 0) + '</strong></li>' +
      '<li>Default group: <strong>' + escapeHtml(def) + '</strong></li>' +
      '</ul>'
  }

  function rowHtml (r) {
    var delta = deltaLabel(r.url)
    return '<tr>' +
      '<td><a href="' + escapeAttr(r.url) + '" rel="noopener noreferrer">' + escapeHtml(r.url) + '</a></td>' +
      '<td>' + escapeHtml(r.status == null ? '—' : String(r.status)) + '</td>' +
      '<td><span class="lv-badge lv-badge-' + escapeAttr(r.classification || 'other') + '">' +
        escapeHtml(r.classification || 'other') + '</span></td>' +
      '<td>' + escapeHtml((r.sources || []).join(', ') || '—') + '</td>' +
      '<td>' + escapeHtml(delta || '—') + '</td>' +
      '</tr>'
  }

  function renderFlat (rows) {
    var table = $('lv-table')
    var tbody = $('lv-tbody')
    var groups = $('lv-groups')
    if (groups) { groups.innerHTML = ''; groups.hidden = true }
    if (table) table.hidden = false
    if (!tbody) return
    tbody.innerHTML = ''
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5">No matching invalid links.</td></tr>'
      return
    }
    rows.forEach(function (r) {
      tbody.insertAdjacentHTML('beforeend', rowHtml(r))
    })
  }

  function renderGrouped (rows) {
    var table = $('lv-table')
    var groupsEl = $('lv-groups')
    if (table) table.hidden = true
    if (!groupsEl) return renderFlat(rows)
    groupsEl.hidden = false
    groupsEl.innerHTML = ''

    var key = activeGroupingKey()
    var groups = null
    if (report.groupings && report.groupings[key] && groupMode !== 'flat' && !filterCurrentPage && !newlyOnly) {
      groups = report.groupings[key]
      // When filters active, rebuild from filtered rows is safer — fall through below if filters on
    }
    if (filterCurrentPage || newlyOnly || !groups) {
      // rebuild lightweight groups from filtered rows
      groups = rebuildGroups(rows, key === 'flat' ? 'byDestination' : key)
    }
    if (groupMode === 'flat') return renderFlat(rows)

    if (!groups.length) {
      groupsEl.innerHTML = '<p class="lv-empty">No matching invalid links.</p>'
      return
    }
    groups.forEach(function (g) {
      var details = document.createElement('details')
      details.className = 'lv-group'
      details.open = groups.length <= 8
      var summary = document.createElement('summary')
      summary.innerHTML = '<span class="lv-group-label">' + escapeHtml(g.label || g.key) +
        '</span> <span class="lv-group-count">' + g.count + '</span>'
      details.appendChild(summary)
      var table = document.createElement('table')
      table.className = 'lv-table lv-table-nested'
      table.innerHTML = '<thead><tr><th>URL</th><th>Status</th><th>Classification</th><th>Source page</th><th>Delta</th></tr></thead>'
      var tb = document.createElement('tbody')
      ;(g.items || []).forEach(function (r) {
        // if filters, items may be full report items — re-filter
        if (filterCurrentPage || newlyOnly) {
          if (!rows.some(function (x) { return x.url === r.url })) return
        }
        tb.insertAdjacentHTML('beforeend', rowHtml(r))
      })
      table.appendChild(tb)
      details.appendChild(table)
      groupsEl.appendChild(details)
    })
  }

  function rebuildGroups (rows, key) {
    var map = {}
    function add (k, item) {
      if (!map[k]) map[k] = { key: k, label: k, count: 0, items: [] }
      map[k].items.push(item)
      map[k].count++
    }
    rows.forEach(function (r) {
      if (key === 'bySourcePage') {
        var sources = (r.sources && r.sources.length) ? r.sources : ['(unknown)']
        sources.forEach(function (s) { add(s, r) })
      } else if (key === 'byStatus') {
        add(r.classification || 'other', r)
      } else if (key === 'byHost') {
        try { add(new URL(r.url).hostname.toLowerCase(), r) } catch (_) { add('(invalid-url)', r) }
      } else {
        add(r.url, r)
      }
    })
    return Object.keys(map).map(function (k) { return map[k] })
      .sort(function (a, b) { return b.count - a.count || a.key.localeCompare(b.key) })
  }

  function renderTable () {
    var rows = rowsToShow()
    if (groupMode === 'flat') renderFlat(rows)
    else renderGrouped(rows)
  }

  function escapeHtml (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  function escapeAttr (s) {
    return escapeHtml(s).replace(/"/g, '&quot;')
  }

  function copyReport () {
    if (!report) return
    var text = JSON.stringify(report, null, 2)
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
    } else {
      var ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch (_) {}
      document.body.removeChild(ta)
    }
  }

  function setCiStatus (msg, isError) {
    var el = $('lv-ci-status')
    if (!el) return
    el.textContent = msg || ''
    el.classList.toggle('lv-ci-error', !!isError)
  }

  function triggerCi () {
    if (!ciTrigger || !ciTrigger.enabled || !ciTrigger.dispatchUrl) {
      setCiStatus('CI trigger not configured (need public dispatchUrl / proxy).', true)
      return
    }
    var btn = $('lv-ci-trigger')
    if (btn) btn.disabled = true
    setCiStatus('Dispatching…')
    fetch(ciTrigger.dispatchUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ ref: ciTrigger.ref || 'main', event: 'link-validator-check' }),
      credentials: 'omit',
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      setCiStatus('Dispatched. Polling for updated report…')
      startPoll()
    }).catch(function (err) {
      setCiStatus('Dispatch failed: ' + err.message + ' — use Email report as fallback.', true)
      if (btn) btn.disabled = false
    })
  }

  function startPoll () {
    if (pollTimer) clearInterval(pollTimer)
    var started = Date.now()
    var interval = (ciTrigger && ciTrigger.pollIntervalMs) || 5000
    var prior = report && report.generatedAt
    pollTimer = setInterval(function () {
      if (Date.now() - started > 5 * 60 * 1000) {
        clearInterval(pollTimer)
        setCiStatus('Timed out waiting for new report. Try Email report.', true)
        var btn = $('lv-ci-trigger')
        if (btn) btn.disabled = false
        return
      }
      var url = (ciTrigger && ciTrigger.statusUrl) || reportUrl
      fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now(), { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
        .then(function (data) {
          if (data && data.generatedAt && data.generatedAt !== prior) {
            clearInterval(pollTimer)
            report = data
            if (data.meta && data.meta.reportEmail) reportEmail = data.meta.reportEmail
            if (data.meta && data.meta.ciTrigger) ciTrigger = data.meta.ciTrigger
            renderSummary()
            renderTable()
            renderHistory()
            var mail = $('lv-mailto')
            if (mail) mail.setAttribute('href', encodeMailto(report))
            setCiStatus('New report loaded (' + data.generatedAt + ').')
            var btn = $('lv-ci-trigger')
            if (btn) btn.disabled = false
          }
        })
        .catch(function () { /* keep polling */ })
    }, interval)
  }

  function renderHistory () {
    var el = $('lv-history')
    if (!el) return
    var hist = (report && report.meta && report.meta.reportHistory) || []
    if (!hist.length) { el.hidden = true; el.innerHTML = ''; return }
    el.hidden = false
    el.innerHTML = '<h2 class="lv-history-title">Prior reports</h2><ul class="lv-history-list">' +
      hist.map(function (h) {
        return '<li><a href="' + escapeAttr(h.href || h.url || '#') + '">' +
          escapeHtml(h.label || h.generatedAt || h.href) + '</a>' +
          (h.invalid != null ? ' — ' + h.invalid + ' invalid' : '') + '</li>'
      }).join('') + '</ul>'
  }

  function bind () {
    var sel = $('lv-group-by')
    if (sel) {
      sel.addEventListener('change', function () {
        groupMode = sel.value || 'auto'
        renderTable()
      })
    }
    var btnPage = $('lv-filter-page')
    if (btnPage) {
      btnPage.addEventListener('click', function () {
        filterCurrentPage = !filterCurrentPage
        btnPage.classList.toggle('lv-btn-active', filterCurrentPage)
        btnPage.textContent = filterCurrentPage ? 'Showing this page' : 'Validate this page'
        renderTable()
      })
    }
    var tog = $('lv-newly-only')
    if (tog) {
      tog.addEventListener('change', function () {
        newlyOnly = !!tog.checked
        renderTable()
      })
    }
    var copy = $('lv-copy')
    if (copy) copy.addEventListener('click', copyReport)
    var ci = $('lv-ci-trigger')
    if (ci) ci.addEventListener('click', triggerCi)
  }

  function load () {
    fetch(reportUrl, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (data) {
        report = data
        if (data.meta && data.meta.reportEmail) reportEmail = data.meta.reportEmail
        if (data.meta && data.meta.ciTrigger) {
          ciTrigger = data.meta.ciTrigger
        }
        renderSummary()
        renderTable()
        renderHistory()
        var mail = $('lv-mailto')
        if (mail) mail.setAttribute('href', encodeMailto(report))
      })
      .catch(function (err) {
        var el = $('lv-summary')
        if (el) el.textContent = 'Failed to load report: ' + err.message
      })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bind(); load() })
  } else {
    bind(); load()
  }
})()
