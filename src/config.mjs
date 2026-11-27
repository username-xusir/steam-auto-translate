import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function configDir() {
  if (process.env.SAT_CONFIG_DIR) return process.env.SAT_CONFIG_DIR
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(base, 'SteamAutoTranslate')
}
export function configFile() { return path.join(configDir(), 'config.json') }
export function logFile() { return path.join(configDir(), 'sat.log') }

export function defaultConfig() {
  return {
    provider: 'auto',              // auto | openai | bing | libre | googleFree | mymemory
    apiKey: '',                    // OpenAI 兼容服务的 Key（DeepSeek 等）
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    targetLang: 'zh-CN',
    autoTranslate: true,
    displayMode: 'replace',        // replace（仅译文） | bilingual（原文+译文）
    minGapMs: 500,
    libreURL: 'https://translate.tedomum.net',
    bingBatchSize: 12,
    maxSegments: 200,
    imageOcr: true,                // 图片文字 OCR（Windows 自带 OCR）
    exitOnSteamClose: false,       // true：Steam 关闭后进程退出（配合 launch 可零常驻）
    allowedHosts: ['store.steampowered.com', 'steamcommunity.com', 'help.steampowered.com', 'checkout.steampowered.com']
  }
}

export function loadConfig() {
  const cfg = defaultConfig()
  try {
    const j = JSON.parse(fs.readFileSync(configFile(), 'utf8'))
    Object.assign(cfg, j)
  } catch {}
  cfg._cacheFile = path.join(configDir(), 'cache.json')
  return cfg
}

export function saveConfig(cfg) {
  const clean = { ...cfg }
  for (const k of Object.keys(clean)) if (k.startsWith('_')) delete clean[k]
  fs.mkdirSync(configDir(), { recursive: true })
  fs.writeFileSync(configFile(), JSON.stringify(clean, null, 2), 'utf8')
}
