// 翻译服务：Bing / LibreTranslate / Google / MyMemory / OpenAI 兼容 + 磁盘缓存 + 限速
import fs from 'node:fs'
import path from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export class ProviderError extends Error {
  constructor(msg, kind) { super(msg); this.kind = kind || 'error' }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------- 缓存 ----------------
export class Cache {
  constructor(file, maxEntries = 20000) {
    this.file = file
    this.max = maxEntries
    this.map = new Map()
    this.dirty = false
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (j && typeof j === 'object') for (const [k, v] of Object.entries(j)) this.map.set(k, v)
    } catch {}
    this.timer = setInterval(() => this.flush(), 4000)
    this.timer.unref?.()
  }
  key(to, text) { return to + '\u0000' + text }
  get(to, text) { return this.map.get(this.key(to, text)) }
  set(to, text, result) {
    this.map.set(this.key(to, text), result)
    this.dirty = true
    if (this.map.size > this.max) {
      const drop = this.map.size - this.max
      let i = 0
      for (const k of this.map.keys()) { this.map.delete(k); if (++i >= drop) break }
    }
  }
  flush() {
    if (!this.dirty) return
    try {
      const obj = {}
      for (const [k, v] of this.map) obj[k] = v
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(obj), 'utf8')
      this.dirty = false
    } catch {}
  }
  close() { clearInterval(this.timer); this.flush() }
}

// ---------------- 各提供方 ----------------
async function googleFreeOne(text, to) {
  const tl = to === 'zh-CN' ? 'zh-CN' : to
  const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text)}`
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' }, signal: AbortSignal.timeout(12000) })
  const body = await r.text()
  if (!body) throw new ProviderError('google 空响应', 'empty')
  if (body.trimStart().startsWith('<')) throw new ProviderError('google 触发验证码（免费额度用尽，请在设置中配置 API Key）', 'captcha')
  let j
  try { j = JSON.parse(body) } catch { throw new ProviderError('google 返回无法解析', 'parse') }
  if (typeof j === 'string') return j
  if (Array.isArray(j)) {
    if (typeof j[0] === 'string') return j[0]
    if (Array.isArray(j[0]) && typeof j[0][0] === 'string') return j[0][0]
  }
  throw new ProviderError('google 返回结构未知', 'parse')
}

async function libreOne(text, to, base) {
  const url = (base || 'https://translate.tedomum.net') + '/translate'
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q: text, source: 'en', target: to === 'zh-CN' ? 'zh' : to, format: 'text' }),
    signal: AbortSignal.timeout(15000),
  })
  if (r.status === 429) throw new ProviderError('libre 触发限流', 'quota')
  if (!r.ok) throw new ProviderError('libre ' + r.status, 'http')
  const j = await r.json().catch(() => ({}))
  if (!j.translatedText) throw new ProviderError('libre 无结果', 'empty')
  return j.translatedText
}

// 多段批量：用换行拼接，LibreTranslate 会保留行，一次请求翻多段
async function libreBatch(texts, to, base) {
  const clean = texts.map((t) => String(t).replace(/\s+/g, ' ').trim())
  if (clean.some((t) => !t)) throw new ProviderError('批量含空文本', 'empty')
  const q = clean.join('\n')
  if (q.length > 4200) {
    if (clean.length === 1) throw new ProviderError('单段过长', 'too_long')
    const mid = Math.ceil(clean.length / 2)
    const a = await libreBatch(texts.slice(0, mid), to, base)
    const b = await libreBatch(texts.slice(mid), to, base)
    return [...a, ...b]
  }
  const url = (base || 'https://translate.tedomum.net') + '/translate'
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q, source: 'en', target: to === 'zh-CN' ? 'zh' : to, format: 'text' }),
    signal: AbortSignal.timeout(20000),
  })
  if (r.status === 429) throw new ProviderError('libre 触发限流', 'quota')
  if (!r.ok) throw new ProviderError('libre ' + r.status, 'http')
  const j = await r.json().catch(() => ({}))
  if (!j.translatedText) throw new ProviderError('libre 无结果', 'empty')
  const lines = j.translatedText.split('\n').map((s) => s.trim())
  if (lines.length !== texts.length) throw new ProviderError('批量行数不匹配(' + lines.length + '/' + texts.length + ')', 'parse')
  return lines
}

// ---------- Bing 翻译（免费，质量好，支持换行批量） ----------
let bingSession = null
async function getBingSession(force) {
  if (!force && bingSession && bingSession.expires > Date.now()) return bingSession
  const r = await fetch('https://www.bing.com/translator', { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }, signal: AbortSignal.timeout(15000) })
  const html = await r.text()
  const cookies = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ')
  const ig = html.match(/IG:"([^"]+)"/)?.[1]
  const iid = html.match(/data-iid="([^"]+)"/)?.[1]
  const tok = html.match(/params_AbusePreventionHelper\s*=\s*\[([^\]]+)\]/)?.[1]
  if (!ig || !iid || !tok) throw new ProviderError('bing 初始化失败', 'init')
  const parts = tok.split(',').map((s) => s.trim().replace(/^"|"$/g, ''))
  bingSession = { cookies, ig, iid, key: parts[0], token: parts[1], expires: Date.now() + 40 * 60 * 1000 }
  return bingSession
}

async function bingPost(sess, text, toLang) {
  const body = new URLSearchParams({ fromLang: 'auto-detect', to: toLang, text, token: sess.token, key: sess.key })
  const r = await fetch(`https://www.bing.com/ttranslatev3?isVertical=1&IG=${sess.ig}&IID=${sess.iid}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA, referer: 'https://www.bing.com/translator', cookie: sess.cookies },
    body,
    signal: AbortSignal.timeout(20000),
  })
  if (!r.ok) throw new ProviderError('bing ' + r.status, 'http')
  const j = await r.json().catch(() => null)
  const arr = Array.isArray(j) ? j : [j]
  const obj = arr[0]
  if (obj && (obj.statusCode || obj.errorMessage)) throw new ProviderError('bing ' + (obj.statusCode || '') + ' ' + (obj.errorMessage || ''), 'http')
  const t = obj && obj.translations && obj.translations[0] && obj.translations[0].text
  if (!t) throw new ProviderError('bing 无结果', 'empty')
  return t
}

