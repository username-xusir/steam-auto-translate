// 用 Edge + 本地英文页验证 CDP 注入与翻译插入（mock 翻译源）
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const CFG_DIR = 'C:/Users/Clair/AppData/Local/Temp/sat-cdp-test'
fs.rmSync(CFG_DIR, { recursive: true, force: true }); fs.mkdirSync(CFG_DIR, { recursive: true })
process.env.SAT_CONFIG_DIR = CFG_DIR
fs.writeFileSync(CFG_DIR + '/config.json', JSON.stringify({ provider: 'mock', autoTranslate: true, imageOcr: false, allowedHosts: ['127.0.0.1'] }))

const { runWatcher } = await import('../src/watcher.mjs')

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PROFILE = 'C:/Users/Clair/AppData/Local/Temp/sat-cdp-profile'
const HTTP_PORT = 8877
const CDP_PORT = 9333

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Test</title></head><body>
<h1>This is a great game</h1>
<p>The Elder Scrolls V: Skyrim is an open world action role-playing game developed by Bethesda Game Studios.</p>
<div class="workshopItemDescription">This workshop item adds a brand new quest line with fully voiced characters and multiple endings.</div>
<ul><li>Very positive reviews from players around the world.</li><li>Supports cooperative multiplayer.</li></ul>
</body></html>`

const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(PAGE) })
await new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', r))

fs.rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, [
  '--user-data-dir=' + PROFILE.replace(/\\/g, '/'),
  '--remote-debugging-port=' + CDP_PORT,
  '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-component-update',
  'http://127.0.0.1:' + HTTP_PORT + '/test',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let stop = false
const watcherPromise = runWatcher({ port: CDP_PORT, shouldStop: () => stop })
await sleep(7000)

async function evalOnPage(expr) {
  const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()
  const t = list.find((x) => x.type === 'page' && x.url.includes('127.0.0.1'))
  if (!t) return { error: 'no page target' }
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const result = await new Promise((res) => {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id === 1) res(m.result)
    })
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
  })
  try { ws.close() } catch {}
  return result?.result?.value
}

const count = await evalOnPage('document.querySelectorAll(".sat-tr").length')
const texts = await evalOnPage('Array.from(document.querySelectorAll(".sat-tr")).slice(0,4).map(e=>e.textContent)')
const button = await evalOnPage('!!document.getElementById("__sat_host")')
console.log('sat-tr count =', count)
console.log('button host  =', button)
console.log('samples      =', texts)

stop = true
await Promise.race([watcherPromise, sleep(3000)])
try { execFileSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
server.close()
console.log(count > 0 ? 'RESULT: CDP 注入与翻译生效 ✓' : 'RESULT: 未生效 ✗')
