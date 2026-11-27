// CDP 监听器：连接 Steam CEF 调试端口，注入翻译脚本，桥接翻译请求
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { AGENT_JS } from './agent.generated.mjs'
import { createTranslator } from './translate.mjs'
import { ocrImage } from './ocr.mjs'
import { loadConfig, saveConfig, logFile, configFile } from './config.mjs'
import { isSteamRunning, listTargets, debugPortUp, DEFAULT_PORT } from './steam.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let LOG_STREAM = null
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    if (!LOG_STREAM) {
      fs.mkdirSync(path.dirname(logFile()), { recursive: true })
      LOG_STREAM = fs.createWriteStream(logFile(), { flags: 'a' })
    }
    LOG_STREAM.write(line)
  } catch {}
  if (!process.env.SAT_QUIET) process.stdout.write(line)
}

// ---------------- 极简 CDP 客户端 ----------------
class CDP {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
  }
  open() {
    return new Promise((resolve, reject) => {
      let settled = false
      try { this.ws = new WebSocket(this.url) } catch (e) { return reject(e) }
      const to = setTimeout(() => { if (!settled) { settled = true; reject(new Error('CDP 连接超时')) } }, 5000)
      this.ws.addEventListener('open', () => { if (!settled) { settled = true; clearTimeout(to); resolve() } })
      this.ws.addEventListener('message', (ev) => this._onMessage(ev.data))
      this.ws.addEventListener('error', () => { if (!settled) { settled = true; clearTimeout(to); reject(new Error('CDP 连接失败')) } })
      this.ws.addEventListener('close', () => {
        this.closed = true
        for (const { reject } of this.pending.values()) reject(new Error('CDP 已关闭'))
        this.pending.clear()
        this._emit('close', {})
      })
    })
  }
  _onMessage(data) {
    let text = data
    if (typeof text !== 'string') {
      try { text = Buffer.from(text).toString('utf8') } catch { return }
    }
    let msg
    try { msg = JSON.parse(text) } catch { return }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message || 'CDP error'))
      else resolve(msg.result)
    } else if (msg.method) {
      this._emit(msg.method, msg.params || {})
    }
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(fn)
  }
  _emit(method, params) {
    const arr = this.listeners.get(method)
    if (arr) for (const fn of arr) { try { fn(params) } catch {} }
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP 已关闭'))
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('CDP 超时: ' + method))
      }, 15000)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      try { this.ws.send(JSON.stringify({ id, method, params })) }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e) }
    })
  }
  close() {
    this.closed = true
    try { this.ws?.close() } catch {}
  }
}

function isAllowed(url, hosts) {
  try {
    const h = new URL(url).hostname
    return hosts.some((x) => h === x || h.endsWith('.' + x))
  } catch { return false }
}

