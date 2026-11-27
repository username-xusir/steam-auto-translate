/* Steam 自动翻译 - 页面内代理脚本（由 CDP 注入，运行在 Steam 内置浏览器页面）
   注意：Steam 商店页对文本做了反抓取处理，凡在页面里用 \s 正则处理文本会抹掉字母 s。
   因此这里所有空白归一化都用字符码手写，不用正则。 */
(function () {
  if (window.__SAT_INSTALLED) return
  window.__SAT_INSTALLED = true

  var HOST = location.hostname
  function hostMatches(h, d) { return h === d || (h.length > d.length && h.slice(-(d.length + 1)) === '.' + d) }
  var isSteam = hostMatches(HOST, 'steampowered.com') || hostMatches(HOST, 'steamcommunity.com')
  var isLocal = HOST === '127.0.0.1' || HOST === 'localhost'
  if (!isSteam && !isLocal) return

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, CODE: 1, PRE: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, SVG: 1, CANVAS: 1, IFRAME: 1, BUTTON: 1, VIDEO: 1, AUDIO: 1, HEAD: 1, META: 1, LINK: 1 }
  var INLINE_TAGS = { A: 1, SPAN: 1, STRONG: 1, EM: 1, B: 1, I: 1, U: 1, S: 1, SMALL: 1, BR: 1, IMG: 1, CODE: 1, SUP: 1, SUB: 1, MARK: 1, LABEL: 1, FONT: 1, WBR: 1 }
  var CHROME_CLASS = ['responsive_page_menu', 'supernav', 'apphub_HeaderTop', 'mainmenu', 'menuitem']

  // ---------- 安全文本处理（不依赖正则） ----------
  function isSpaceCode(c) { return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 160 || c === 0x2028 || c === 0x2029 }
  function norm(s) {
    if (!s) return ''
    var out = '', pendingSpace = false, started = false
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i)
      if (isSpaceCode(c)) { if (started) pendingSpace = true }
      else { if (pendingSpace) { out += ' '; pendingSpace = false } out += s.charAt(i); started = true }
    }
    return out
  }
  function hasLatin(t) {
    var n = 0
    for (var i = 0; i < t.length; i++) {
      var c = t.charCodeAt(i)
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { if (++n >= 2) return true } else n = 0
    }
    return false
  }
  function hasNonSpace(t) {
    for (var i = 0; i < t.length; i++) { if (!isSpaceCode(t.charCodeAt(i))) return true }
    return false
  }
  // 遍历文本节点取原文（nodeValue 未被反抓取篡改）
  function textOf(el, skipBlocks) {
    var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null)
    var out = '', n
    while ((n = w.nextNode())) {
      var pe = n.parentElement
      if (pe && (pe.classList.contains('sat-tr') || pe.id === '__sat_host')) continue
      if (skipBlocks) {
        var blocked = false
        for (var p = pe; p && p !== el; p = p.parentElement) {
          if (!INLINE_TAGS[p.tagName]) { blocked = true; break }
        }
        if (blocked) continue
      }
      out += n.nodeValue + ' '
    }
    return norm(out)
  }

  var state = {
    enabled: true,
    busy: false,
    config: null,
    queue: [],
    sent: new WeakSet(),
    done: new WeakSet(),
    textCache: new Map(),
    reqSeq: 0,
    pending: new Map(),
    observer: null,
    scanTimer: null,
    flushTimer: null,
    inserted: 0,
    maxSegments: 200,
    scanning: false,
    cooldownUntil: 0,
    displayMode: 'replace',
    imgSent: new WeakSet(),
    imgSeq: 0,
    imageOcrEnabled: true
  }

  function send(msg) { try { window.__sat(JSON.stringify(msg)) } catch (e) {} }

  window.__satRender = function (type, payload) {
    try {
      if (type === 'config') { state.config = payload; applyConfig() }
      else if (type === 'translate') onTranslated(payload)
      else if (type === 'ocrResult') onOcr(payload)
      else if (type === 'status') setStatus((payload && payload.text) || '')
      else if (type === 'toast') setStatus((payload && payload.text) || '', true)
    } catch (e) {}
  }

  function applyConfig() {
    var c = state.config || {}
    if (typeof c.autoTranslate === 'boolean') state.enabled = c.autoTranslate
    if (typeof c.maxSegments === 'number') state.maxSegments = Math.max(10, Math.min(500, c.maxSegments))
    if (typeof c.displayMode === 'string') state.displayMode = c.displayMode
    if (typeof c.imageOcr === 'boolean') state.imageOcrEnabled = c.imageOcr
    if (autoChk) autoChk.checked = state.enabled
    if (modeSel) modeSel.value = state.displayMode
    updateButton()
    applyModeAll()
    if (state.enabled) scan()
    else clearAll()
  }

  // ---------------- UI ----------------
  var hostEl = null, btn = null, panel = null, statusEl = null, shadow = null, autoChk = null, modeSel = null
  function buildUI() {
    hostEl = document.createElement('div')
    hostEl.id = '__sat_host'
    hostEl.style.cssText = 'position:fixed;z-index:2147483647;right:14px;bottom:14px;font:13px/1.4 system-ui,"Microsoft YaHei",sans-serif;'
    shadow = hostEl.attachShadow({ mode: 'open' })
    shadow.innerHTML =
      '<style>:host{all:initial}' +
      '.btn{width:44px;height:44px;border-radius:50%;border:none;cursor:pointer;background:#1a9fff;color:#fff;font-size:17px;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.35);opacity:.85}' +
      '.btn.off{background:#5a5a5a}.btn.busy{animation:pulse 1s infinite}' +
      '@keyframes pulse{0%,100%{opacity:.55}50%{opacity:1}}' +
      '.panel{position:absolute;right:0;bottom:54px;width:262px;background:#1b2838;color:#c7d5e0;border-radius:10px;padding:12px;box-shadow:0 8px 30px rgba(0,0,0,.5);display:none}' +
      '.panel.open{display:block}.row{display:flex;justify-content:space-between;align-items:center;margin:8px 0}' +
      '.t{font-weight:600;color:#fff;margin-bottom:6px}.status{font-size:12px;color:#8f98a0;min-height:16px;margin-top:6px;word-break:break-all}' +
      '.link{color:#66c0f4;cursor:pointer;text-decoration:underline;font-size:12px}' +
      'select{background:#2a3f5a;color:#fff;border:1px solid #3a5a7a;border-radius:5px;padding:3px 6px}</style>' +
      '<button class="btn" id="b" title="Steam 自动翻译">译</button>' +
      '<div class="panel" id="p"><div class="t">Steam 自动翻译</div>' +
      '<div class="row"><span>自动翻译</span><input type="checkbox" id="auto"></div>' +
      '<div class="row"><span>显示</span><select id="mode"><option value="bilingual">原文+译文</option><option value="replace">仅译文</option></select></div>' +
      '<div class="row"><span class="link" id="cfg">打开设置文件</span><span class="link" id="retry">重译</span></div>' +
      '<div class="status" id="s"></div></div>'
    document.documentElement.appendChild(hostEl)
    btn = shadow.getElementById('b'); panel = shadow.getElementById('p'); statusEl = shadow.getElementById('s'); autoChk = shadow.getElementById('auto')
    btn.addEventListener('click', function (e) { e.stopPropagation(); panel.classList.toggle('open') })
    autoChk.addEventListener('change', function () {
      state.enabled = autoChk.checked
      send({ type: 'config:set', patch: { autoTranslate: autoChk.checked } })
      updateButton()
      if (state.enabled) scan(); else clearAll()
    })
    modeSel = shadow.getElementById('mode')
    modeSel.value = state.displayMode
    modeSel.addEventListener('change', function () {
      state.displayMode = modeSel.value
      send({ type: 'config:set', patch: { displayMode: modeSel.value } })
      applyModeAll()
    })
    shadow.getElementById('cfg').addEventListener('click', function () { send({ type: 'openConfig' }) })
    shadow.getElementById('retry').addEventListener('click', function () {
      state.done = new WeakSet(); state.sent = new WeakSet(); clearAll(); scan()
    })
    autoChk.checked = state.enabled
    updateButton()
  }
  function updateButton() {
    if (!btn) return
    btn.textContent = state.enabled ? '译' : '关'
    btn.className = 'btn' + (state.enabled ? '' : ' off') + (state.busy ? ' busy' : '')
  }
  function setStatus(text, toast) {
    if (statusEl) statusEl.textContent = text || ''
    if (toast && btn) btn.title = text
  }
  function clearAll() {
    document.querySelectorAll('.sat-orig').forEach(function (w) {
      var p = w.parentNode
      if (!p) return
      while (w.firstChild) p.insertBefore(w.firstChild, w)
      w.remove()
    })
    document.querySelectorAll('.sat-tr').forEach(function (n) { n.remove() })
    document.querySelectorAll('.sat-imgtr').forEach(function (n) { n.remove() })
    document.querySelectorAll('[data-sat-done],[data-sat-self]').forEach(function (n) { n.removeAttribute('data-sat-done'); n.removeAttribute('data-sat-self') })
    document.querySelectorAll('img').forEach(function (n) { n.__satOcrDone = false })
    state.imgSent = new WeakSet()
    state.inserted = 0
    setStatus('')
  }

  // ---------------- 采集 ----------------
  function insideSkipped(el) {
    for (var p = el; p; p = p.parentElement) {
      if (SKIP_TAGS[p.tagName]) return true
      if (p.id === '__sat_host') return true
      if (p.hasAttribute && p.hasAttribute('data-sat-skip')) return true
      if (p.hasAttribute && p.hasAttribute('data-sat-done')) return true
      if (p.classList && p.classList.contains('sat-tr')) return true
      if (p.tagName === 'NAV' || p.tagName === 'HEADER' || p.tagName === 'FOOTER' || p.tagName === 'ASIDE') return true
      if (p.id === 'global_header' || p.id === 'footer' || p.id === 'responsive_page_menu' || p.id === 'responsive_page_local_menu') return true
      if (p.getAttribute && p.getAttribute('role') === 'navigation') return true
      if (p.className && typeof p.className === 'string') {
        for (var i = 0; i < CHROME_CLASS.length; i++) { if (p.className.indexOf(CHROME_CLASS[i]) >= 0) return true }
      }
    }
    return false
  }
  function contentScore(el) {
    var p = el
    for (var i = 0; i < 6 && p; i++, p = p.parentElement) {
      var s = ((p.id || '') + ' ' + (typeof p.className === 'string' ? p.className : '')).toLowerCase()
      if (s.indexOf('game_area_description') >= 0 || s.indexOf('workshopitemdescription') >= 0 ||
        s.indexOf('workshopitemshortdesc') >= 0 || s.indexOf('commentthread_comment_text') >= 0 ||
        s.indexOf('user_review') >= 0 || s.indexOf('reviewtext') >= 0 || s.indexOf('apphub_appname') >= 0 ||
        s.indexOf('workshopitemtitle') >= 0 || s.indexOf('news_post') >= 0 || s.indexOf('announcement') >= 0 ||
        s.indexOf('game_area_dlc_name') >= 0) return 3
      if (p.tagName === 'ARTICLE') return 3
    }
    var t = el.tagName
    if (t === 'P' || t === 'H1' || t === 'H2' || t === 'H3' || t === 'H4' || t === 'LI' || t === 'BLOCKQUOTE' || t === 'TD') return 2
    return 1
  }
  function blockChildHasText(el) {
    var kids = el.children
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i]
      if (c.classList && c.classList.contains('sat-orig')) continue
      if (INLINE_TAGS[c.tagName]) continue
      if (hasNonSpace(textOf(c))) return true
    }
    return false
  }

  function collect() {
    if (!document.body) return []
    var out = []
    var all = document.body.getElementsByTagName('*')
    for (var i = 0; i < all.length && out.length < state.maxSegments * 4; i++) {
      var el = all[i]
      if (SKIP_TAGS[el.tagName]) continue
      if (state.sent.has(el) || state.done.has(el)) continue
      if (insideSkipped(el)) continue
      // 直接文本节点（nodeValue 未被篡改）
      var direct = '', hasTextNode = false
      for (var k = 0; k < el.childNodes.length; k++) {
        var n = el.childNodes[k]
        if (n.nodeType === 3) { direct += ' ' + n.nodeValue; hasTextNode = true }
      }
      if (!hasTextNode) continue
      direct = norm(direct)
      if (direct.length < 3 || direct.length > 3000) continue
      if (!hasLatin(direct)) continue
      var selfOnly = blockChildHasText(el) // 元素内有「带文字的块级子元素」→ 只翻自身零散文字
      var full = textOf(el, selfOnly)      // selfOnly 时排除块级子元素
      if (full.length < 3 || full.length > 3500) continue
      if (!hasLatin(full)) continue
      if (!selfOnly && full.length > direct.length * 2 + 120) continue
      out.push({ el: el, score: contentScore(el), text: full, self: selfOnly })
    }
    out.sort(function (a, b) { return b.score - a.score })
    // 只对「整块」候选做最外层过滤；self 候选保留，内部块级元素继续各自翻译
    var blockSet = new Set()
    for (var i2 = 0; i2 < out.length; i2++) if (!out[i2].self) blockSet.add(out[i2].el)
    var filtered = []
    for (var i3 = 0; i3 < out.length; i3++) {
      var c = out[i3]
      if (c.self) { filtered.push(c); continue }
      var isInner = false
      for (var pa = c.el.parentElement; pa; pa = pa.parentElement) { if (blockSet.has(pa)) { isInner = true; break } }
      if (!isInner) filtered.push(c)
    }
    return filtered
  }

  // ---------------- 图片 OCR ----------------
  function scanImages() {
    if (!state.enabled || !state.imageOcrEnabled) return
    if (state.imgSeq >= 25) return
    var imgs = document.querySelectorAll('img')
    var n = 0
    for (var i = 0; i < imgs.length && n < 12; i++) {
      var img = imgs[i]
      if (state.imgSent.has(img)) continue
      var src = img.currentSrc || img.src || ''
      if (!/(steamusercontent|steamstatic|ugc)/.test(src)) continue
      var w = img.naturalWidth || img.width || 0
      if (w < 300) continue
      if (!img.closest('.workshopItemDescription, #highlightContent, .game_area_description, .bb_paragraph, article')) continue
      state.imgSent.add(img)
      n++
      send({ type: 'ocr', reqId: ++state.imgSeq, src: src })
    }
  }
  function onOcr(p) {
    if (!p || !p.translated || !p.src) return
    var imgs = document.querySelectorAll('img')
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i]
      if ((img.currentSrc || img.src) !== p.src) continue
      if (img.__satOcrDone) continue
      img.__satOcrDone = true
      var cap = document.createElement('div')
      cap.className = 'sat-imgtr'
      cap.textContent = p.translated
      cap.title = p.original || ''
      cap.style.cssText = 'margin:6px 0 14px;padding:8px 10px;background:rgba(16,32,48,.82);border-left:3px solid #1a9fff;border-radius:4px;color:#cfe6f5;font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif;white-space:pre-wrap;'
      var anchor = img.closest('a') || img
      var pn = anchor.parentNode
      if (pn) pn.insertBefore(cap, anchor.nextSibling)
      break
    }
  }

  // ---------------- 翻译 ----------------
  function scan() {
    if (!state.enabled || state.scanning) return
    scanImages()
    if (Date.now() < state.cooldownUntil) return
    state.scanning = true
    try {
      var cands = collect()
      var n = 0
      for (var i = 0; i < cands.length && n < state.maxSegments; i++) {
        var el = cands[i].el
        if (state.sent.has(el) || state.done.has(el)) continue
        var text = cands[i].text
        if (!text || !hasLatin(text)) continue
        state.sent.add(el)
        n++
        var hit = state.textCache.get(text)
        if (hit !== undefined) { insert(el, hit, cands[i].self) }
        else { state.queue.push({ el: el, text: text, self: cands[i].self }) }
      }
      if (state.queue.length) scheduleFlush()
    } finally { state.scanning = false }
  }

  function scheduleFlush() {
    if (state.flushTimer) return
    state.flushTimer = setTimeout(function () { state.flushTimer = null; flush() }, 200)
  }

  function flush() {
    if (!state.queue.length || !state.enabled) return
    var batch = [], chars = 0
    while (state.queue.length && batch.length < 24 && chars < 3200) {
      var it = state.queue.shift()
      if (state.done.has(it.el)) continue
      batch.push(it); chars += it.text.length
    }
    if (!batch.length) return
    var reqId = ++state.reqSeq
    state.pending.set(reqId, batch)
    state.busy = true; updateButton()
    setStatus('翻译中… 待翻译 ' + (state.queue.length + batch.length) + ' 段')
    send({ type: 'translate', reqId: reqId, texts: batch.map(function (x) { return x.text }) })
    // 兜底：40s 内没收到结果就放开重试，避免永久卡在「翻译中」
    setTimeout(function () {
      if (!state.pending.has(reqId)) return
      state.pending.delete(reqId)
      batch.forEach(function (it) { state.sent.delete(it.el) })
      state.busy = false; updateButton()
      state.cooldownUntil = Date.now() + 15000
      setStatus('翻译超时，稍后自动重试', true)
    }, 40000)
  }

  function onTranslated(payload) {
    if (!payload) return
    var batch = state.pending.get(payload.reqId)
    if (!batch) return
    state.pending.delete(payload.reqId)
    if (payload.error) {
      state.busy = false; updateButton()
      batch.forEach(function (it) { state.sent.delete(it.el) })
      state.cooldownUntil = Date.now() + 15000
      setStatus('翻译失败：' + payload.error, true)
      return
    }
    var results = payload.results || []
    var failed = 0
    for (var i = 0; i < batch.length; i++) {
      var t = results[i]
      if (!t) { state.sent.delete(batch[i].el); failed++; continue }
      state.textCache.set(batch[i].text, t)
      insert(batch[i].el, t, batch[i].self)
    }
    if (failed) {
      state.cooldownUntil = Date.now() + 10000
      state.busy = false; updateButton()
      setStatus('已翻译 ' + state.inserted + ' 段，' + failed + ' 段被限流，稍后自动重试', true)
      return
    }
    if (state.queue.length) scheduleFlush()
    else { state.busy = false; updateButton(); setStatus(state.inserted ? '已翻译 ' + state.inserted + ' 段' : '没有可翻译的内容') }
  }

  function applyMode(el) {
    var mode = state.displayMode || 'replace'
    var orig = null, tr = null
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i]
      if (c.classList.contains('sat-orig')) orig = c
      else if (c.classList.contains('sat-tr')) tr = c
    }
    if (orig) orig.style.display = mode === 'replace' ? 'none' : 'contents'
    if (tr) {
      tr.style.cssText = mode === 'replace'
        ? 'display:inline;color:inherit;font:inherit;white-space:normal;'
        : 'display:block;margin-top:.3em;padding-left:.55em;border-left:2px solid #1a9fff;color:#9fc6e0;font-size:.95em;line-height:1.5;white-space:normal;'
    }
  }
  function applyModeAll() {
    var els = document.querySelectorAll('[data-sat-done],[data-sat-self]')
    for (var i = 0; i < els.length; i++) applyMode(els[i])
  }
  function insert(el, translated, self) {
    if (!el || !el.isConnected || state.done.has(el)) return
    if (!translated || !hasNonSpace(translated)) return
    // 把文字节点和内联元素包进 .sat-orig（display:contents 不破坏布局），译文单独一个 span
    var orig = document.createElement('span')
    orig.className = 'sat-orig'
    orig.style.display = 'contents'
    var nodes = Array.prototype.slice.call(el.childNodes)
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i]
      if (nd.nodeType === 1 && !INLINE_TAGS[nd.tagName]) continue
      orig.appendChild(nd)
    }
    // 放到第一个块级子元素之前，尽量保持原文位置
    var firstBlock = null
    for (var j = 0; j < el.children.length; j++) {
      var ch = el.children[j]
      if (!INLINE_TAGS[ch.tagName]) { firstBlock = ch; break }
    }
    if (firstBlock) el.insertBefore(orig, firstBlock)
    else el.appendChild(orig)
    var span = document.createElement('span')
    span.className = 'sat-tr'
    span.setAttribute('data-sat-tr', '1')
    span.textContent = translated
    if (orig.nextSibling) el.insertBefore(span, orig.nextSibling)
    else el.appendChild(span)
    if (self) el.setAttribute('data-sat-self', '1')
    else el.setAttribute('data-sat-done', '1')
    state.done.add(el)
    state.inserted++
    applyMode(el)
  }

  // ---------------- 启动 ----------------
  function init() {
    buildUI()
    send({ type: 'ready', href: location.href })
    setTimeout(function () { if (!state.config) { state.enabled = true; updateButton(); scan() } }, 1200)
    state.observer = new MutationObserver(function () {
      if (state.scanTimer) return
      state.scanTimer = setTimeout(function () { state.scanTimer = null; scan() }, 900)
    })
    state.observer.observe(document.documentElement, { childList: true, subtree: true })
    setInterval(function () {
      if (state.enabled && !state.busy && !state.queue.length) scan()
    }, 8000)
    var scrollTimer = null
    window.addEventListener('scroll', function () {
      if (scrollTimer) return
      scrollTimer = setTimeout(function () { scrollTimer = null; scan() }, 700)
    }, { passive: true })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
