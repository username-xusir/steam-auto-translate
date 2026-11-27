#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { runWatcher } from './watcher.mjs'
import { loadConfig, saveConfig, configDir, configFile } from './config.mjs'
import { createTranslator } from './translate.mjs'
import {
  getSteamPath, isSteamRunning, debugFileEnabled, enableCefDebug, disableCefDebug,
  debugPortUp, listTargets, DEFAULT_PORT,
} from './steam.mjs'

const RUN_KEY = 'SteamAutoTranslate'
const PID_FILE = path.join(configDir(), 'watcher.pid')

function selfArgs(extra) {
  const argv1 = process.argv[1] || ''
  if (/\.(mjs|cjs|js)$/i.test(argv1) && fs.existsSync(argv1)) return [argv1, ...extra]
  return extra
}
function runCommandString(extra) {
  const parts = [process.execPath, ...selfArgs(extra)]
  return parts.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ')
}

function reg(...args) {
  try { execFileSync('reg', args, { encoding: 'latin1', windowsHide: true }); return true } catch { return false }
}
function setAutostart() {
  return reg('add', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`, '/v', RUN_KEY, '/t', 'REG_SZ', '/d', runCommandString(['watch', '--hidden']), '/f')
}
function removeAutostart() {
  reg('delete', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`, '/v', RUN_KEY, '/f')
}
function isAutostartSet() {
  try {
    execFileSync('reg', ['query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`, '/v', RUN_KEY], { encoding: 'latin1', windowsHide: true })
    return true
  } catch { return false }
}

function ensureConfig() {
  fs.mkdirSync(configDir(), { recursive: true })
  if (!fs.existsSync(configFile())) saveConfig(loadConfig())
}

function startWatcher() {
  const pid = readPid()
  if (pid && processAlive(pid)) { console.log('监听器已在运行，PID ' + pid); return }
  const args = selfArgs(['watch', '--hidden'])
  const child = spawn(process.execPath, args, {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, SAT_QUIET: '1' },
  })
  child.unref()
  try { fs.writeFileSync(PID_FILE, String(child.pid), 'utf8') } catch {}
  console.log('监听器已启动，PID ' + child.pid)
}
function readPid() {
  try { const n = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10); return Number.isFinite(n) ? n : null } catch { return null }
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}
function stopWatcher() {
  const pid = readPid()
  if (pid && processAlive(pid)) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    try { fs.unlinkSync(PID_FILE) } catch {}
    console.log('监听器已停止，PID ' + pid)
  } else {
    console.log('没有正在运行的监听器')
  }
}

async function cmdInstall() {
  const steamPath = getSteamPath()
  if (!steamPath) { console.error('未找到 Steam 安装目录，请确认已安装 Steam'); process.exit(1) }
  console.log('Steam 目录:', steamPath)
  enableCefDebug(steamPath)
  console.log('已启用 CEF 调试标记:', path.join(steamPath, '.cef-enable-remote-debugging'))
  ensureConfig()
  console.log('配置文件:', configFile())
  if (setAutostart()) console.log('已设置开机自启（登录时运行）')
  else console.log('警告：开机自启设置失败（可手动把本程序加入启动项）')
  startWatcher()
  if (isSteamRunning() && !(await debugPortUp())) {
    console.log('')
    console.log('⚠ 请完全退出 Steam 后重新打开，调试端口才会生效。')
  }
  console.log('')
  console.log('完成。打开 Steam 的商店/社区/创意工坊页面，右下角会出现「译」按钮。')
}

async function cmdUninstall() {
  stopWatcher()
  removeAutostart()
  const steamPath = getSteamPath()
  if (steamPath && disableCefDebug(steamPath)) console.log('已移除 CEF 调试标记')
  console.log('已卸载（配置文件保留在 ' + configDir() + '）')
}

