/**
 * SSH adapter built on `ssh2`, imported lazily for the same reason as the
 * serial adapter: plugin activation must not depend on the native addon path.
 *
 * One connection = one ssh2 Client + one interactive shell channel, so the
 * user and the agent see the same terminal.
 */
import { createRequire } from 'node:module'

/** CJS require anchored at this module, used as the fallback loader. */
const requireFromHere = createRequire(import.meta.url)

/** Cached ssh2 module namespace. */
let ssh2Module

/**
 * Load ssh2 through ESM first and CJS `require` as a fallback (a host loader
 * may hand a CommonJS package back with only a `default` export).
 * @returns {Promise<{Client: object}>} the ssh2 module subset.
 */
async function loadSsh2() {
  if (ssh2Module !== undefined) return ssh2Module
  const problems = []
  const pick = value => (value !== null && typeof value === 'object' && typeof value.Client === 'function' ? value : undefined)
  try {
    const mod = await import('ssh2')
    ssh2Module = pick(mod) ?? pick(mod?.default)
    if (ssh2Module === undefined) problems.push('import: 模块无 Client 导出')
  } catch (error) {
    ssh2Module = undefined
    problems.push('import: ' + (error instanceof Error ? error.message : String(error)))
  }
  if (ssh2Module === undefined) {
    try {
      ssh2Module = pick(requireFromHere('ssh2'))
      if (ssh2Module === undefined) problems.push('require: 模块无 Client 导出')
    } catch (error) {
      ssh2Module = undefined
      problems.push('require: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  if (ssh2Module === undefined) throw new Error('无法加载 ssh2 模块（' + problems.join('；') + '）')
  return ssh2Module
}

/**
 * Deferred promise helper.
 * @returns {{promise: Promise<unknown>, resolve: (value?: unknown) => void, reject: (error: unknown) => void}} deferred.
 */
function defer() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * One open SSH connection with an interactive shell channel.
 */
export class SshConnection {
  /**
   * @param {object} client ssh2 Client.
   * @param {object} stream shell channel stream.
   * @param {object} meta connection metadata.
   */
  constructor(client, stream, meta) {
    this.kind = 'ssh'
    this.client = client
    this.stream = stream
    this.meta = meta
    this.closed = false
    this.dataHandlers = new Set()
    this.closeHandlers = new Set()
    this.errorHandlers = new Set()
    stream.on('data', chunk => {
      for (const handler of this.dataHandlers) handler(chunk)
    })
    stream.stderr?.on('data', chunk => {
      for (const handler of this.dataHandlers) handler(chunk)
    })
    stream.on('close', () => this.finish())
    client.on('close', () => this.finish())
    client.on('error', error => {
      for (const handler of this.errorHandlers) handler(error)
    })
  }

  /**
   * Connect and open an interactive shell.
   * @param {object} options connection options.
   * @param {string} options.host host name or address.
   * @param {number} [options.port] SSH port.
   * @param {string} options.username user name.
   * @param {string} [options.password] password.
   * @param {string} [options.privateKey] private key contents.
   * @param {string} [options.passphrase] passphrase for the private key.
   * @param {number} [options.readyTimeout] handshake timeout.
   * @returns {Promise<SshConnection>} the open connection.
   */
  static async connect(options) {
    const { Client } = await loadSsh2()
    const host = String(options.host)
    const port = Number(options.port ?? 22)
    const username = String(options.username)
    const password = options.password === undefined ? undefined : String(options.password)
    const client = new Client()
    const ready = defer()
    let settled = false

    client.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finish) => {
      finish(password === undefined ? [] : [password])
    })
    client.once('ready', () => {
      settled = true
      ready.resolve()
    })
    client.once('error', error => {
      if (!settled) {
        settled = true
        ready.reject(error)
      }
    })
    client.connect({
      host,
      port,
      username,
      password,
      privateKey: options.privateKey,
      passphrase: options.passphrase,
      readyTimeout: Number(options.readyTimeout ?? 20_000),
      keepaliveInterval: 15_000,
      tryKeyboard: true,
    })
    await ready.promise

    const shell = defer()
    client.shell({ term: 'xterm-256color', cols: 120, rows: 32 }, (error, stream) => {
      if (error) shell.reject(error)
      else shell.resolve(stream)
    })
    const stream = await shell.promise
    return new SshConnection(client, stream, { host, port, username })
  }

  /**
   * Register a data handler.
   * @param {(chunk: Buffer) => void} handler callback.
   * @returns {() => void} unsubscribe.
   */
  onData(handler) {
    this.dataHandlers.add(handler)
    return () => this.dataHandlers.delete(handler)
  }

  /**
   * Register a close handler.
   * @param {() => void} handler callback.
   * @returns {() => void} unsubscribe.
   */
  onClose(handler) {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  /**
   * Register an error handler.
   * @param {(error: unknown) => void} handler callback.
   * @returns {() => void} unsubscribe.
   */
  onError(handler) {
    this.errorHandlers.add(handler)
    return () => this.errorHandlers.delete(handler)
  }

  /** Mark the connection closed once, notifying listeners. */
  finish() {
    if (this.closed) return
    this.closed = true
    for (const handler of this.closeHandlers) handler()
  }

  /**
   * Write to the shell.
   * @param {string|Buffer} data payload.
   * @returns {Promise<void>} resolves when written.
   */
  write(data) {
    if (this.closed) return Promise.reject(new Error('SSH 连接已关闭'))
    return new Promise((resolve, reject) => {
      try {
        this.stream.write(data, error => (error ? reject(error) : resolve()))
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * Close the connection.
   * @returns {Promise<void>} resolves once closed.
   */
  async close() {
    if (this.closed) {
      return
    }
    this.closed = true
    try {
      this.stream.end()
    } catch {
      // ignore
    }
    try {
      this.client.end()
    } catch {
      // ignore
    }
  }
}
