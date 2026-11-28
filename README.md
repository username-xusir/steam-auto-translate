# STranslateM（SteamAutoTranslate）

在 Steam 客户端里自动把英文的商店页、创意工坊、社区内容翻成中文。基于 Steam 自带的 Chromium（CEF），通过 CDP 注入翻译脚本，**不修改 Steam 本体、不装第三方浏览器扩展**。

> 适用于 Steam 客户端内置浏览器里的 `*.steampowered.com` / `*.steamcommunity.com` 页面。

## 功能

- **打开页面自动翻译**，右下角「译」按钮可随时开关
- **仅译文 / 原文+译文** 两种显示模式，默认直接替换英文原文
- **正文优先**：先翻游戏介绍、工坊描述、评测、评论，跳过导航栏
- **整段翻译**：列表项、加粗标签和正文一起翻，不会只翻一半
- **图片文字 OCR**：对页面里的大图调用 Windows 自带 OCR，识别后在图片下方显示中文说明
- **内置缓存**：重复内容不重复请求
- **翻译源可换**：默认免费 Bing；可配置 DeepSeek / OpenAI 兼容接口，更快更准

## 原理

Steam 客户端 UI 本质是 Chromium（CEF）。在 Steam 安装目录放一个空的 `.cef-enable-remote-debugging` 文件，Steam 启动时会在 `127.0.0.1:8080` 打开 CEF 调试端口；本工具通过 CDP 给每个页面注入翻译脚本：

```
Steam 启动 → 读取 .cef-enable-remote-debugging → steamwebhelper 开 8080 调试端口
        ↓
STranslateM.exe watch → 连接 127.0.0.1:8080 → 给页面注入 agent.js
        ↓
agent.js 采集页面文字 → 经 STranslateM.exe 调翻译源 → 把中文插回页面
```

实现上有两个坑，代码里已处理：

1. **反抓取**：Steam 商店页对页面文本做了手脚，凡是对 `textContent`/`innerText` 用 `\s` 正则处理都会把字母 `s` 抹掉。本工具改为遍历文本节点 `nodeValue` + 手写空白归一化。
2. **容器吞掉子元素**：描述容器如果被当成整体翻译并标记完成，里面的列表项就不会再翻。本工具区分「整块」和「只翻自身文字」两类元素。

## 安装

### 方式一：双击安装包（推荐）

1. 下载 `STranslateM-Setup-0.1.1.exe`
2. 双击运行，按提示安装（默认装到 `%LOCALAPPDATA%\SteamAutoTranslate`）
   - 自动在 Steam 目录创建调试标记文件
   - **默认按需模式**：不常驻，双击 Steam 后 1 分钟内自动开始翻译
   - 创建桌面「STranslateM」与开始菜单快捷方式（可切常驻模式）
3. **完全退出 Steam 再重新打开**（标记文件必须在 Steam 启动前存在）
4. 打开 Steam 的商店 / 创意工坊 / 社区页面，右下角出现「译」按钮

> 如果 Steam 装在 `C:\Program Files (x86)\Steam` 且创建标记文件失败，右键安装包 → 以管理员身份运行。

### 方式二：便携 ZIP

1. 下载并解压 `SteamAutoTranslate-0.1.1.zip`
2. 双击 `install.bat`
3. **完全退出 Steam 再重新打开**

### 方式三：从源码运行

