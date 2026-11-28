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

const RUN_KEY = 'STranslateM'
const OLD_RUN_KEY = 'SteamAutoTranslate'
const GUARD_TASK = 'STranslateMGuard'
const AUTO_TASK = 'STranslateMAuto'
const OLD_TASK = 'SteamAutoTranslateGuard'
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
function schtaskCreate(name, tr, sc, mo) {
  // 写临时 .ps1 再 -File 执行：避免 Bun 传参时把 /TR 里的引号拆坏
  try {
    const ps1 = path.join(process.env.TEMP || configDir(), 'sat-task-' + name + '.ps1')
    const line = 'schtasks /Create /TN ' + psQuote(name) + ' /TR ' + psQuote(tr) + ' /SC ' + sc + (mo ? ' /MO ' + mo : '') + ' /F\r\n'
    fs.writeFileSync(ps1, line, 'utf8')
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: 'ignore', windowsHide: true })
    try { fs.unlinkSync(ps1) } catch {}
    return true
  } catch (e) {
    try { console.log('schtasks 创建失败: ' + String(e.stderr || e.message).slice(0, 200)) } catch {}
    return false
  }
}
function schtaskDelete(name) {
  try { execFileSync('schtasks', ['/Delete', '/TN', name, '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
}

// 写一个隐藏运行的 VBS（可选弹窗提示）
function writeVbs(name, cmd, msg) {
  const f = path.join(configDir(), name)
  let body = 'Set sh = CreateObject("WScript.Shell")\r\n'
  if (msg) {
    body += 'sh.Run "' + cmd.replace(/"/g, '""') + '", 0, True\r\n'
    body += 'MsgBox "' + msg.replace(/"/g, '""') + '", 64, "STranslateM"\r\n'
  } else {
    body += 'sh.Run "' + cmd.replace(/"/g, '""') + '", 0, False\r\n'
  }
  fs.mkdirSync(configDir(), { recursive: true })
  fs.writeFileSync(f, body, 'utf8')
  return f
}
function ensureVbs(auto) {
  return writeVbs(auto ? 'STranslateM-ensure-auto.vbs' : 'STranslateM-ensure.vbs',
    runCommandString(['ensure', ...(auto ? ['--auto'] : []), '--hidden']))
}

// 常驻模式：登录自启 + 5 分钟守护（监听器一直在线）
function setResidentAutostart() {
  const vbs = ensureVbs(false)
  const runCmd = `wscript.exe //nologo "${vbs}"`
  const ok = reg('add', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`, '/v', RUN_KEY, '/t', 'REG_SZ', '/d', runCmd, '/f')
  reg('delete', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`, '/v', OLD_RUN_KEY, '/f')
  schtaskCreate(GUARD_TASK, runCmd, 'MINUTE', '5')
  schtaskDelete(AUTO_TASK)
  schtaskDelete(OLD_TASK)
  return ok
}

// 按需模式：不常驻；每 1 分钟检查一次，Steam 在跑才拉起监听器（Steam 关闭即退出）
function setAutoTask() {
  const vbs = ensureVbs(true)
  const runCmd = `wscript.exe //nologo "${vbs}"`
  reg('delete', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`, '/v', RUN_KEY, '/f')
  reg('delete', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`, '/v', OLD_RUN_KEY, '/f')
  schtaskDelete(GUARD_TASK)
  schtaskDelete(OLD_TASK)
  return schtaskCreate(AUTO_TASK, runCmd, 'MINUTE', '1')
}

function removeAllAutostart() {
  reg('delete', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`, '/v', RUN_KEY, '/f')
  reg('delete', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`, '/v', OLD_RUN_KEY, '/f')
  schtaskDelete(GUARD_TASK)
  schtaskDelete(AUTO_TASK)
  schtaskDelete(OLD_TASK)
}

function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'" }

function createShortcuts() {
  const steamPath = getSteamPath() || ''
  const launchVbs = writeVbs('STranslateM-launch.vbs', runCommandString(['launch']))
  const onVbs = writeVbs('STranslateM-on.vbs', runCommandString(['autostart', 'on']), '已切换为常驻模式（开机自启）。')
  const offVbs = writeVbs('STranslateM-off.vbs', runCommandString(['autostart', 'off']), '已切换为按需模式：不常驻，双击 Steam 后 1 分钟内自动开始翻译。')
  const sm = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'STranslateM')
  const icon = steamPath ? path.join(steamPath, 'steam.exe') + ',0' : (process.execPath + ',0')
  const ps = [
    '$ws = New-Object -ComObject WScript.Shell',
    '$desk = [Environment]::GetFolderPath("Desktop")',
    'function Make($p,$t,$a,$i){ $s=$ws.CreateShortcut($p); $s.TargetPath=$t; if($a){$s.Arguments=$a}; if($i){$s.IconLocation=$i}; $s.Save() }',
    'New-Item -ItemType Directory -Force -Path ' + psQuote(sm) + ' | Out-Null',
    'Make (Join-Path $desk "STranslateM.lnk") "wscript.exe" ' + psQuote('//nologo "' + launchVbs + '"') + ' ' + psQuote(icon),
    'Make ' + psQuote(path.join(sm, '立即启动 STranslateM.lnk')) + ' "wscript.exe" ' + psQuote('//nologo "' + launchVbs + '"') + ' ' + psQuote(icon),
    'Make ' + psQuote(path.join(sm, '常驻模式：开.lnk')) + ' "wscript.exe" ' + psQuote('//nologo "' + onVbs + '"'),
    'Make ' + psQuote(path.join(sm, '常驻模式：关.lnk')) + ' "wscript.exe" ' + psQuote('//nologo "' + offVbs + '"'),
  ].join('\r\n')
  try {
    const b64 = Buffer.from(ps, 'utf16le').toString('base64')
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], { stdio: 'ignore', windowsHide: true })
  } catch (e) { console.log('创建快捷方式失败: ' + e.message) }
}

function removeShortcuts() {
  const smNew = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'STranslateM')
  const smOld = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Steam 自动翻译')
  const ps = '$d=[Environment]::GetFolderPath("Desktop"); ' +
    'Remove-Item -LiteralPath (Join-Path $d "STranslateM.lnk") -Force -ErrorAction SilentlyContinue; ' +
    'Remove-Item -LiteralPath (Join-Path $d "Steam 中文版.lnk") -Force -ErrorAction SilentlyContinue; ' +
    'Remove-Item -LiteralPath ' + psQuote(smNew) + ' -Recurse -Force -ErrorAction SilentlyContinue; ' +
    'Remove-Item -LiteralPath ' + psQuote(smOld) + ' -Recurse -Force -ErrorAction SilentlyContinue'
  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true })
  } catch {}
}

