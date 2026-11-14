/**
 * The console engine: one active serial or SSH connection, command execution
 * with idle-based completion, raw input, pause handling, and SSH connect
 * requests that the panel answers with user-typed credentials.
 *
 * One implementation serves both callers (the web panel routes and the agent
 * tools), so the GUI and the model always operate the same connection.
 */
import { StringDecoder } from 'node:string_decoder'
import { readFile } from 'node:fs/promises'
import { ConsoleHub, capText, clean, sleep } from './hub.js'
import { UNKNOWN_VENDOR, detectVendor, listVendors, vendorById, vendorReference } from './vendors.js'
import { SerialConnection, listSerialPorts } from './serial.js'
import { SshConnection } from './ssh.js'
import { listSshHosts, savedPassword } from './ssh-hosts.js'

/** Default serial parameters (switch console ports usually run 9600 8N1). */
const DEFAULT_BAUD = 9600
/** Default command completion window (ms). */
const DEFAULT_WAIT_MS = 8000
/** Default quiet window that marks a command completed (ms). */
const DEFAULT_IDLE_MS = 500
/** Maximum command completion window (ms). */
const MAX_WAIT_MS = 120_000
/** Maximum idle window (ms). */
const MAX_IDLE_MS = 10_000

/** System prompt for turning a panel requirement into commands. */
const SUGGEST_SYSTEM = `你是「设备控制台」里的串口/SSH 命令助手。根据用户需求、当前连接、交换机厂商和最近的终端输出，给出要执行的命令。

只输出一个 JSON 对象，不要任何解释文字，格式：
{"commands":[{"command":"要执行的命令","note":"一句中文注释"}],"message":"可选的一句话说明"}

要求：
1. commands 最多 3 条；命令要小、可验证、只读优先。不确定环境时先给一条探测命令，不要一次给一长串。
2. 安装/删除/重启/配置变更等修改性命令要单独给出，并在 note 里写明会做什么。
3. 不要编造输出；不知道的信息不要假设，用命令去查。
4. note 是一句简短中文，说明这条命令的目的。
5. message 只在 commands 为空或需要提醒用户时填写；有命令时可省略。
6. 交换机场景：已识别厂商时只用该厂商命令语法（华为/H3C 用 display，思科/锐捷/TP-Link 用 show，Juniper 用 show，MikroTik 用 / 斜杠命令），禁止混用其他厂商语法。
7. 交换机需求但厂商未识别时：commands 给空数组，message 写「请先在面板右上角「厂商」选择交换机品牌（或先连接设备回读版本号），再生成命令」。
8. 不涉及交换机的需求（本机、NAS、Linux、Docker 等）正常给命令，不要因为厂商未识别就返回空。
9. 当前未连接设备时：如果必须连上设备才能执行，commands 给空数组，message 提示先连接（串口或 SSH）；如果需求本身是连接/查看状态，则用 message 说明。
10. 需求不适合用命令完成时，commands 给空数组，message 说明原因。`

/** System prompt for explaining one command's output. */
const EXPLAIN_SYSTEM =
  '你是「设备控制台」助手。用一句简洁中文解读下面的命令输出：关键结论、数值含义、异常或下一步提示。不超过 80 字，不要重复命令本身，不要编造输出里没有的内容。'

/**
 * Parse the model's command suggestions.
 *
 * Accepts both the current object form `{ commands, message }` and the older
 * bare array form.
 * @param {string} reply model reply text.
 * @returns {{suggestions:Array<{command:string,note:string}>,message:string}} at most 3 commands plus an optional note.
 */
export function parseSuggestions(reply) {
  const text = String(reply ?? '')
  const objectMatch = text.match(/\{[\s\S]*\}/)
  const arrayMatch = text.match(/\[[\s\S]*\]/)
  let raw
  let message = ''
  if (objectMatch !== null) {
    try {
      const parsed = JSON.parse(objectMatch[0])
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.commands)) {
        raw = parsed.commands
        message = typeof parsed.message === 'string' ? parsed.message.trim().slice(0, 300) : ''
      }
    } catch {
      raw = undefined
    }
  }
  if (raw === undefined && arrayMatch !== null) {
    try {
      const parsed = JSON.parse(arrayMatch[0])
      if (Array.isArray(parsed)) raw = parsed
    } catch {
      raw = undefined
    }
  }
  if (!Array.isArray(raw)) return { suggestions: [], message }
  const result = []
  for (const item of raw) {
    if (result.length >= 3) break
    if (typeof item !== 'object' || item === null) continue
    const command = typeof item.command === 'string' ? item.command.trim() : ''
    const note = typeof item.note === 'string' ? item.note.trim() : ''
    if (command === '') continue
    result.push({ command: command.slice(0, 500), note: note.slice(0, 200) })
  }
  return { suggestions: result, message }
}

