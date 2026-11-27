// Steam 定位、进程检测、CEF 调试端口开关
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const DEBUG_FILE = '.cef-enable-remote-debugging'
export const DEFAULT_PORT = 8080

export function getSteamPath() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'latin1', windowsHide: true })
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i)
    if (m) return m[1].trim().replace(/\//g, '\\')
  } catch {}
  for (const p of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) {
    if (fs.existsSync(path.join(p, 'steam.exe'))) return p
  }
  return null
}

export function isSteamRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH'], { encoding: 'latin1', windowsHide: true })
    return /steam\.exe/i.test(out)
  } catch { return false }
}

export function hasHelperRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq steamwebhelper.exe', '/NH'], { encoding: 'latin1', windowsHide: true })
    return /steamwebhelper\.exe/i.test(out)
  } catch { return false }
}

export function debugFileEnabled(steamPath) {
  return steamPath ? fs.existsSync(path.join(steamPath, DEBUG_FILE)) : false
}

export function enableCefDebug(steamPath) {
  if (!steamPath) throw new Error('未找到 Steam 安装目录')
  const f = path.join(steamPath, DEBUG_FILE)
  if (!fs.existsSync(f)) fs.writeFileSync(f, '', 'utf8')
  return f
}

export function disableCefDebug(steamPath) {
  if (!steamPath) return false
  const f = path.join(steamPath, DEBUG_FILE)
  if (fs.existsSync(f)) { fs.unlinkSync(f); return true }
  return false
}

export async function fetchJson(url, timeoutMs = 1500) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) return null
    return await r.json()
  } catch { return null } finally { clearTimeout(t) }
}

export async function debugPortUp(port = DEFAULT_PORT) {
  const v = await fetchJson(`http://127.0.0.1:${port}/json/version`)
  return !!v
}

export async function listTargets(port = DEFAULT_PORT) {
  const list = await fetchJson(`http://127.0.0.1:${port}/json/list`, 2000)
  return Array.isArray(list) ? list : []
}

export function waitFor(predicate, { timeoutMs = 30000, interval = 500 } = {}) {
  const start = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      if (predicate()) return resolve(true)
      if (Date.now() - start > timeoutMs) return resolve(false)
      setTimeout(tick, interval)
    }
    tick()
  })
}
