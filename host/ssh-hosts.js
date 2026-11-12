/**
 * Read the SSH host list the user already configured in DSH's SSH plugin
 * (`$DSH_HOME/dsh-ssh.json`). This plugin never writes that file and never
 * exposes stored passwords to the agent: the panel only learns whether a
 * password exists, and the host half reads it itself when the user chooses to
 * reuse it.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve the DSH home directory.
 * @returns {string} absolute path.
 */
export function dshHome() {
  const override = process.env.DSH_HOME
  if (typeof override === 'string' && override !== '') return override
  return join(homedir(), '.dsh')
}

/**
 * Path of the dsh-ssh host store.
 * @returns {string} absolute path.
 */
export function sshStorePath() {
  return join(dshHome(), 'dsh-ssh.json')
}

/**
 * Read the raw store document.
 * @returns {Promise<Record<string, unknown>|null>} parsed document or null.
 */
async function readStore() {
  try {
    const raw = await readFile(sshStorePath(), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Normalize one stored host row.
 * @param {unknown} row raw row.
 * @returns {{alias:string,host:string,port:number,user:string,hasSavedPassword:boolean}|null} summary.
 */
function summarize(row) {
  if (typeof row !== 'object' || row === null) return null
  const record = /** @type {Record<string, unknown>} */ (row)
  const alias = typeof record.alias === 'string' ? record.alias : ''
  const host = typeof record.host === 'string' ? record.host : ''
  const user = typeof record.user === 'string' ? record.user : ''
  if (alias === '' || host === '' || user === '') return null
  const port = Number(record.port)
  const auth = typeof record.auth === 'object' && record.auth !== null ? record.auth : null
  const kind = auth === null ? '' : String(auth.kind ?? '')
  const hasSavedPassword = kind === 'password' && typeof auth.password === 'string' && auth.password !== ''
  return {
    alias,
    host,
    port: Number.isFinite(port) && port > 0 ? port : 22,
    user,
    hasSavedPassword,
  }
}

/**
 * List SSH hosts the user configured in the DSH SSH plugin.
 * @returns {Promise<Array<{alias:string,host:string,port:number,user:string,hasSavedPassword:boolean}>>} host summaries.
 */
export async function listSshHosts() {
  const store = await readStore()
  if (store === null) return []
  const rows = Array.isArray(store.hosts) ? store.hosts : []
  const result = []
  for (const row of rows) {
    const summary = summarize(row)
    if (summary !== null) result.push(summary)
  }
  return result
}

/**
 * Read the password the user stored for one alias.
 * @param {string} alias host alias.
 * @returns {Promise<string|undefined>} stored password, when present.
 */
export async function savedPassword(alias) {
  const store = await readStore()
  if (store === null) return undefined
  const rows = Array.isArray(store.hosts) ? store.hosts : []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    if (row.alias !== alias) continue
    const auth = typeof row.auth === 'object' && row.auth !== null ? row.auth : null
    if (auth === null) return undefined
    if (String(auth.kind ?? '') !== 'password') return undefined
    return typeof auth.password === 'string' && auth.password !== '' ? auth.password : undefined
  }
  return undefined
}
