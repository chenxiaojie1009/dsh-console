/**
 * In-memory device-console state.
 *
 * One ring-buffered transcript (commands, notes, device output, system lines),
 * the active connection session, the shared pause flag, and the pending SSH
 * connect request. No external dependencies: this module can be imported and
 * exercised on its own.
 */

/** ANSI escape sequences (CSI, OSC, and two-byte escapes). */
const ANSI_PATTERN =
  /(?:\u001b\[[0-?]*[ -/]*[@-~])|(?:\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\))|(?:\u001b[@-Z\\-_])/g

/** Remaining C0 control characters that a transcript should not carry. */
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/**
 * Strip ANSI escape sequences from device output.
 * @param {string} text raw text.
 * @returns {string} text without escape sequences.
 */
export function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '')
}

/**
 * Strip control characters that would corrupt a browser transcript.
 * @param {string} text text to clean.
 * @returns {string} cleaned text (newlines and tabs preserved).
 */
export function stripControl(text) {
  return text.replace(CONTROL_PATTERN, '')
}

/**
 * Clean device output for display and for the agent.
 * @param {string} text raw text.
 * @returns {string} cleaned text.
 */
export function clean(text) {
  return stripControl(stripAnsi(text))
}

/**
 * Sleep helper.
 * @param {number} ms milliseconds.
 * @returns {Promise<void>} resolves after the delay.
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

/** Upper bound on one command's returned output. */
export const MAX_COMMAND_OUTPUT = 200_000

/**
 * Cap a string, marking the cut.
 * @param {string} text text to cap.
 * @param {number} max maximum characters.
 * @returns {string} capped text.
 */