async function bingBatch(texts, to) {
  const clean = texts.map((t) => String(t).replace(/\s+/g, ' ').trim())
  if (clean.some((t) => !t)) throw new ProviderError('批量含空文本', 'empty')
  const joined = clean.join('\n')
  // Bing 对多段长文本有隐藏上限（约 1000 字/多段会 400），超过就拆分
  if (clean.length > 1 && (clean.length > 4 || joined.length > 800)) {
    const mid = Math.ceil(clean.length / 2)
    const a = await bingBatch(texts.slice(0, mid), to)
    const b = await bingBatch(texts.slice(mid), to)
    return [...a, ...b]
  }
  const toLang = to === 'zh-CN' ? 'zh-Hans' : to
  let sess = await getBingSession(false)
  let out
  try { out = await bingPost(sess, joined, toLang) }
  catch (e) { sess = await getBingSession(true); out = await bingPost(sess, joined, toLang) }
  const lines = out.split('\n').map((s) => s.trim())
  if (lines.length !== clean.length) {
    if (clean.length > 1) {
      const mid = Math.ceil(clean.length / 2)
      const a = await bingBatch(texts.slice(0, mid), to)
      const b = await bingBatch(texts.slice(mid), to)
      return [...a, ...b]
    }
    throw new ProviderError('bing 行数不匹配(' + lines.length + '/' + clean.length + ')', 'parse')
  }
  return lines
}

async function mymemoryOne(text, to) {
  const lp = `en|${to === 'zh-CN' ? 'zh-CN' : to}`
  const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 500))}&langpair=${lp}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) })
  const j = await r.json()
  const t = j?.responseData?.translatedText
  if (!t) throw new ProviderError('mymemory 无结果：' + (j?.responseDetails || ''), 'empty')
  if (/MYMEMORY WARNING/i.test(t)) throw new ProviderError('mymemory 免费额度已用尽', 'quota')
  return t
}

async function openaiBatch(texts, cfg) {
  const base = (cfg.baseURL || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
  const body = {
    model: cfg.model || 'deepseek-chat',
    temperature: 0,
    messages: [
      { role: 'system', content: 'You are a professional translation engine. Translate each item of the input JSON array into Simplified Chinese. Preserve game titles, proper nouns, numbers, placeholders and punctuation. Return ONLY a JSON object {"t":[...]} whose array has the same length and order as the input. Never merge or drop items.' },
      { role: 'user', content: JSON.stringify({ t: texts }) },
    ],
    response_format: { type: 'json_object' },
  }
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  })
  if (!r.ok) throw new ProviderError(`openai ${r.status}: ${(await r.text()).slice(0, 200)}`, 'http')
  const j = await r.json()
  const content = j?.choices?.[0]?.message?.content || ''
  let parsed
  try { parsed = JSON.parse(content) } catch { throw new ProviderError('模型返回非 JSON', 'parse') }
  const arr = parsed.t || parsed.translations || parsed.result
  if (!Array.isArray(arr) || arr.length !== texts.length) throw new ProviderError('模型返回条数不匹配', 'parse')
  return arr.map((x) => (typeof x === 'string' ? x : String(x)))
}