async function cmdStatus() {
  const steamPath = getSteamPath()
  const running = isSteamRunning()
  const up = await debugPortUp()
  const cfg = loadConfig()
  console.log('Steam 目录 :', steamPath || '未找到')
  console.log('Steam 运行 :', running ? '是' : '否')
  console.log('调试标记   :', steamPath && debugFileEnabled(steamPath) ? '已启用' : '未启用')
  console.log('调试端口   :', up ? '已开启 (http://127.0.0.1:' + DEFAULT_PORT + ')' : '未开启')
  console.log('开机自启   :', isAutostartSet() ? '已设置' : '未设置')
  const pid = readPid()
  console.log('监听器      :', pid && processAlive(pid) ? '运行中 PID ' + pid : '未运行')
  console.log('翻译源     :', cfg.provider, cfg.apiKey ? '(已配置 Key)' : '(未配置 Key，使用免费源)')
  if (up) {
    const ts = await listTargets()
    console.log('页面目标   :', ts.filter((t) => t.type === 'page').length, '个')
    for (const t of ts.filter((t) => t.type === 'page').slice(0, 8)) console.log('  -', (t.url || '').slice(0, 90))
  }
}

async function cmdWatch(hidden, forceExit) {
  if (hidden) process.env.SAT_QUIET = '1'
  fs.mkdirSync(configDir(), { recursive: true })
  try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8') } catch {}
  let stop = false
  const onSig = () => { stop = true }
  process.on('SIGINT', onSig); process.on('SIGTERM', onSig)
  try { await runWatcher({ port: DEFAULT_PORT, shouldStop: () => stop, exitOnSteamClose: forceExit ? true : undefined }) }
  finally { try { fs.unlinkSync(PID_FILE) } catch {} }
}

// 启动 Steam（若未运行）+ 监听器，Steam 关闭后一起退出（零常驻模式）
async function cmdLaunch() {
  const steamPath = getSteamPath()
  if (!steamPath) { console.error('未找到 Steam'); process.exit(1) }
  enableCefDebug(steamPath)
  if (!isSteamRunning()) {
    spawn(path.join(steamPath, 'steam.exe'), ['-silent'], { detached: true, stdio: 'ignore', cwd: steamPath }).unref()
  }
  await cmdWatch(true, true)
}

async function cmdTest(text) {
  const cfg = loadConfig()
  const t = createTranslator(cfg, (m) => console.error(m))
  try {
    const r = await t.translate([text || 'This game is a masterpiece.'], { to: cfg.targetLang })
    console.log(r[0])
  } catch (e) { console.error('失败:', e.message); process.exitCode = 1 }
  finally { t.close() }
}

const [cmd, ...rest] = process.argv.slice(2)
const hidden = rest.includes('--hidden')

const HELP = `Steam 自动翻译 (sat)

用法:
  sat install            安装：启用调试端口 + 开机自启 + 启动监听器
  sat uninstall          卸载：移除调试标记与开机自启，停止监听器
  sat status             查看状态
  sat start / stop       启动 / 停止后台监听器
  sat watch [--hidden]   前台运行监听器（调试用）
  sat launch             启动 Steam 并随 Steam 开关的零常驻模式
  sat enable / disable   仅开关 CEF 调试标记
  sat test "text"        测试翻译源

配置文件: ${configFile()}
`

switch (cmd) {
  case 'install': await cmdInstall(); break
  case 'uninstall': await cmdUninstall(); break
  case 'status': await cmdStatus(); break
  case 'watch': await cmdWatch(hidden); break
  case 'start': startWatcher(); break
  case 'stop': stopWatcher(); break
  case 'launch': await cmdLaunch(); break
  case 'enable': {
    const p = getSteamPath(); if (!p) { console.error('未找到 Steam'); break }
    enableCefDebug(p); console.log('已启用调试标记')
    break
  }
  case 'disable': {
    const p = getSteamPath(); if (!p) { console.error('未找到 Steam'); break }
    disableCefDebug(p); console.log('已移除调试标记')
    break
  }
  case 'test': await cmdTest(rest[0]); break
  default: console.log(HELP)
}