需要 [Bun](https://bun.sh/) 与 Node.js：

```bash
bun install   # 无第三方依赖，可跳过
bun run build # 产出 dist/STranslateM.exe
```

开发时也可以直接 `node src/cli.mjs install`。

## 使用

- 右下角 **「译」**：绿色=自动翻译中；灰色「关」=已关闭
- 点按钮打开面板：开关自动翻译、切换显示方式、重译、打开设置文件
- 显示方式：
  - **仅译文（默认）**：中文直接替换英文原文
  - **原文+译文**：英文保留，中文以蓝色竖线标注在下方

## 配置

配置文件：`%APPDATA%\SteamAutoTranslate\config.json`（面板里点「打开设置文件」）。

### 免费源（默认）

默认使用 Bing 翻译（免 Key、质量较好），LibreTranslate / Google / MyMemory 依次兜底。免费网页接口可能限流，量大时建议配置 API Key。

### 推荐：DeepSeek / OpenAI 兼容

```json
{
  "provider": "auto",
  "apiKey": "sk-你的Key",
  "baseURL": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "targetLang": "zh-CN",
  "autoTranslate": true,
  "displayMode": "replace",
  "maxSegments": 200,
  "imageOcr": true
}
```

其他字段：

| 字段 | 说明 |
| --- | --- |
| `provider` | `auto` / `openai` / `bing` / `libre` / `googleFree` / `mymemory` |
| `displayMode` | `replace`（仅译文）/ `bilingual`（原文+译文） |
| `maxSegments` | 每次扫描最多翻译多少段 |
| `imageOcr` | 是否对图片做 OCR 翻译 |
| `exitOnSteamClose` | `true` 时 Steam 关闭后监听器退出（配合 `sat launch` 零常驻） |

## 图片 OCR

页面里的大图（创意工坊截图等）可用 Windows 自带 OCR 识别，翻译后显示在图片下方。需要 Windows 10/11 的 OCR 语言包；本机只装中文 OCR 时也能识别英文。

关闭：`"imageOcr": false`。

## 两种运行模式

### 按需模式（省内存，推荐 16GB 内存）

- 后台**没有常驻进程**
- **直接双击 Steam 就行**：每分钟检查一次，Steam 在跑就自动启动监听器；关闭 Steam 后监听器自动退出
- 想立刻开始：双击桌面 **「STranslateM」**
- 开始菜单 → STranslateM → **常驻模式：关** 可切到按需模式

### 常驻模式

- 开机自启（隐藏窗口，不弹黑框），每 5 分钟守护一次
- 空闲约 20–40MB，CPU 几乎为 0
- 开始菜单 → STranslateM → **常驻模式：开** 可切回常驻

切换命令：
```bash
STranslateM.exe autostart off   # 按需模式：不常驻，双击 Steam 1 分钟内自动开始
STranslateM.exe autostart on    # 常驻模式：开机自启 + 5 分钟守护
```

## 便携版（单文件）

`STranslateM.exe` 是单文件程序，直接复制走就能用：

- 放到任意可写目录，运行即可
- 配置与缓存保存在 exe 旁边的 `STranslateM-data` 文件夹（连文件夹一起拷走就能迁移）
- 安装目录里的 `STranslateM.exe` 仍使用 `%APPDATA%\SteamAutoTranslate`

## 卸载

双击 `uninstall.bat`（或 `STranslateM.exe uninstall`）：停止监听器、移除开机自启、删除 Steam 目录里的调试标记文件。配置和缓存保留在 `%APPDATA%\SteamAutoTranslate`，可手动删除。

## 已知限制

- 只处理 Steam 内置浏览器里的 `*.steampowered.com` / `*.steamcommunity.com` 页面；Steam 主界面（库/好友，`steamloopback.host`）不翻译
- 免费源会限流，整页是分批补出来的
- 图片 OCR 依赖 Windows OCR，识别率受截图清晰度影响
- 若本机 8080 端口被其它程序占用，调试端口无法开启
- 侧载/调试端口依赖 Steam 版本行为，未来可能变化

## 安全与隐私

- 调试端口只绑定 `127.0.0.1`，不对局域网开放；但本机其它程序理论上可连。不需要时用 `STranslateM.exe uninstall` / `STranslateM.exe disable` 关闭
- 不读取 Steam 账号、密码、Cookie
- 待翻译文本会发送到你选择的翻译服务（默认 Bing；配置 Key 后发给你配置的服务商）
- 缓存与配置只存在本机

## 开发

```bash
npm run build:agent   # 由 src/agent.js 生成内嵌脚本
npm test              # 核心逻辑单测
npm run e2e           # 用 Edge + 本地页验证 CDP 注入（需要本机 Edge）
npm run build         # 生成 dist/STranslateM.exe（bun build --compile）
```

目录：

```
src/agent.js        注入到页面的翻译脚本
src/watcher.mjs     CDP 监听 + 翻译桥接
src/translate.mjs   翻译源与缓存
src/ocr.mjs         图片 OCR（Windows.Media.Ocr）
src/steam.mjs       Steam 定位 / 调试端口
src/cli.mjs         命令行入口
```

## 许可

MIT。仅供个人学习与自用；请遵守 Steam 用户协议与所在地法律法规。