export function capText(text, max = MAX_COMMAND_OUTPUT) {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n…[输出超过 ${max} 字符，已截断]`
}

/**
 * The console hub: connection session, transcript, pause flag, pending request.
 *
 * Entries are plain JSON objects `{ seq, time, kind, text, note? }` where
 * `kind` is one of `command`, `output`, `system`, `error`.
 */
export class ConsoleHub {
  /**
   * @param {object} [options] buffer limits.
   * @param {number} [options.maxEntries] maximum retained entries.
   * @param {number} [options.maxChars] maximum retained characters.
   * @param {number} [options.flushMs] output coalescing window.
   */
  constructor(options = {}) {
    this.maxEntries = options.maxEntries ?? 4000
    this.maxChars = options.maxChars ?? 2_000_000
    this.flushMs = options.flushMs ?? 120

    /** @type {Array<{seq:number,time:number,kind:string,text:string,note?:string}>} */
    this.entries = []
    /** Monotonic entry sequence. */
    this.seq = 0
    /** Monotonic count of committed device-output entries (never reset). */
    this.outputSeq = 0
    /** Active connection session, or null. */
    this.session = null
    /** Shared pause flag: set by the panel, observed by the agent tools. */
    this.paused = false
    /** Pending SSH connect request shown in the panel, or null. */
    this.pending = null
    /** When true, agent-proposed commands wait in the panel for the user's execute click. */
    this.confirmMode = true
    /** Commands proposed by the agent and waiting for user confirmation. */
    this.pendingExecs = []
    /** Monotonic id seed for pending commands. */
    this.pendingSeed = 0
    /** Last time device output arrived (ms). */
    this.lastOutputAt = 0
    /** Session id of the agent that last drove the console. */
    this.lastAgentSessionId = null

    this.chars = 0
    this.pendingText = ''
    this.flushTimer = null
    this.listeners = new Set()
  }

  /**
   * Subscribe to state changes.
   * @param {() => void} listener callback.
   * @returns {() => void} unsubscribe.
   */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Notify subscribers. */
  notify() {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A failed listener must not break the console.
      }
    }
  }

  /**
   * Append one transcript entry immediately (flushing buffered output first).
   * @param {{kind:string,text:string,note?:string}} entry entry fields.
   * @returns {{seq:number,time:number,kind:string,text:string,note?:string}} stored entry.
   */
  append(entry) {
    this.flushOutput()
    return this.push(entry)
  }

  /**
   * Append a command line with its annotation.
   * @param {string} command the command text shown in the panel.
   * @param {string} [note] Chinese annotation explaining the command.
   * @returns {object} stored entry.
   */
  appendCommand(command, note) {
    const entry = { kind: 'command', text: String(command), note: note === undefined ? undefined : String(note) }
    return this.append(entry)
  }

  /**
   * Append a system line (connection notices, pause notices).
   * @param {string} text message.
   * @param {'info'|'error'} [level] level; error renders red.
   * @returns {object} stored entry.
   */
  appendSystem(text, level = 'info') {
    return this.append({ kind: level === 'error' ? 'error' : 'system', text: String(text) })
  }

  /**
   * Append a Chinese explanation of a command's output, shown under it in the
   * panel. Never sent to the device and never counted as command output.
   * @param {string} text explanation.
   * @returns {object} stored entry.
   */
  appendNote(text) {
    return this.append({ kind: 'note', text: String(text) })
  }

  /**
   * Buffer device output; it flushes as one entry after the coalescing window.
   * @param {string} text cleaned output text.
   */
  appendOutput(text) {
    if (text === '') return
    this.lastOutputAt = Date.now()
    this.pendingText += text
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushOutput()
    }, this.flushMs)
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref()
  }

  /** Flush buffered output as one transcript entry. */
  flushOutput() {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const text = this.pendingText
    this.pendingText = ''
    if (text === '') return
    this.push({ kind: 'output', text })
  }

  /**
   * Push one entry, trim the buffer, and notify.
   * @param {{kind:string,text:string,note?:string}} entry entry fields.
   * @returns {object} stored entry.
   */
  push(entry) {
    this.seq += 1
    const stored = {
      seq: this.seq,
      time: Date.now(),
      kind: entry.kind,
      text: entry.text,
    }
    if (entry.note !== undefined && entry.note !== '') stored.note = entry.note
    if (entry.kind === 'output') this.outputSeq += 1
    this.entries.push(stored)
    this.chars += stored.text.length
    this.trim()
    this.notify()
    return stored
  }

  /** Drop the oldest entries until both limits hold. */
  trim() {
    while (
      this.entries.length > 1 &&
      (this.entries.length > this.maxEntries || this.chars > this.maxChars)
    ) {
      const dropped = this.entries.shift()
      this.chars -= dropped.text.length
    }
  }

  /** Sequence of the first retained entry (0 when empty). */
  get firstSeq() {
    return this.entries.length === 0 ? 0 : this.entries[0].seq
  }

  /**
   * Entries committed after `seq`.
   * @param {number} seq last sequence the caller already holds.
   * @returns {Array<object>} newer entries.
   */
  since(seq) {
    const from = Number(seq)
    if (!Number.isFinite(from) || from <= 0) return this.entries.slice()
    return this.entries.filter(entry => entry.seq > from)
  }

  /**
   * Concatenated output text committed after `seq`.
   * @param {number} seq start sequence (exclusive).
   * @returns {string} output text.
   */
  textSince(seq) {
    let text = ''
    for (const entry of this.entries) {
      if (entry.seq <= seq) continue
      if (entry.kind === 'output') text += entry.text
    }
    if (this.pendingText !== '') text += this.pendingText
    return text
  }

  /**
   * The newest entries, for status snapshots.
   * @param {number} count entry count.
   * @returns {Array<object>} newest entries in chronological order.
   */
  tail(count = 20) {
    return this.entries.slice(-Math.max(0, count))
  }

  /**
   * Render a set of entries as a plain-text transcript for the agent.
   * @param {Array<{kind:string,text:string,note?:string}>} entries entries.
   * @returns {string} plain-text transcript.
   */
  renderEntries(entries) {
    const lines = []
    for (const entry of entries) {
      if (entry.kind === 'command') {
        lines.push('$ ' + entry.text + (entry.note ? '   // ' + entry.note : ''))
      } else if (entry.kind === 'output') {
        lines.push(entry.text.replace(/\r\n/g, '\n').replace(/\n+$/, ''))
      } else if (entry.kind === 'note') {
        lines.push('[输出解读] ' + entry.text)
      } else if (entry.kind === 'requirement') {
        lines.push('[用户需求] ' + entry.text)
      } else if (entry.kind === 'suggestion') {
        lines.push('[建议] ' + entry.text)
      } else {
        lines.push((entry.kind === 'error' ? '[错误] ' : '[系统] ') + entry.text)
      }
    }
    return lines.join('\n').trim()
  }

  /**
   * Rendered recent transcript for the agent (commands with notes, output and
   * output explanations).
   * @param {number} count entry count.
   * @returns {string} plain-text transcript.
   */
  renderTail(count = 20) {
    return this.renderEntries(this.tail(count))
  }

  /**
   * Replace the connection session.
   * @param {object} session `{kind,label,meta,connectedAt?}`.
   */
  setSession(session) {
    this.session = {
      kind: session.kind,
      label: session.label,
      meta: session.meta ?? {},
      status: session.status ?? 'connected',
      connectedAt: session.connectedAt ?? Date.now(),
    }
    this.notify()
  }

  /**
   * Clear the connection session.
   * @param {string} [reason] system line appended after clearing.
   */
  clearSession(reason) {
    const wasConnected = this.session !== null
    this.session = null
    if (wasConnected && reason) this.appendSystem(reason)
    this.notify()
  }

  /**
   * Set the pause flag.
   * @param {boolean} paused new value.
   * @param {string} [reason] system line.
   */
  setPaused(paused, reason) {
    this.paused = Boolean(paused)
    if (reason) this.appendSystem(reason)
    this.notify()
  }

  /**
   * Set or clear the pending SSH request.
   * @param {object|null} pending pending request.
   */
  setPending(pending) {
    this.pending = pending
    this.notify()
  }

  /**
   * Turn the "confirm before the command is sent" gate on or off.
   * @param {boolean} enabled new value.
   * @param {string} [reason] system line.
   */
  setConfirmMode(enabled, reason) {
    this.confirmMode = Boolean(enabled)
    if (reason) this.appendSystem(reason)
    this.notify()
  }

  /**
   * Queue a command proposed by the agent until the user confirms it.
   * @param {{command:string,note:string,waitMs?:number,idleMs?:number,lineEnding?:string}} proposal proposal.
   * @returns {object} stored pending command.
   */
  addPendingExec(proposal) {
    this.pendingSeed += 1
    const pending = {
      id: `exe-${this.pendingSeed}-${Date.now().toString(36)}`,
      command: String(proposal.command ?? ''),
      note: proposal.note === undefined ? '' : String(proposal.note),
      waitMs: proposal.waitMs,
      idleMs: proposal.idleMs,
      lineEnding: proposal.lineEnding,
      createdAt: Date.now(),
    }
    this.pendingExecs.push(pending)
    if (this.pendingExecs.length > 5) this.pendingExecs.splice(0, this.pendingExecs.length - 5)
    this.notify()
    return pending
  }

  /**
   * Remove one pending command.
   * @param {string} id pending id.
   * @returns {object|null} the removed command, or null.
   */
  removePendingExec(id) {
    const index = this.pendingExecs.findIndex(item => item.id === id)
    if (index < 0) return null
    const [removed] = this.pendingExecs.splice(index, 1)
    this.notify()
    return removed
  }

  /**
   * Append the user's natural-language requirement to the transcript.
   * @param {string} text requirement.
   * @returns {object} stored entry.
   */
  appendRequirement(text) {
    return this.append({ kind: 'requirement', text: String(text) })
  }

  /**
   * Append a model-generated suggestion summary (the brief reason behind the
   * proposed commands).
   * @param {string} text suggestion text.
   * @returns {object} stored entry.
   */
  appendSuggestion(text) {
    return this.append({ kind: 'suggestion', text: String(text) })
  }

  /** Empty the transcript. */
  clear() {
    this.flushOutput()
    this.entries = []
    this.chars = 0
    this.notify()
  }

  /**
   * Wait for a predicate with a timeout and cancellation.
   * @param {() => boolean} predicate condition.
   * @param {object} [options] wait options.
   * @param {number} [options.timeoutMs] maximum wait.
   * @param {AbortSignal} [options.signal] cancellation.
   * @param {number} [options.pollMs] poll interval.
   * @returns {Promise<boolean>} true when the predicate became true.
   */
  async waitUntil(predicate, options = {}) {
    const timeoutMs = options.timeoutMs ?? 60_000
    const pollMs = options.pollMs ?? 100
    const signal = options.signal
    const deadline = Date.now() + Math.max(0, timeoutMs)
    while (Date.now() < deadline) {
      if (signal !== undefined && signal.aborted) return false
      try {
        if (predicate()) return true
      } catch {
        return false
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())))
    }
    return false
  }

  /** Release timers. */
  dispose() {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.listeners.clear()
  }
}

/**
 * Snapshot of the console state for the panel/agent.
 * @param {ConsoleHub} hub the hub.
 * @param {object} [extra] extra fields (ports, hosts).
 * @returns {object} JSON-safe snapshot.
 */
export function snapshot(hub, extra = {}) {
  return {
    session: hub.session,
    paused: hub.paused,
    pending: hub.pending,
    confirmMode: hub.confirmMode,
    pendingExecs: hub.pendingExecs,
    firstSeq: hub.firstSeq,
    lastSeq: hub.seq,
    lastOutputAt: hub.lastOutputAt,
    serverTime: Date.now(),
    ...extra,
  }
}