/** Line-ending spellings accepted from tools and the panel. */
const LINE_ENDINGS = {
  crlf: '\r\n',
  lf: '\n',
  cr: '\r',
  none: '',
  '': '',
}

/**
 * Turn a line-ending name (or a literal escape spelling) into bytes.
 * @param {unknown} value line-ending option.
 * @param {string} fallback default payload.
 * @returns {string} line ending.
 */
function decodeLineEnding(value, fallback) {
  if (value === undefined || value === null) return fallback
  const text = String(value)
  const named = LINE_ENDINGS[text.toLowerCase()]
  if (named !== undefined) return named
  return unescapeText(text)
}

/**
 * Expand C-style escapes in a string (`\r`, `\n`, `\t`, `\x03`, `\0`, `\\`).
 * @param {string} text input.
 * @returns {string} expanded text.
 */
export function unescapeText(text) {
  return text.replace(/\\(x[0-9a-fA-F]{2}|r|n|t|0|e|\\)/g, (match, escape) => {
    if (escape === 'r') return '\r'
    if (escape === 'n') return '\n'
    if (escape === 't') return '\t'
    if (escape === '0') return '\u0000'
    if (escape === 'e') return '\u001b'
    if (escape === '\\') return '\\'
    if (escape[0] === 'x') return String.fromCharCode(Number.parseInt(escape.slice(1), 16))
    return match
  })
}

/**
 * Printable rendering of a raw payload for the transcript.
 * @param {string} data raw data.
 * @returns {string} escaped display text.
 */