function ensureConfig() {
  fs.mkdirSync(configDir(), { recursive: true })
  if (!fs.existsSync(configFile())) saveConfig(loadConfig())
}

function startWatcher(exitOnClose) {
  const pid = readPid()
  if (pid && processAlive(pid)) { console.log('监听器已在运行，PID ' + pid); return }
  try { fs.unlinkSync(PID_FILE) } catch {}
  const args = selfArgs(['watch', '--hidden'])
  const env = { ...process.env, SAT_QUIET: '1' }
  if (exitOnClose) env.SAT_EXIT_ON_CLOSE = '1'
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env })
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
  const autoOk = setAutoTask()
  console.log(autoOk ? '已设置按需模式（不常驻；Steam 启动后 1 分钟内自动开始）' : '设置按需模式失败')
  cmdEnsure(true)
  createShortcuts()
  if (isSteamRunning() && !(await debugPortUp())) {
    console.log('')
    console.log('⚠ 请完全退出 Steam 后重新打开，调试端口才会生效。')
  }
  console.log('')
  console.log('完成。桌面「STranslateM」可立即启动；开始菜单可切换常驻/按需模式。')
}

async function cmdUninstall() {
  stopWatcher()
  removeAllAutostart()
  removeShortcuts()
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
  const force = (forceExit || process.env.SAT_EXIT_ON_CLOSE === '1') ? true : undefined
  try { await runWatcher({ port: DEFAULT_PORT, shouldStop: () => stop, exitOnSteamClose: force }) }
  finally { try { fs.unlinkSync(PID_FILE) } catch {} }
}

// 检查并拉起监听器（自启/守护用）；auto=true 时随 Steam 关闭退出
function cmdEnsure(auto) {
  const pid = readPid()
  if (pid && processAlive(pid)) return
  try { fs.unlinkSync(PID_FILE) } catch {}
  startWatcher(!!auto)
}

async function cmdLaunch() {
  const steamPath = getSteamPath()
  if (!steamPath) { console.error('未找到 Steam'); process.exit(1) }
  enableCefDebug(steamPath)
  if (!isSteamRunning()) {
    spawn(path.join(steamPath, 'steam.exe'), ['-silent'], { detached: true, stdio: 'ignore', cwd: steamPath }).unref()
  }
  await cmdWatch(true, true)
}

function cmdAutostart(on) {
  if (on) {
    const ok = setResidentAutostart()
    startWatcher(false)
    console.log(ok ? '已切换为常驻模式（开机自启 + 5 分钟守护）' : '设置常驻模式失败')
  } else {
    stopWatcher()
    const ok = setAutoTask()
    cmdEnsure(true)
    console.log(ok ? '已切换为按需模式：不常驻，双击 Steam 后 1 分钟内自动开始翻译' : '设置按需模式失败')
  }
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

const HELP = `STranslateM

用法:
  STranslateM.exe install            安装：启用调试端口 + 常驻自启 + 启动监听器
  STranslateM.exe uninstall          卸载：移除调试标记与自启，停止监听器
  STranslateM.exe status             查看状态
  STranslateM.exe start / stop       启动 / 停止后台监听器
  STranslateM.exe autostart on|off   常驻模式 / 按需模式（按需：双击 Steam 1 分钟内自动翻）
  STranslateM.exe watch [--hidden]   前台运行监听器（调试用）
  STranslateM.exe launch             启动 Steam 并随 Steam 开关（零常驻）
  STranslateM.exe ensure [--auto]    没在跑就拉起（自启/守护用）
  STranslateM.exe test "text"        测试翻译源

配置文件: ${configFile()}
`

switch (cmd) {
  case 'install': await cmdInstall(); break
  case 'uninstall': await cmdUninstall(); break
  case 'status': await cmdStatus(); break
  case 'watch': await cmdWatch(hidden); break
  case 'start': startWatcher(false); break
  case 'stop': stopWatcher(); break
  case 'ensure': cmdEnsure(rest.includes('--auto')); break
  case 'autostart': cmdAutostart(rest[0] !== 'off'); break
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