// ---------------- 统一入口 ----------------
export function createTranslator(config, log = () => {}) {
  const cache = new Cache(config._cacheFile)
  let lastCall = 0
  const minGap = config.minGapMs ?? 500

  async function translateOne(text, to) {
    const cached = cache.get(to, text)
    if (cached !== undefined) return cached
    const prov = config.provider || 'auto'
    const useOpenAI = prov === 'openai' || (prov === 'auto' && config.apiKey)
    if (useOpenAI) return null
    const chain = prov === 'mymemory' ? ['mymemory']
      : prov === 'googleFree' ? ['googleFree', 'libre', 'mymemory']
      : ['bing', 'libre', 'googleFree', 'mymemory']
    let lastErr
    for (const name of chain) {
      try {
        const gap = Date.now() - lastCall
        if (gap < minGap) await sleep(minGap - gap)
        lastCall = Date.now()
        const call = () => name === 'bing' ? bingBatch([text], to).then((a) => a[0])
          : name === 'libre' ? libreOne(text, to, config.libreURL)
          : name === 'googleFree' ? googleFreeOne(text, to)
          : mymemoryOne(text, to)
        let res
        for (let attempt = 0; ; attempt++) {
          try { res = await call(); break } catch (e) {
            const retryable = e.kind === 'quota' || e.kind === 'http'
            if (retryable && attempt < 2) { await sleep(3000 * (attempt + 1)); continue }
            throw e
          }
        }
        cache.set(to, text, res)
        return res
      } catch (e) { lastErr = e; log(`[${name}] ${e.message}`) }
    }
    throw lastErr || new ProviderError('没有可用翻译源', 'none')
  }

  return {
    async translate(texts, { to = 'zh-CN' } = {}) {
      if (config.provider === 'mock') return texts.map((t) => '【译】' + t)
      const results = new Array(texts.length).fill(undefined)
      const missing = []
      for (let i = 0; i < texts.length; i++) {
        const c = cache.get(to, texts[i])
        if (c !== undefined) results[i] = c; else missing.push(i)
      }
      if (!missing.length) return results
      const missingTexts = missing.map((i) => texts[i])
      const useOpenAI = config.provider === 'openai' || ((config.provider === 'auto' || !config.provider) && config.apiKey)

      if (useOpenAI) {
        const B = config.batchSize || 25
        for (let i = 0; i < missingTexts.length; i += B) {
          const part = missingTexts.slice(i, i + B)
          const out = await openaiBatch(part, config)
          out.forEach((t, k) => { results[missing[i + k]] = t; cache.set(to, part[k], t) })
        }
        return results
      }

      // 1) 免费源优先批量：Bing（质量最好）→ Libre（兜底）
      if (config.provider !== 'mymemory') {
        const B = config.bingBatchSize || 12
        const CONC = Math.max(1, Math.min(4, config.bingConcurrency || 2))
        const chunks = []
        for (let i = 0; i < missingTexts.length; i += B) {
          chunks.push({ idxs: missing.slice(i, i + B), part: missingTexts.slice(i, i + B) })
        }
        let bingBroken = false
        for (let i = 0; i < chunks.length && !bingBroken; i += CONC) {
          const group = chunks.slice(i, i + CONC)
          const outs = await Promise.all(group.map(async (ch) => {
            try { return await bingBatch(ch.part, to) }
            catch (e) { log(`[bing-batch] ${e.message}`); bingBroken = true; return null }
          }))
          for (let g = 0; g < group.length; g++) {
            const out = outs[g]
            if (!out) continue
            group[g].idxs.forEach((gi, k) => { results[gi] = out[k]; cache.set(to, texts[gi], out[k]) })
          }
        }
        const rem = missing.filter((gi) => results[gi] === undefined)
        for (let i = 0; i < rem.length; i += 15) {
          const idxs = rem.slice(i, i + 15)
          const part = idxs.map((gi) => texts[gi])
          try {
            const gap = Date.now() - lastCall
            if (gap < minGap) await sleep(minGap - gap)
            lastCall = Date.now()
            const out = await libreBatch(part, to, config.libreURL)
            idxs.forEach((gi, k) => { results[gi] = out[k]; cache.set(to, texts[gi], out[k]) })
          } catch (e) { log(`[libre-batch] ${e.message}`); break }
        }
        if (missing.every((i) => results[i] !== undefined)) return results
      }

      // 2) 剩余逐条翻译（含 Google/MyMemory 后备）
      let fail = 0, firstErr = null, stillMissing = 0
      for (let k = 0; k < missingTexts.length; k++) {
        const idx = missing[k]
        if (results[idx] !== undefined) continue
        stillMissing++
        try { results[idx] = await translateOne(missingTexts[k], to) }
        catch (e) { results[idx] = ''; fail++; firstErr = firstErr || e }
      }
      if (fail > 0 && fail === stillMissing && stillMissing === missingTexts.length && firstErr) throw firstErr
      return results.map((v) => (v === undefined ? '' : v))
    },
    flush: () => cache.flush(),
    close: () => cache.close(),
  }
}