function printable(data) {
  return data
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\u0003/g, 'Ctrl+C')
    .replace(/[\u0000-\u001f\u007f]/g, character => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

/**
 * The console engine.
 */
export class ConsoleEngine {
  /**
   * @param {object} [options] engine options.
   * @param {ConsoleHub} [options.hub] shared hub.
   */
  constructor(options = {}) {
    this.hub = options.hub ?? new ConsoleHub()
    /** @type {SerialConnection|SshConnection|null} */
    this.conn = null
    this.decoder = new StringDecoder('utf8')
    this.portsCache = { at: 0, value: [] }
    this.hostsCache = { at: 0, value: [] }
    this.sshRequestCancelled = false
    /** Called with the last initiating agent session id when the user pauses. */
    this.cancelAgentTurn = () => {}
    /** Model completion used by the panel's requirement/explanation features (wired by index.js). */
    this.complete = async () => ''
    /** Selected or detected switch vendor: { id, source } with source 'auto' | 'manual'. */
    this.vendor = { id: null, source: null }
    /** Throttle timestamp for passive vendor detection. */
    this.vendorScanAt = 0
  }

  /**
   * Remember which agent (session) last operated the console, so the pause
   * button can cancel exactly that running turn.
   * @param {object|undefined} agent agent handle.
   */
  rememberAgent(agent) {
    if (typeof agent === 'object' && agent !== null && typeof agent.id === 'string' && agent.id !== '') {
      this.hub.lastAgentSessionId = agent.id
    }
  }

  /**
   * Serial ports with a short cache.
   * @param {boolean} [force] bypass the cache.
   * @returns {Promise<Array<object>>} port rows.
   */
  async listPorts(force = false) {
    const now = Date.now()
    if (!force && now - this.portsCache.at < 3000) return this.portsCache.value
    const result = await listSerialPorts()
    this.portsCache = { at: now, value: result.ports, error: result.error }
    if (result.error !== undefined) this.portsError = result.error
    else this.portsError = undefined
    return result.ports
  }

  /**
   * SSH hosts the user already configured in DSH, with a short cache.
   * @param {boolean} [force] bypass the cache.
   * @returns {Promise<Array<object>>} host rows.
   */
  async listHosts(force = false) {
    const now = Date.now()
    if (!force && now - this.hostsCache.at < 3000) return this.hostsCache.value
    const hosts = await listSshHosts()
    this.hostsCache = { at: now, value: hosts }
    return hosts
  }

  /** Whether a connection is active. */
  get connected() {
    return this.conn !== null && this.conn.closed !== true
  }

  /**
   * Current status snapshot.
   * @returns {object} JSON-safe status.
   */
  status() {
    return {
      connected: this.connected,
      session: this.hub.session,
      paused: this.hub.paused,
      pending: this.hub.pending,
      lastAgentSessionId: this.hub.lastAgentSessionId,
      vendor: this.vendorInfo(),
    }
  }

  /**
   * Selectable vendor rows for the panel and tools.
   * @returns {Array<{id:string,label:string,short:string}>} vendors.
   */
  listVendorOptions() {
    return listVendors()
  }

  /**
   * Current vendor snapshot for status, panel and model context.
   * @returns {{id:string,label:string,short:string,source:string|null}} vendor info.
   */
  vendorInfo() {
    const vendor = vendorById(this.vendor.id)
    if (vendor === undefined) {
      return { id: UNKNOWN_VENDOR.id, label: UNKNOWN_VENDOR.label, short: UNKNOWN_VENDOR.short, source: this.vendor.source }
    }
    return { id: vendor.id, label: vendor.label, short: vendor.short, source: this.vendor.source }
  }

  /**
   * Select the switch vendor manually, or clear it for auto-detection.
   * @param {string} id vendor id, or '' / 'auto' to clear.
   * @returns {object} status.
   */
  setVendor(id) {
    const value = String(id ?? '')
    if (value === '' || value === 'auto') {
      this.vendor = { id: null, source: null }
      this.hub.appendSystem('已切换为自动识别交换机厂商。')
      this.maybeDetectVendor(true)
      return this.status()
    }
    const vendor = vendorById(value)
    if (vendor === undefined) throw new Error(`未知厂商：${value}`)
    this.vendor = { id: vendor.id, source: 'manual' }
    this.hub.appendSystem(`交换机厂商已设为：${vendor.label}（之后的命令使用该厂商语法）。`)
    return this.status()
  }

  /**
   * Passive vendor detection from recent device echo (banners, version output,
   * prompts), throttled so a noisy console does not rescan on every chunk.
   * @param {boolean} [force] run even inside the throttle window.
   * @returns {void}
   */
  maybeDetectVendor(force = false) {
    const now = Date.now()
    if (!force && now - this.vendorScanAt < 1500) return
    this.vendorScanAt = now
    if (this.vendor.source === 'manual') return
    const tail = this.hub.entries
      .filter(entry => entry.kind === 'output')
      .slice(-80)
      .map(entry => entry.text)
      .join('\n')
      .slice(-6000)
    const found = detectVendor(tail)
    if (found === undefined) return
    if (this.vendor.id === found.id) return
    this.vendor = { id: found.id, source: 'auto' }
    this.hub.appendSystem(`已自动识别交换机厂商：${found.label}。请确认；如不正确，请在面板右上角「厂商」手动选择。`)
  }

  /**
   * Require a live connection.
   * @param {string} action action name used in the error.
   * @returns {SerialConnection|SshConnection} the connection.
   */
  requireConnection(action) {
    if (!this.connected) {
      throw new Error(`尚未连接设备，无法${action}。串口可用 console_serial_connect 连接；SSH 请在「设备控制台」面板输入密码连接。`)
    }
    return this.conn
  }

  /**
   * Open a serial connection.
   * @param {object} [options] connection options.
   * @param {string} [options.port] COM port path; auto-detected when one port exists.
   * @param {number} [options.baudRate] baud rate.
   * @param {number} [options.dataBits] data bits.
   * @param {number} [options.stopBits] stop bits.
   * @param {string} [options.parity] parity.
   * @returns {Promise<object>} status after connecting.
   */
  async connectSerial(options = {}) {
    await this.disconnect(true)
    const ports = await this.listPorts(true)
    const port = options.port === undefined || options.port === ''
      ? (ports.length === 1 ? ports[0].path : undefined)
      : String(options.port)
    if (port === undefined) {
      const known = ports.map(row => row.path).join(', ')
      throw new Error(
        ports.length === 0
          ? `未检测到串口设备${this.portsError ? `（serialport 模块错误：${this.portsError}）` : ''}。请确认 USB 转串口已插好，并在面板刷新端口列表。`
          : `检测到多个串口（${known}），请指定 port。`,
      )
    }
    const connection = await SerialConnection.open({
      path: port,
      baudRate: options.baudRate ?? DEFAULT_BAUD,
      dataBits: options.dataBits ?? 8,
      stopBits: options.stopBits ?? 1,
      parity: options.parity ?? 'none',
    })
    this.attach(connection)
    const meta = connection.meta
    this.hub.setSession({
      kind: 'serial',
      label: `串口 ${meta.path} · ${meta.baudRate} ${meta.dataBits}${meta.parityLetter}${meta.stopBits}`,
      meta,
    })
    this.hub.appendSystem(
      `已连接串口 ${meta.path}（${meta.baudRate} baud, ${meta.dataBits}${meta.parityLetter}${meta.stopBits}）。`,
    )
    this.vendor = { id: null, source: null }
    this.hub.appendSystem('请在面板右上角「厂商」选择交换机品牌；设备回显后也会自动识别。')
    return this.status()
  }

  /**
   * Ask the user to connect an SSH host from the panel.
   *
   * The tool suspends here while the panel shows the pending request; the user
   * types the password (or picks a saved one) and clicks connect, which lands
   * in {@link connectSsh} and resolves the wait.
   * @param {object} options request options.
   * @param {string} [options.alias] configured host alias.
   * @param {string} [options.host] host name or address.
   * @param {number} [options.port] SSH port.
   * @param {string} [options.username] user name.
   * @param {number} [options.waitMs] maximum wait.
   * @param {AbortSignal} [options.signal] cancellation.
   * @returns {Promise<object>} request outcome.
   */
  async requestSshConnect(options = {}) {
    if (this.connected) return { status: 'connected', session: this.hub.session }
    const hosts = await this.listHosts()
    const alias = options.alias === undefined ? undefined : String(options.alias)
    const known = alias === undefined ? undefined : hosts.find(row => row.alias === alias)
    const host = options.host !== undefined ? String(options.host) : known?.host
    const username = options.username !== undefined ? String(options.username) : known?.user
    const port = options.port !== undefined ? Number(options.port) : (known?.port ?? 22)
    if (host === undefined || username === undefined) {
      throw new Error('请提供 SSH 主机地址和用户名（也可用 alias 指定已在 DSH 中配置的主机）。')
    }
    this.sshRequestCancelled = false
    const pending = { alias: alias ?? '', host, port, username, requestedAt: Date.now() }
    this.hub.setPending(pending)
    this.hub.appendSystem(`DSH 请求通过 SSH 连接 ${username}@${host}:${port}，请在面板输入密码并点击「连接」。`)
    try {
      const settled = await this.hub.waitUntil(
        () =>
          this.hub.session?.kind === 'ssh' ||
          this.hub.paused ||
          this.sshRequestCancelled ||
          (options.signal !== undefined && options.signal.aborted),
        { timeoutMs: Math.max(1000, Math.min(options.waitMs ?? 90_000, 300_000)), signal: options.signal, pollMs: 150 },
      )
      if (this.hub.session?.kind === 'ssh') return { status: 'connected', session: this.hub.session }
      if (this.sshRequestCancelled) return { status: 'cancelled', message: '用户取消了 SSH 连接请求。' }
      if (this.hub.paused) return { status: 'paused', message: '用户暂停了操作。' }
      if (options.signal !== undefined && options.signal.aborted) return { status: 'aborted', message: '调用被取消。' }
      return {
        status: settled ? 'timeout' : 'timeout',
        message: '等待用户在面板输入密码超时。请让用户打开左侧「设备控制台」面板完成连接，再继续。',
      }
    } finally {
      this.hub.setPending(null)
    }
  }

  /**
   * Cancel a pending SSH connect request (panel action).
   * @returns {boolean} whether a request was pending.
   */
  cancelSshRequest() {
    const had = this.hub.pending !== null
    this.sshRequestCancelled = true
    this.hub.setPending(null)
    return had
  }

  /**
   * Open an SSH connection with credentials supplied by the user.
   * @param {object} options connection options.
   * @param {string} [options.alias] configured host alias (for saved password lookup).
   * @param {string} options.host host.
   * @param {number} [options.port] port.
   * @param {string} options.username user name.
   * @param {string} [options.password] password typed by the user.
   * @param {boolean} [options.useSavedPassword] reuse the password stored by dsh-ssh for the alias.
   * @param {string} [options.privateKeyPath] private key file path.
   * @param {string} [options.passphrase] private key passphrase.
   * @returns {Promise<object>} status after connecting.
   */
  async connectSsh(options = {}) {
    await this.disconnect(true)
    const host = String(options.host ?? '')
    const username = String(options.username ?? '')
    if (host === '' || username === '') throw new Error('SSH 连接需要主机地址和用户名。')
    const port = Number(options.port ?? 22)
    const alias = options.alias === undefined ? '' : String(options.alias)
    let password = options.password === undefined || options.password === '' ? undefined : String(options.password)
    if (password === undefined && options.useSavedPassword === true && alias !== '') {
      password = await savedPassword(alias)
      if (password === undefined) throw new Error(`未找到主机「${alias}」保存的密码，请在面板中手动输入。`)
    }
    let privateKey
    if (options.privateKeyPath !== undefined && String(options.privateKeyPath) !== '') {
      try {
        privateKey = await readFile(String(options.privateKeyPath), 'utf8')
      } catch (error) {
        throw new Error(`无法读取私钥文件：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (password === undefined && privateKey === undefined) {
      throw new Error('SSH 连接需要密码或私钥：请在面板输入密码，或勾选「使用已保存的密码」。')
    }
    const connection = await SshConnection.connect({
      host,
      port,
      username,
      password,
      privateKey,
      passphrase: options.passphrase === undefined ? undefined : String(options.passphrase),
    })
    this.attach(connection)
    this.hub.setSession({
      kind: 'ssh',
      label: `SSH ${username}@${host}:${port}`,
      meta: { host, port, username, alias },
    })
    this.hub.appendSystem(`已连接 SSH ${username}@${host}:${port}。`)
    this.vendor = { id: null, source: null }
    this.hub.appendSystem('请在面板右上角「厂商」选择交换机品牌；设备回显后也会自动识别。')
    return this.status()
  }

  /**
   * Attach data/close/error handlers to a new connection.
   * @param {SerialConnection|SshConnection} connection connection.
   */
  attach(connection) {
    this.conn = connection
    this.decoder = new StringDecoder('utf8')
    this.hub.lastOutputAt = Date.now()
    connection.onData(chunk => {
      const text = this.decoder.write(chunk)
      if (text !== '') {
        this.hub.appendOutput(clean(text))
        this.maybeDetectVendor()
      }
    })
    connection.onClose(() => {
      this.hub.clearSession('连接已断开。')
      this.conn = null
    })
    connection.onError(error => {
      this.hub.appendSystem(`连接错误：${error instanceof Error ? error.message : String(error)}`, 'error')
    })
  }

  /**
   * Close the active connection.
   * @param {boolean} [silent] skip the disconnect transcript line.
   * @returns {Promise<void>} resolves once closed.
   */
  async disconnect(silent = false) {
    const connection = this.conn
    this.conn = null
    if (connection !== null) {
      try {
        await connection.close()
      } catch {
        // Closing a dead connection is not an error worth reporting.
      }
      if (!silent) this.hub.clearSession('已断开连接。')
    }
    if (silent && this.hub.session !== null) this.hub.session = null
    this.vendor = { id: null, source: null }
    this.hub.setPending(null)
  }

  /**
   * Write a command line and wait for output to go quiet.
   * @param {object} options exec options.
   * @param {string} options.command command text sent to the device.
   * @param {string} [options.note] Chinese annotation shown next to the command.
   * @param {number} [options.waitMs] completion window.
   * @param {number} [options.idleMs] quiet window.
   * @param {string} [options.lineEnding] line ending name/escape.
   * @param {AbortSignal} [options.signal] cancellation.
   * @returns {Promise<object>} exec outcome.
   */
  async exec(options) {
    const command = String(options.command ?? '')
    const note = options.note === undefined ? '' : String(options.note)
    if (command === '') throw new Error('command 不能为空。')
    if (this.hub.paused) {
      return {
        ok: false,
        status: 'paused',
        command,
        note,
        output: '',
        durationMs: 0,
        message: '用户已暂停 DSH 的设备操作。请停止执行并等待新指令，用户恢复后再继续。',
      }
    }
    const connection = this.requireConnection('执行命令')
    const waitMs = Math.max(100, Math.min(Number(options.waitMs ?? DEFAULT_WAIT_MS), MAX_WAIT_MS))
    const idleMs = Math.max(80, Math.min(Number(options.idleMs ?? DEFAULT_IDLE_MS), MAX_IDLE_MS))
    if (this.hub.confirmMode && options.confirmed !== true) {
      const pending = this.hub.addPendingExec({
        command,
        note,
        waitMs,
        idleMs,
        lineEnding: options.lineEnding,
      })
      return {
        ok: true,
        status: 'awaiting-confirmation',
        command,
        note,
        output: '',
        durationMs: 0,
        pendingId: pending.id,
      }
    }
    const fallback = connection.kind === 'serial' ? '\r\n' : '\r'
    const ending = decodeLineEnding(options.lineEnding, fallback)
    const startSeq = this.hub.seq
    const startOutputSeq = this.hub.outputSeq
    const startedAt = Date.now()
    this.hub.appendCommand(command, note)
    await connection.write(command + ending)
    const status = await this.waitForQuiet({ startSeq, startOutputSeq, waitMs, idleMs, signal: options.signal })
    const output = capText(this.hub.textSince(startSeq).replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
    return {
      ok: true,
      status,
      command,
      note,
      output,
      durationMs: Date.now() - startedAt,
    }
  }

  /**
   * Toggle the "confirm before sending" gate.
   * @param {boolean} enabled new value.
   * @returns {object} status.
   */
  setConfirmMode(enabled) {
    const value = Boolean(enabled)
    this.hub.setConfirmMode(
      value,
      value
        ? '已开启「执行前确认」：DSH 给出的命令要在这里点「执行」才会发到设备。'
        : '已关闭「执行前确认」：DSH 将直接执行命令。',
    )
    return this.status()
  }

  /**
   * Execute one command the user confirmed in the panel.
   * @param {string} id pending command id.
   * @param {object} [options] options.
   * @param {AbortSignal} [options.signal] cancellation.
   * @returns {Promise<object>} exec outcome.
   */
  async executePending(id, options = {}) {
    const pending = this.hub.removePendingExec(id)
    if (pending === null) throw new Error('待确认的命令不存在或已经被处理。')
    this.hub.appendSystem(`用户已确认执行：${pending.command}`)
    const result = await this.exec({ ...pending, confirmed: true, signal: options.signal })
    await this.explainOutput(result)
    return result
  }

  /**
   * Cancel one pending command.
   * @param {string} id pending command id.
   * @returns {Promise<object>} outcome.
   */
  async cancelPending(id) {
    const pending = this.hub.removePendingExec(id)
    if (pending === null) throw new Error('待确认的命令不存在或已经被处理。')
    this.hub.appendSystem(`用户取消了待执行命令：${pending.command}`)
    return { ok: true, id, command: pending.command }
  }

  /**
   * Ask the model to explain one command's output, and append the explanation
   * to the transcript under that output. Runs inside the plugin panel; no chat
   * session is involved.
   * @param {object} result exec outcome.
   * @returns {Promise<string>} the explanation (empty when unavailable).
   */
  async explainOutput(result) {
    try {
      const text = await this.complete(
        EXPLAIN_SYSTEM,
        `命令：${result.command}\n状态：${result.status}\n输出：\n${result.output === '' ? '（无输出）' : result.output}`,
      )
      const note = String(text ?? '').trim()
      if (note !== '') this.hub.appendNote(note)
      return note
    } catch {
      return ''
    }
  }

  /**
   * Turn a panel requirement into concrete commands using the model directly
   * (no chat session): the suggested commands land in the pending area for the
   * user to confirm.
   * @param {string} text natural-language requirement.
   * @returns {Promise<{suggestions:Array<{command:string,note:string}>, reply:string}>} suggestions.
   */
  async suggestRequirement(text) {
    const value = String(text ?? '').trim()
    if (value === '') throw new Error('需求不能为空。')
    const context = this.buildModelContext()
    this.hub.appendRequirement(value)
    const reply = await this.complete(SUGGEST_SYSTEM, `${context}\n用户需求：${value}`)
    const parsed = parseSuggestions(reply)
    const suggestions = parsed.suggestions
    if (suggestions.length === 0) {
      const fallback = parsed.message !== '' ? parsed.message : this.emptySuggestionMessage()
      this.hub.appendSuggestion(fallback)
      return { suggestions: [], reply: String(reply ?? '').trim().slice(0, 300), message: fallback }
    }
    this.hub.appendSuggestion(`根据需求给出 ${suggestions.length} 条命令，请在「待确认命令」里点「执行」。`)
    for (const item of suggestions) {
      this.hub.addPendingExec({ command: item.command, note: item.note, waitMs: 20_000, idleMs: 800 })
    }
    return { suggestions, reply: '', message: parsed.message }
  }

  /**
   * Explain an empty suggestion set using the current connection/vendor state,
   * so the panel never shows a bare "no command" line.
   * @returns {string} a user-facing explanation.
   */
  emptySuggestionMessage() {
    const vendor = this.vendorInfo()
    if (!this.connected) return '还没有连接设备：请先在面板选择串口/SSH 连接，再让我生成命令。'
    if (vendor.id === UNKNOWN_VENDOR.id) return '当前还没有选择交换机厂商：请在面板右上角「厂商」里选择品牌（或等待设备回显自动识别），再让我生成命令。'
    return '模型这次没有给出可执行的命令：请补充具体目标（例如要看版本的哪个部分、要改哪个接口），我再生成。'
  }

  /**
   * Compact model context: connection facts plus the recent transcript.
   * @returns {string} context text.
   */
  buildModelContext() {
    const session = this.hub.session
    const lines = [
      session
        ? `当前连接：${session.kind === 'serial' ? '串口' : 'SSH'} ${session.label}`
        : '当前连接：未连接设备（除非需求是连接设备，否则先提示用户连接）',
    ]
    const vendor = this.vendorInfo()
    if (vendor.id === UNKNOWN_VENDOR.id) {
      lines.push('交换机厂商：未识别。涉及交换机命令时先让用户在面板右上角「厂商」选择品牌，不要猜厂商命令。')
    } else {
      const reference = vendorReference(vendor.id).slice(0, 4).map(row => row.command).join(' / ')
      lines.push(`交换机厂商：${vendor.label}。必须使用该厂商命令语法（例如 ${reference}），禁止混用其他厂商命令。`)
    }
    const tail = this.hub.renderTail(15)
    if (tail !== '') lines.push('最近终端记录：\n' + tail.slice(-3000))
    return lines.join('\n')
  }

  /**
   * Wait until device output has been quiet for `idleMs`, or the window ends.
   *
   * Only *device output* counts: the command line the console itself appends
   * must not look like a response, otherwise a silent command would report
   * completed immediately.
   * @param {object} options wait options.
   * @param {number} options.startSeq sequence before the command was written.
   * @param {number} options.waitMs maximum window.
   * @param {number} options.idleMs quiet window.
   * @param {AbortSignal} [options.signal] cancellation.
   * @returns {Promise<'completed'|'timeout'|'paused'|'aborted'>} outcome.
   */
  async waitForQuiet(options) {
    const deadline = Date.now() + options.waitMs
    let lastOutputSeq = this.hub.outputSeq
    let lastActivity = Date.now()
    let sawOutput = this.hub.outputSeq > (options.startOutputSeq ?? this.hub.outputSeq)
    for (;;) {
      if (options.signal !== undefined && options.signal.aborted) return 'aborted'
      if (this.hub.paused) return 'paused'
      if (this.hub.outputSeq !== lastOutputSeq) {
        lastOutputSeq = this.hub.outputSeq
        lastActivity = Date.now()
        sawOutput = true
      }
      const quietFor = Date.now() - lastActivity
      if (sawOutput && quietFor >= options.idleMs) return 'completed'
      if (Date.now() >= deadline) return 'timeout'
      await sleep(Math.max(20, Math.min(80, deadline - Date.now())))
    }
  }

  /**
   * Send raw input to the device.
   * @param {object} options send options.
   * @param {string} options.data payload; C-style escapes are expanded when `escape` is set.
   * @param {string} [options.note] annotation shown in the transcript.
   * @param {boolean} [options.echo] render the payload as a command line (panel input).
   * @param {boolean} [options.escape] expand `\\r`, `\\n`, `\\x03`, … (agent raw input).
   * @param {string} [options.lineEnding] line ending appended after the payload.
   * @param {string} [options.display] transcript label for a bare key press (Enter / Space).
   * @returns {Promise<object>} outcome.
   */
  async send(options) {
    if (this.hub.paused) {
      return { ok: false, status: 'paused', message: '用户已暂停 DSH 的设备操作。' }
    }
    const connection = this.requireConnection('发送数据')
    let payload = String(options.data ?? '')
    if (options.escape === true) payload = unescapeText(payload)
    if (options.lineEnding !== undefined) payload += decodeLineEnding(options.lineEnding, '')
    if (payload === '') throw new Error('data 不能为空。')
    const note = options.note === undefined ? '' : String(options.note)
    if (options.echo === true) {
      this.hub.appendCommand(payload.replace(/[\r\n]+$/, ''), note)
    } else if (typeof options.display === 'string' && options.display !== '') {
      this.hub.appendCommand(options.display, note)
    } else {
      this.hub.appendCommand(`[原始数据] ${printable(payload)}`, note)
    }

    await connection.write(payload)
    return { ok: true, status: 'sent', data: printable(payload), note }
  }

  /**
   * Append a human-readable explanation of the latest command output.
   *
   * This is display-only: nothing is written to the device, and the entry is
   * not part of the command's captured output.
   * @param {string} text Chinese explanation shown under the output.
   * @returns {{seq:number,text:string}} the stored note entry summary.
   */
  addNote(text) {
    const value = String(text ?? '').trim()
    if (value === '') throw new Error('解读内容不能为空。')
    const entry = this.hub.appendNote(value)
    return { seq: entry.seq, text: entry.text }
  }

  /**
   * Read buffered transcript. `text` is the rendered transcript (commands with
   * their annotations, device output, and output explanations) so the agent can
   * review what was actually run and what it meant.
   * @param {object} [options] read options.
   * @param {number} [options.sinceSeq] start sequence (exclusive).
   * @param {number} [options.limit] maximum entries.
   * @returns {object} transcript rows and text.
   */
  read(options = {}) {
    const sinceSeq = Number(options.sinceSeq ?? 0)
    const limit = Math.max(1, Math.min(Number(options.limit ?? 200), 2000))
    const entries = this.hub.since(sinceSeq).slice(-limit)
    return {
      connected: this.connected,
      session: this.hub.session,
      paused: this.hub.paused,
      firstSeq: this.hub.firstSeq,
      lastSeq: this.hub.seq,
      entries,
      text: capText(this.hub.renderEntries(entries)),
    }
  }

  /**
   * Pause or resume DSH operations. Pausing also cancels the running turn of
   * the agent that last drove the console.
   * @param {boolean} paused new value.
   * @returns {object} status.
   */
  setPaused(paused) {
    const value = Boolean(paused)
    this.hub.setPaused(value, value ? '用户已暂停 DSH 的设备操作（面板按钮）。' : '用户已恢复 DSH 的设备操作。')
    if (value) {
      const sessionId = this.hub.lastAgentSessionId
      if (typeof sessionId === 'string' && sessionId !== '') {
        try {
          this.cancelAgentTurn(sessionId)
        } catch {
          // Cancellation is best-effort; the paused flag still blocks new work.
        }
      }
    }
    return this.status()
  }

  /**
   * Snapshot for the panel.
   * @param {number} sinceSeq last sequence the client holds.
   * @param {object} [options] snapshot options.
   * @param {boolean} [options.history] include transcript entries.
   * @returns {Promise<object>} JSON-safe snapshot.
   */
  async panelState(sinceSeq, options = {}) {
    const ports = await this.listPorts()
    const hosts = await this.listHosts()
    const entries = options.history === false ? [] : this.hub.since(sinceSeq)
    return {
      session: this.hub.session,
      paused: this.hub.paused,
      pending: this.hub.pending,
      confirmMode: this.hub.confirmMode,
      pendingExecs: this.hub.pendingExecs,
      firstSeq: this.hub.firstSeq,
      lastSeq: this.hub.seq,
      lastOutputAt: this.hub.lastOutputAt,
      serverTime: Date.now(),
      ports,
      portsError: this.portsError ?? null,
      sshHosts: hosts,
      vendor: this.vendorInfo(),
      vendors: listVendors(),
      vendorCommands: vendorReference(this.vendor.id),
      entries,
    }
  }

  /** Release resources. */
  async dispose() {
    this.hub.dispose()
    const connection = this.conn
    this.conn = null
    if (connection !== null) {
      try {
        await connection.close()
      } catch {
        // ignore
      }
    }
  }
}

export { ConsoleHub }
