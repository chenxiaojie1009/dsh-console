/**
 * The /api/device-console route family used by the browser panel.
 *
 * Every route sits behind a loopback trust fence (socket address, Host header
 * and same-origin browser markers): the console can execute commands on
 * attached devices, so a LAN-exposed deployment must not serve it.
 */

/** Route base. */
export const CONSOLE_API = '/api/device-console'

/**
 * Whether an IPv4 literal is in 127/8.
 * @param {string} value address text.
 * @returns {boolean} true for loopback.
 */
function isIPv4Loopback(value) {
  const parts = value.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/**
 * Whether a socket address is loopback.
 * @param {string|undefined} address remote address.
 * @returns {boolean} true for loopback.
 */
function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/**
 * Whether a URL hostname names loopback.
 * @param {string} hostname hostname.
 * @returns {boolean} true for loopback.
 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Loopback trust fence for one request.
 * @param {import('node:http').IncomingMessage} request node request.
 * @returns {boolean} true when the request may reach the console API.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  if (request.headers['cf-connecting-ip'] !== undefined) return false
  if (request.headers['x-forwarded-for'] !== undefined) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response node response.
 * @param {number} status HTTP status.
 * @param {unknown} body JSON body.
 * @returns {void}
 */
export function writeJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/**
 * Read a JSON object body with a size cap.
 * @param {import('node:http').IncomingMessage} request node request.
 * @param {number} [maxBytes] body cap.
 * @returns {Promise<Record<string, unknown>|null>} parsed object or null.
 */
export async function readJsonBody(request, maxBytes = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) {
      request.destroy()
      return null
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Guarantee the fence and one HTTP method.
 * @param {import('node:http').IncomingMessage} request request.
 * @param {import('node:http').ServerResponse} response response.
 * @param {string} method expected method.
 * @returns {boolean} true when the handler may proceed.
 */
function guard(request, response, method) {
  if (!isLoopbackRequest(request)) {
    writeJson(response, 403, { error: 'forbidden: loopback-only' })
    return false
  }
  if ((request.method ?? 'GET') !== method) {
    writeJson(response, 405, { error: `method not allowed: ${request.method}` })
    return false
  }
  return true
}

/**
 * Build every console API route.
 * @param {object} deps dependencies.
 * @param {import('./engine.js').ConsoleEngine} deps.engine console engine.
 * @returns {Array<{kind:'exact', path:string, handler:(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}>} routes.
 */
export function makeRoutes(deps) {
  const { engine } = deps

  /**
   * Turn a thrown error into a 400 with its message.
   * @param {import('node:http').ServerResponse} response response.
   * @param {unknown} error error.
   * @returns {void}
   */
  const fail = (response, error) => {
    writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
  }

  return [
    {
      kind: 'exact',
      path: `${CONSOLE_API}/state`,
      async handler(request, response) {
        if (!guard(request, response, 'GET')) return
        const url = new URL(request.url ?? '/', 'http://localhost')
        const since = Number(url.searchParams.get('since') ?? '0')
        const history = url.searchParams.get('history') !== '0'
        try {
          writeJson(response, 200, await engine.panelState(Number.isFinite(since) ? since : 0, { history }))
        } catch (error) {
          fail(response, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${CONSOLE_API}/connect`,
      async handler(request, response) {
        if (!guard(request, response, 'POST')) return
        const body = await readJsonBody(request)
        if (body === null) {
          writeJson(response, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const kind = String(body.kind ?? '')
          if (kind === 'serial') {
            await engine.connectSerial({
              port: body.port === undefined ? undefined : String(body.port),
              baudRate: body.baudRate === undefined ? undefined : Number(body.baudRate),
              dataBits: body.dataBits === undefined ? undefined : Number(body.dataBits),
              stopBits: body.stopBits === undefined ? undefined : Number(body.stopBits),
              parity: body.parity === undefined ? undefined : String(body.parity),
            })
          } else if (kind === 'ssh') {
            await engine.connectSsh({
              alias: body.alias === undefined ? undefined : String(body.alias),
              host: body.host === undefined ? undefined : String(body.host),
              port: body.port === undefined ? undefined : Number(body.port),
              username: body.username === undefined ? undefined : String(body.username),
              password: body.password === undefined ? undefined : String(body.password),
              useSavedPassword: body.useSavedPassword === true,
              privateKeyPath: body.privateKeyPath === undefined ? undefined : String(body.privateKeyPath),
              passphrase: body.passphrase === undefined ? undefined : String(body.passphrase),
            })
          } else {
            throw new Error('kind 必须是 serial 或 ssh。')
          }
          writeJson(response, 200, await engine.panelState(engine.hub.seq, { history: false }))
        } catch (error) {
          fail(response, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${CONSOLE_API}/disconnect`,
      async handler(request, response) {
        if (!guard(request, response, 'POST')) return
        try {
          await engine.disconnect(false)
          writeJson(response, 200, await engine.panelState(engine.hub.seq, { history: false }))
        } catch (error) {
          fail(response, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${CONSOLE_API}/send`,
      async handler(request, response) {
        if (!guard(request, response, 'POST')) return
        const body = await readJsonBody(request)
        if (body === null) {
          writeJson(response, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const result = await engine.send({
            data: body.data === undefined ? '' : String(body.data),
            note: body.note === undefined ? undefined : String(body.note),
            echo: body.echo === true,
            escape: body.escape === true,
            display: body.display === undefined ? undefined : String(body.display),
            lineEnding: body.lineEnding === undefined ? undefined : String(body.lineEnding),
          })
          writeJson(response, 200, result)
        } catch (error) {
          fail(response, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${CONSOLE_API}/pause`,
      async handler(request, response) {
        if (!guard(request, response, 'POST')) return
        const body = await readJsonBody(request)
        if (body === null) {
          writeJson(response, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          engine.setPaused(body.paused === true)
          writeJson(response, 200, await engine.panelState(engine.hub.seq, { history: false }))
        } catch (error) {
          fail(response, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${CONSOLE_API}/confirm-mode`,
      async handler(request, response) {
        if (!guard(request, response, 'POST')) return
        const body = await readJsonBody(request)
        if (body === null) {
          writeJson(response, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          engine.setConfirmMode(body.enabled === true)
          writeJson(response, 200, await engine.panelState(engine.hub.seq, { history: false }))
        } catch (error) {
          fail(response, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${CONSOLE_API}/ask`,
      async handler(request, response) {
        if (!guard(request, response, 'POST')) return
        const body = await readJsonBody(request)
        if (body === null) {
          writeJson(response, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const result = await engine.suggestRequirement(body.text === undefined ? '' : String(body.text))
          const count = result.suggestions.length
          writeJson(response, 200, {
            ok: true,
            suggestions: result.suggestions,
            reply: result.reply,
            message: count > 0 ? `已生成 ${count} 条命令，请在「待确认命令」里点「执行」。` : '模型没有给出可执行的命令。',
          })
        } catch (error) {
          fail(response, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${CONSOLE_API}/pending/execute`,
      async handler(request, response) {
        if (!guard(request, response, 'POST')) return
        const body = await readJsonBody(request)
        if (body === null) {
          writeJson(response, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const result = await engine.executePending(String(body.id ?? ''))
          writeJson(response, 200, {
            ok: true,
            result,
            state: await engine.panelState(engine.hub.seq, { history: false }),
          })
        } catch (error) {
          fail(response, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${CONSOLE_API}/pending/cancel`,
      async handler(request, response) {
        if (!guard(request, response, 'POST')) return
        const body = await readJsonBody(request)
        if (body === null) {
          writeJson(response, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const result = await engine.cancelPending(String(body.id ?? ''))
          writeJson(response, 200, {
            ok: true,
            result,
            state: await engine.panelState(engine.hub.seq, { history: false }),
          })
        } catch (error) {
          fail(response, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${CONSOLE_API}/cancel-ssh`,
      async handler(request, response) {
        if (!guard(request, response, 'POST')) return
        try {
          engine.cancelSshRequest()
          writeJson(response, 200, await engine.panelState(engine.hub.seq, { history: false }))
        } catch (error) {
          fail(response, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${CONSOLE_API}/clear`,
      async handler(request, response) {
        if (!guard(request, response, 'POST')) return
        try {
          engine.hub.clear()
          writeJson(response, 200, await engine.panelState(0, { history: false }))
        } catch (error) {
          fail(response, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${CONSOLE_API}/ports`,
      async handler(request, response) {
        if (!guard(request, response, 'GET')) return
        try {
          const ports = await engine.listPorts(true)
          const hosts = await engine.listHosts(true)
          writeJson(response, 200, { ports, portsError: engine.portsError ?? null, sshHosts: hosts })
        } catch (error) {
          fail(response, error)
        }
      },
    },
  ]
}
