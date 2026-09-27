;(function () {
  'use strict'

  var reportUrl = window.LINK_VALIDATOR_REPORT_URL || './report.json'
  var reportEmail = window.LINK_VALIDATOR_REPORT_EMAIL || 'support@devcentr.org'
  var report = null
  var filterCurrentPage = false
  var newlyOnly = false

  function $(id) { return document.getElementById(id) }

  function currentPagePath () {
    try {
      var u = new URL(window.location.href)
      return u.pathname
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

  function renderSummary () {
    var el = $('lv-summary')
    if (!el || !report) return
    var s = report.summary || {}
    el.innerHTML =
      '<ul class="lv-summary-list">' +
      '<li>Checked: <strong>' + (s.checked || 0) + '</strong></li>' +
      '<li>OK: <strong>' + (s.ok || 0) + '</strong></li>' +
      '<li>Invalid: <strong>' + (s.invalid || 0) + '</strong></li>' +
      '<li>Newly invalid: <strong>' + (s.newlyInvalid || 0) + '</strong></li>' +
      '<li>Recovered: <strong>' + (s.recovered || 0) + '</strong></li>' +
      '</ul>'
  }

  function renderTable () {
    var tbody = $('lv-tbody')
    if (!tbody) return
    tbody.innerHTML = ''
    var rows = rowsToShow()
    if (!rows.length) {
      var tr = document.createElement('tr')
      tr.innerHTML = '<td colspan="5">No matching invalid links.</td>'
      tbody.appendChild(tr)
      return
    }
    rows.forEach(function (r) {
      var tr = document.createElement('tr')
      var delta = deltaLabel(r.url)
      tr.innerHTML =
        '<td><a href="' + escapeAttr(r.url) + '" rel="noopener noreferrer">' + escapeHtml(r.url) + '</a></td>' +
        '<td>' + escapeHtml(r.status == null ? '—' : String(r.status)) + '</td>' +
        '<td><span class="lv-badge lv-badge-' + escapeAttr(r.classification || 'other') + '">' +
          escapeHtml(r.classification || 'other') + '</span></td>' +
        '<td>' + escapeHtml((r.sources || []).join(', ') || '—') + '</td>' +
        '<td>' + escapeHtml(delta || '—') + '</td>'
      tbody.appendChild(tr)
    })
  }

  function escapeHtml (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  function escapeAttr (s) {
    return escapeHtml(s).replace(/"/g, '&quot;')
  }

  function buildMailto () {
    if (!report) return 'mailto:' + reportEmail
    var s = report.summary || {}
    var subject = encodeURIComponent('Link Validator — ' + (s.invalid || 0) + ' invalid link(s)')
    var lines = ['Link Validator report', 'Invalid: ' + (s.invalid || 0), '']
    ;(report.invalid || []).slice(0, 50).forEach(function (r) {
      lines.push('- ' + r.url + ' => ' + r.classification)
    })
    var body = encodeURIComponent(lines.join('\n'))
    return 'mailto:' + (report.meta && report.meta.reportEmail || reportEmail) +
      '?subject=' + subject + '&body=' + body
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

  function bind () {
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
    var mail = $('lv-mailto')
    if (mail) mail.setAttribute('href', buildMailto())
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
        renderSummary()
        renderTable()
        var mail = $('lv-mailto')
        if (mail) mail.setAttribute('href', buildMailto())
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
