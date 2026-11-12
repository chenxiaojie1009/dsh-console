/**
 * Serial-port adapter. `serialport` is a native module, so it is imported
 * lazily: the plugin must activate (panel, routes, tools) even on a machine
 * where the native binding cannot load, and report the failure on connect.
 */
import { createRequire } from 'node:module'

/** CJS require anchored at this module, used as the fallback loader. */
const requireFromHere = createRequire(import.meta.url)

/** Cached serialport module namespace. */
let serialportModule

/** Platform binding module and class name inside `@serialport/bindings-cpp`. */
const PLATFORM_BINDING = {
  win32: { file: 'win32', className: 'WindowsBinding' },
  linux: { file: 'linux', className: 'LinuxBinding' },
  darwin: { file: 'darwin', className: 'DarwinBinding' },
}

/**
 * Build the `SerialPort` class from `@serialport/stream` plus the platform
 * binding module directly.
 *
 * This is the same composition serialport's own `dist/serialport.js` performs,
 * but without going through `serialport`'s index or the bindings-cpp index:
 * some host module loaders return those aggregate re-exports without their
 * spread exports (`autoDetect()` then yields `undefined`), while the direct
 * subpath modules load correctly.
 * @param {(id: string) => object} require CJS require anchored at this module.
 * @returns {{SerialPort: Function}|undefined} a usable module subset.
 */
function composeSerialport(require) {
  const platform = PLATFORM_BINDING[process.platform]
  if (platform === undefined) return undefined
  const stream = require('@serialport/stream')
  if (stream === null || typeof stream !== 'object' || typeof stream.SerialPortStream !== 'function') return undefined
  const bindingModule = require(`@serialport/bindings-cpp/dist/${platform.file}.js`)
  const binding = bindingModule === null ? undefined : bindingModule[platform.className]
  if (binding === null || typeof binding !== 'object' || typeof binding.list !== 'function') return undefined
  class SerialPort extends stream.SerialPortStream {
    static list = binding.list
    static binding = binding
    constructor(options, openCallback) {
      super({ binding, ...options }, openCallback)
    }
  }
  return { SerialPort }
}

/**
 * Load serialport: ESM import, then CJS require, then the direct composition
 * fallback for host loaders that break the package's aggregate re-exports.
 * @returns {Promise<{SerialPort: object}>} the serialport module subset.
 */
async function loadSerialport() {
  if (serialportModule !== undefined) return serialportModule
  const problems = []
  const pick = value =>
    value !== null && typeof value === 'object' && typeof value.SerialPort === 'function' ? value : undefined
  try {
    const mod = await import('serialport')
    serialportModule = pick(mod) ?? pick(mod?.default)
  } catch (error) {
    problems.push('import: ' + (error instanceof Error ? error.message : String(error)))
  }
  if (serialportModule === undefined) {
    try {
      serialportModule = pick(requireFromHere('serialport'))
    } catch (error) {
      problems.push('require: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  if (serialportModule === undefined) {
    try {
      serialportModule = composeSerialport(requireFromHere)
      if (serialportModule === undefined) problems.push('compose: 不支持的平台或缺少绑定模块')
    } catch (error) {
      problems.push('compose: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  if (serialportModule === undefined) {
    throw new Error('无法加载 serialport 模块（' + problems.join('；') + '）')
  }
  return serialportModule
}

/**
 * List serial ports available on this machine.
 * @returns {Promise<{ports: Array<{path:string,manufacturer?:string,serialNumber?:string,vendorId?:string,productId?:string}>, error?: string}>}
 *   detected ports, or an error string when the native module is unavailable.
 */
export async function listSerialPorts() {
  try {
    const { SerialPort } = await loadSerialport()
    const found = await SerialPort.list()
    return {
      ports: found.map(port => ({
        path: String(port.path),
        manufacturer: port.manufacturer === undefined ? undefined : String(port.manufacturer),
        serialNumber: port.serialNumber === undefined ? undefined : String(port.serialNumber),
        vendorId: port.vendorId === undefined ? undefined : String(port.vendorId),
        productId: port.productId === undefined ? undefined : String(port.productId),
      })),
    }
  } catch (error) {
    return { ports: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/** Parity letters used by `mode`/serialport. */
const PARITY = { none: 'N', even: 'E', odd: 'O', mark: 'M', space: 'S' }

/**
 * Normalize a parity option.
 * @param {unknown} value raw option.
 * @returns {'none'|'even'|'odd'|'mark'|'space'} parity.
 */
function normalizeParity(value) {
  const text = String(value ?? 'none').toLowerCase()
  return text === 'even' || text === 'odd' || text === 'mark' || text === 'space' ? text : 'none'
}

/**
 * Deferred promise helper.
 * @returns {{promise: Promise<void>, resolve: () => void, reject: (error: unknown) => void}} deferred.
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
 * One open serial connection.
 */
export class SerialConnection {
  /**
   * @param {object} port serialport instance.
   * @param {object} meta connection metadata.
   */
  constructor(port, meta) {
    this.kind = 'serial'
    this.port = port
    this.meta = meta
    this.closed = false
    this.dataHandlers = new Set()
    this.closeHandlers = new Set()
    this.errorHandlers = new Set()
    port.on('data', chunk => {
      for (const handler of this.dataHandlers) handler(chunk)
    })
    port.on('error', error => {
      for (const handler of this.errorHandlers) handler(error)
    })
    port.on('close', () => {
      if (!this.closed) {
        this.closed = true
        for (const handler of this.closeHandlers) handler()
      }
    })
  }

  /**
   * Open a serial port.
   * @param {object} options connection options.
   * @param {string} options.path COM port path (COM3, /dev/ttyUSB0, …).
   * @param {number} [options.baudRate] baud rate.
   * @param {number} [options.dataBits] data bits.
   * @param {number} [options.stopBits] stop bits.
   * @param {string} [options.parity] parity.
   * @returns {Promise<SerialConnection>} the open connection.
   */
  static async open(options) {
    const { SerialPort } = await loadSerialport()
    const path = String(options.path)
    const baudRate = Number(options.baudRate ?? 115200)
    const dataBits = Number(options.dataBits ?? 8)
    const stopBits = Number(options.stopBits ?? 1)
    const parity = normalizeParity(options.parity)
    const port = new SerialPort({
      path,
      baudRate,
      dataBits,
      stopBits,
      parity,
      autoOpen: false,
      lock: true,
    })
    const opened = defer()
    port.open(error => {
      if (error) opened.reject(error)
      else opened.resolve()
    })
    await opened.promise
    return new SerialConnection(port, {
      path,
      baudRate,
      dataBits,
      stopBits,
      parity,
      parityLetter: PARITY[parity],
    })
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

  /**
   * Write text to the port.
   * @param {string|Buffer} data payload.
   * @returns {Promise<void>} resolves when the write is accepted.
   */
  write(data) {
    if (this.closed) return Promise.reject(new Error('串口已关闭'))
    const pending = defer()
    this.port.write(data, error => {
      if (error) pending.reject(error)
      else this.port.drain(drainError => (drainError ? pending.reject(drainError) : pending.resolve()))
    })
    return pending.promise
  }

  /**
   * Close the port.
   * @returns {Promise<void>} resolves once closed.
   */
  async close() {
    if (this.closed) return
    this.closed = true
    await new Promise(resolve => {
      try {
        if (!this.port.isOpen) {
          resolve()
          return
        }
        this.port.close(() => resolve())
      } catch {
        resolve()
      }
    })
  }
}
