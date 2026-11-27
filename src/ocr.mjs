// 图片文字识别：调用 Windows 自带 OCR（Windows.Media.Ocr），无需第三方引擎
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const OCR_PS1 = `param([string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
})[0]
function Await($op, $type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}
[Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$lang = [Windows.Globalization.Language]::new('zh-Hans-CN')
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$result.Text
`

function workDir() {
  const d = path.join(os.tmpdir(), 'SteamAutoTranslate')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function ensureScript() {
  const f = path.join(workDir(), 'sat-ocr.ps1')
  fs.writeFileSync(f, OCR_PS1.replace(/\r?\n/g, '\r\n'), 'utf8')
  return f
}

export async function ocrImage(url, { timeout = 60000 } = {}) {
  const dir = workDir()
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16)
  const file = path.join(dir, 'ocr-' + hash + '.img')
  if (!fs.existsSync(file)) {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!r.ok) throw new Error('图片下载失败 ' + r.status)
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > 10 * 1024 * 1024) throw new Error('图片过大')
    fs.writeFileSync(file, buf)
  }
  const ps = ensureScript()
  const win = file.replace(/\//g, '\\')
  const { stdout } = await execFileP('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-Path', win], { encoding: 'utf8', timeout, windowsHide: true })
  return (stdout || '').trim()
}
