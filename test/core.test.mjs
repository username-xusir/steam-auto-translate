import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-test-'))
process.env.SAT_CONFIG_DIR = TMP

const { enableCefDebug, disableCefDebug, debugFileEnabled, getSteamPath, isSteamRunning } = await import('../src/steam.mjs')
const { createTranslator, Cache } = await import('../src/translate.mjs')
const { loadConfig, saveConfig, configFile } = await import('../src/config.mjs')

test('CEF 调试标记文件：创建 / 检测 / 删除', () => {
  const steamDir = fs.mkdtempSync(path.join(TMP, 'steam-'))
  assert.equal(debugFileEnabled(steamDir), false)
  enableCefDebug(steamDir)
  assert.equal(debugFileEnabled(steamDir), true)
  assert.ok(fs.existsSync(path.join(steamDir, '.cef-enable-remote-debugging')))
  disableCefDebug(steamDir)
  assert.equal(debugFileEnabled(steamDir), false)
})

test('Steam 定位与进程检测不抛异常', () => {
  const p = getSteamPath()
  assert.ok(p === null || typeof p === 'string')
  assert.equal(typeof isSteamRunning(), 'boolean')
})

test('mock 翻译源按序返回', async () => {
  const t = createTranslator({ provider: 'mock', _cacheFile: path.join(TMP, 'c1.json') }, () => {})
  const out = await t.translate(['hello', 'world'], { to: 'zh-CN' })
  assert.deepEqual(out, ['【译】hello', '【译】world'])
  t.close()
})

test('缓存可持久化并复用', () => {
  const f = path.join(TMP, 'cache-x.json')
  const c1 = new Cache(f)
  c1.set('zh-CN', 'hello', '你好')
  c1.close()
  const c2 = new Cache(f)
  assert.equal(c2.get('zh-CN', 'hello'), '你好')
  c2.close()
})

test('配置读写：默认值合并与落盘', () => {
  const cfg = loadConfig()
  assert.equal(cfg.targetLang, 'zh-CN')
  cfg.targetLang = 'ja'
  saveConfig(cfg)
  assert.ok(fs.existsSync(configFile()))
  const cfg2 = loadConfig()
  assert.equal(cfg2.targetLang, 'ja')
  cfg2.targetLang = 'zh-CN'
  saveConfig(cfg2)
})
