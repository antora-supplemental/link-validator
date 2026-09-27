'use strict'

/**
 * Preface + throttled progress for long-running validators/scanners.
 *
 * Pattern (tool id always prefixes):
 *   tool-id: starting …
 *   tool-id: checking 0 files…     // animates N during enumeration
 *   tool-id: checking 42 files…    // frozen when enum ends
 *   tool-id: checked 25/128        // work progress
 *
 * Env-aware output:
 *   TTY (process.stderr.isTTY && CI not set): \r in-place animate N + spinner progress
 *   non-TTY or CI=true (or Antora logger): discrete throttled lines only (~every 5% / every N)
 *
 * Antora may buffer logger output until a hook returns; register early and log
 * immediately at hook entry so the preface still appears before later stages.
 */

function detectTTY (stream, isTTY) {
  if (isTTY != null) return Boolean(isTTY)
  const ci = String(process.env.CI || '').toLowerCase()
  if (ci && ci !== '0' && ci !== 'false') return false
  return Boolean(stream && stream.isTTY)
}

function createProgress ({
  id,
  stream = process.stderr,
  isTTY, // optional override; default = detectTTY(stream)
  every = 25,
  everyPct = 5,
  logger = null,
} = {}) {
  if (!id) throw new Error('createProgress: id is required')
  const useLogger = logger && typeof logger.info === 'function'
  // Antora logger path never uses \r; CI/non-TTY likewise.
  const tty = !useLogger && detectTTY(stream, isTTY)
  let lastPctBucket = -1
  let lastCount = 0
  let spinning = false
  let enumNoun = 'files'
  let enumExtra = null
  let enumCount = 0
  let enumFrozen = false
  let lastEnumEmitted = -1

  function clearSpin () {
    if (spinning && tty) {
      stream.write('\r\x1b[K')
      spinning = false
    }
  }

  function writeLine (msg) {
    clearSpin()
    const line = id + ': ' + msg
    if (useLogger) logger.info(line)
    else stream.write(line + '\n')
  }

  function enumMessage (n) {
    let msg = 'checking ' + n + ' ' + enumNoun
    if (enumExtra) msg += ' (' + enumExtra + ')'
    return msg + '…'
  }

  function starting (what) {
    writeLine(what || 'starting')
  }

  function enumStart (noun = 'files', extra = null) {
    enumNoun = noun
    enumExtra = extra
    enumCount = 0
    enumFrozen = false
    lastEnumEmitted = -1
    lastCount = 0
    lastPctBucket = -1
    if (tty) {
      stream.write('\r' + id + ': ' + enumMessage(0))
      spinning = true
    } else {
      writeLine(enumMessage(0))
      lastEnumEmitted = 0
    }
  }

  function enumTick (n) {
    if (enumFrozen) return
    enumCount = n
    if (tty) {
      stream.write('\r\x1b[K' + id + ': ' + enumMessage(n))
      spinning = true
      return
    }
    if (n === 0) return
    if (n - lastEnumEmitted >= every || n === 1) {
      lastEnumEmitted = n
      writeLine(enumMessage(n))
    }
  }

  function enumDone (finalN, extra) {
    if (finalN != null) enumCount = finalN
    if (extra != null) enumExtra = extra
    enumFrozen = true
    if (tty) {
      stream.write('\r\x1b[K' + id + ': ' + enumMessage(enumCount) + '\n')
      spinning = false
    } else {
      writeLine(enumMessage(enumCount))
    }
    lastEnumEmitted = enumCount
  }

  function checking (n, noun, extra) {
    enumNoun = noun || 'files'
    enumExtra = extra || null
    enumCount = n
    enumFrozen = true
    writeLine(enumMessage(n))
  }

  function shouldEmit (done, total) {
    if (done >= total) return true
    if (done - lastCount >= every) return true
    if (!total) return false
    const pct = Math.floor((done / total) * 100)
    const bucket = Math.floor(pct / everyPct) * everyPct
    return bucket > lastPctBucket && bucket > 0
  }

  function markEmitted (done, total) {
    lastCount = done
    lastPctBucket = total ? Math.floor((done / total) * 100 / everyPct) * everyPct : 100
  }

  function tick (done, total, detail) {
    if (total == null || total < 0) return
    const suffix = detail ? ' ' + detail : ''
    if (tty) {
      const spinner = '|/-\\'[done % 4]
      stream.write('\r' + id + ': ' + spinner + ' checked ' + done + '/' + total + suffix)
      spinning = true
      if (done >= total) {
        stream.write('\n')
        spinning = false
        markEmitted(done, total)
      }
      return
    }
    if (shouldEmit(done, total)) {
      markEmitted(done, total)
      writeLine('checked ' + done + '/' + total + suffix)
    }
  }

  function done (summary) {
    clearSpin()
    if (summary) writeLine(summary)
  }

  return {
    starting,
    checking,
    enumStart,
    enumTick,
    enumDone,
    tick,
    done,
    writeLine,
    id,
    /** @internal exposed for tests */
    _tty: tty,
  }
}

module.exports = { createProgress, detectTTY }