function openConfigFile() {
  try {
    if (!fs.existsSync(configFile())) saveConfig(loadConfig())
    spawn('notepad.exe', [configFile()], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
  } catch (e) { log('打开配置文件失败: ' + e.message) }
}

export async function runWatcher({ port = DEFAULT_PORT, shouldStop = () => false, exitOnSteamClose } = {}) {
  const cfg = loadConfig()
  if (typeof exitOnSteamClose === 'boolean') cfg.exitOnSteamClose = exitOnSteamClose
  const translator = createTranslator(cfg, log)
  const sessions = new Map() // targetId -> { cdp }
  const ocrCache = new Map()  // 图片 URL -> { original, translated }
  let serial = Promise.resolve()
  const enqueue = (fn) => { serial = serial.then(fn).catch((e) => log('任务异常: ' + e.message)) }
  const sanitize = (c) => { const o = { ...c }; for (const k of Object.keys(o)) if (k.startsWith('_') || k === 'apiKey') delete o[k]; return o }

  let sawSteam = false
  let warnedNoPort = false
  const hinted = new Set()

  function render(cdp, ctx, type, payload) {
    const expr = `window.__satRender(${JSON.stringify(type)},${JSON.stringify(payload)})`
    const p = Number.isInteger(ctx) && ctx > 0
      ? cdp.send('Runtime.evaluate', { expression: expr, contextId: ctx })
      : cdp.send('Runtime.evaluate', { expression: expr })
    p.catch(() => {})
  }

  async function handleBinding(cdp, params) {
    if (params.name !== '__sat') return
    let msg
    try { msg = JSON.parse(params.payload) } catch { return }
    const ctx = params.executionContextId
    switch (msg.type) {
      case 'ready':
      case 'config:get':
        render(cdp, ctx, 'config', sanitize(cfg))
        break
      case 'config:set':
        Object.assign(cfg, msg.patch || {})
        saveConfig(cfg)
        render(cdp, ctx, 'config', sanitize(cfg))
        break
      case 'openConfig':
        openConfigFile()
        break
      case 'ocr': {
        const src = String(msg.src || '')
        if (!/^https?:\/\//.test(src)) break
        enqueue(async () => {
          try {
            let hit = ocrCache.get(src)
            if (!hit) {
              const original = (await ocrImage(src)).slice(0, 2000)
              let translated = ''
              if (original && /[A-Za-z]{3}/.test(original)) {
                const out = await translator.translate([original], { to: cfg.targetLang || 'zh-CN' })
                translated = out[0] || ''
              }
              hit = { original, translated }
              ocrCache.set(src, hit)
            }
            render(cdp, ctx, 'ocrResult', { reqId: msg.reqId, src, original: hit.original, translated: hit.translated })
          } catch (e) {
            log('OCR 失败: ' + e.message)
            render(cdp, ctx, 'ocrResult', { reqId: msg.reqId, src, translated: '' })
          }
        })
        break
      }
      case 'translate': {
        const texts = Array.isArray(msg.texts) ? msg.texts : []
        enqueue(async () => {
          try {
            const results = await Promise.race([
              translator.translate(texts, { to: cfg.targetLang || 'zh-CN' }),
              new Promise((_, rej) => setTimeout(() => rej(new Error('翻译超时')), 40000)),
            ])
            render(cdp, ctx, 'translate', { reqId: msg.reqId, results })
          } catch (e) {
            log('翻译失败: ' + e.message)
            render(cdp, ctx, 'translate', { reqId: msg.reqId, error: friendlyError(e) })
          }
        })
        break
      }
    }
  }

  async function connectTarget(t) {
    const cdp = new CDP(t.webSocketDebuggerUrl)
    await cdp.open()
    sessions.set(t.id, { cdp })
    cdp.on('close', () => { sessions.delete(t.id); log('目标关闭: ' + shorten(t.url)) })
    cdp.on('Runtime.bindingCalled', (p) => { handleBinding(cdp, p) })
    await cdp.send('Runtime.enable').catch(() => {})
    await cdp.send('Page.enable').catch(() => {})
    await cdp.send('Runtime.addBinding', { name: '__sat' }).catch(() => {})
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: AGENT_JS }).catch(() => {})
    await cdp.send('Runtime.evaluate', { expression: AGENT_JS }).catch(() => {})
    log('已注入: ' + shorten(t.url))
  }

  log('监听器启动，端口 ' + port)
  while (!shouldStop()) {
    try {
      const running = isSteamRunning()
      if (running) sawSteam = true
      const up = await debugPortUp(port)
      if (running && !up && !warnedNoPort) {
        warnedNoPort = true
        log('Steam 正在运行，但 CEF 调试端口未开启。请在 Steam 完全退出后重新启动（标记文件需在启动前存在）。')
      }
      if (running && up) hinted.clear()

      if (up) {
        const targets = await listTargets(port)
        const wanted = targets.filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl && isAllowed(t.url, cfg.allowedHosts))
        for (const t of wanted) {
          if (!sessions.has(t.id)) {
            connectTarget(t).catch((e) => { if (!hinted.has(t.id)) { hinted.add(t.id); log('注入失败 ' + shorten(t.url) + ': ' + e.message) } })
          }
        }
        const alive = new Set(wanted.map((t) => t.id))
        for (const [id, s] of sessions) {
          if (!alive.has(id)) { try { s.cdp.close() } catch {}; sessions.delete(id) }
        }
      } else {
        for (const [, s] of sessions) { try { s.cdp.close() } catch {} }
        sessions.clear()
      }

      if (!running && !up && sawSteam && cfg.exitOnSteamClose) {
        log('Steam 已关闭，退出监听器')
        break
      }
    } catch (e) { log('循环异常: ' + e.message) }
    await sleep(1500)
  }

  for (const [, s] of sessions) { try { s.cdp.close() } catch {} }
  translator.close()
  log('监听器已停止')
}

function friendlyError(e) {
  const m = String(e?.message || e)
  if (/apiKey|401|403|openai/i.test(m)) return '需要配置 API Key（设置文件里填 provider/apiKey，或使用免费源）'
  if (/captcha|验证码/i.test(m)) return '免费翻译源被限流，请在设置里配置 DeepSeek 等 API Key'
  if (/quota|额度|WARNING|限流/i.test(m)) return '免费额度已用尽/限流，请配置 API Key'
  return m.length > 120 ? m.slice(0, 120) + '…' : m
}

function shorten(u) { try { const x = new URL(u); return x.hostname + x.pathname.slice(0, 40) } catch { return String(u).slice(0, 50) } }
