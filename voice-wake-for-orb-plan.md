# 给悬浮球（dsh-orb）加语音唤醒：可行性与最少改动方案

> 调研日期：本次会话。仓库：`C:\Users\digua\Desktop\dsh-orb-cordis`（下称“仓库根”）。
> 本文所有事实都标注了来源文件路径；无法通过只读调研确认的写「未确认」。

---

## 0. 结论（先回答“能不能加”）

**能加，但必须移植 + 重新接线，不能直接把 `dsh-voice-dialog` 挂上去。**

三条硬事实决定了这件事的性质：

1. `dsh-voice-dialog` 的唤醒功能是**浏览器网页插件**，跑在 DSH Web GUI（主窗口）页面里，靠 HTTP 从 Host 的 `/voice-assets/*` 路由取模型（`dsh-voice-dialog/lib/index.js:32`、`dsh-voice-dialog/lib/client.js:196`）。
2. 悬浮球**不是**网页插件：它是一个独立的 Electron 进程里的透明置顶小窗（helper），页面直接 `loadFile` 加载，渲染层与宿主只通过一条 NDJSON socket（helper）和 preload IPC 通信，**页面本身不发任何 HTTP 请求**（`packages/helper/src/main.ts:270`、`packages/helper/assets/shell.js` 中没有任何 `fetch(`）。
3. 悬浮球窗口当前**明确拒绝一切权限请求**（包括麦克风）：`denyWindowPermissions()` 把所有 `setPermissionRequestHandler` 回调设为 `false`（`packages/helper/src/overlays.ts:32`，被 `openWindow()` 在 `packages/helper/src/main.ts:302` 调用）。

所以正确的做法是：**复用 `dsh-voice-dialog/assets/` 下的 4 个 ONNX 模型 + ORT wasm 运行时（不复制大文件，按路径引用），把唤醒引擎搬进悬浮球窗口的渲染层，并补三处“管道”**：

- helper 用私有标准协议 `dsh-wake://assets/` 把仓库里那份模型目录只读地发给球窗（Host 侧另有一条等价的 token 鉴权 HTTP 路由，见 §4.1）；
- helper 允许**只给悬浮球窗口**麦克风权限（其余权限继续拒绝）；
- 悬浮球页面加载唤醒引擎，并把“已监听 / 已唤醒”状态画到球上（外圈光环 + 状态徽标 + 提示音）。

第 4 节是推荐方案（**本次已实现**），第 5 节是备选方案，第 6 节是风险与未确认项，第 8 节是球上实际长什么样，第 9 节是构建与测试的真实输出。

---

## 1. 仓库里哪个包是“桌面悬浮球插件”

根 `package.json`：私有 monorepo，`pnpm@11.7.0`，`pnpm-workspace.yaml` 只有 `packages/*`。`packages/` 下每个包：

| 目录 | package.json `name` | 作用 | 入口 |
| --- | --- | --- | --- |
| `packages/bundle` | `dsh-orb` | **唯一可安装的包**。构建时把 host / computer-use / helper / 设置页装配进自己 | `lib/index.js`（`main`），子路径导出 `./client`、`./host`、`./computer-use`、`./cordis.patch.yml`（`packages/bundle/package.json`） |
| `packages/helper` | `@dsh-orb/helper` | **悬浮球本体**：独立 Electron 进程里的透明置顶球窗 + 观测框 + 选择工具条 | `lib/main.js`（源 `src/main.ts`），另有 `preload.cjs`、`selection-preload.cjs`、`assets/`（`packages/helper/package.json`） |
| `packages/host` | `@dsh-orb/host` | Host 侧插件：起 helper、拥有 Computer Use 会话、开 `/.dsh-orb/*` 设置路由、偏好存储 | `lib/index.js`（源 `src/index.ts`，`packages/host/package.json`） |
| `packages/computer-use` | `@dsh-orb/computer-use` | 13 个 GUI 工具 + `code_agent` | `lib/index.js`、`lib/code-agent.js` |
| `packages/client-settings` | `@dsh-orb/client-ui-settings-orb` | 主窗口“悬浮球”设置页（浏览器端插件） | `lib/index.js` + `client.js` |
| `packages/native-selection` | `@dsh-orb/native-selection` | 划词监听原生库（koffi / dylib） | `src/index.js` |

**“桌面悬浮球插件”= `packages/bundle`（对外叫 `dsh-orb`），球窗实现 = `packages/helper`，Host 侧 = `packages/host`。**（依据：`README.md:54-73` 的架构图，以及 `packages/bundle/scripts/assemble.mjs` 的装配清单。）

顺带确认了本机的真实安装形态：`C:\Users\digua\.dsh\profiles\desktop\package.json` 里是
`"dsh-orb": "file:C:/Users/digua/.dsh/profiles/desktop/vendor/dsh-orb-0.0.0.tgz"` —— **不是 link，是打包后的 tgz**。这意味着**改完仓库必须重新 `build` + 重新安装到 profile 才会生效**，光改源码对正在运行的这个球没有任何影响。

---

## 2. `dsh-voice-dialog` 的唤醒是怎么实现的

### 2.1 两面插件

- `dsh-voice-dialog/package.json`：`main: lib/index.js`，导出 `./client`；`dsh.client.platform = "web"`；`cordis.patch.yml` 里只有一条 insert（`dsh-voice-dialog/cordis.patch.yml:9-11`）。
- Host 面 `dsh-voice-dialog/lib/index.js`：**不提供任何服务/工具**，只做一件事——把 `assets/` 挂到 `webServer` 的 `/voice-assets` 前缀路由上（`lib/index.js:106-119`），并且对 `.wasm` 明确回 `application/wasm`（`lib/index.js:35-51`，注释说明 `instantiateStreaming` 强制要求这个 content-type）。
- 浏览器面 `dsh-voice-dialog/lib/client.js`（105 KB）通过 `window.__ModuleLoader__.load({ id: 'dsh-voice-dialog', factory })` 注册（`lib/client.js:14-16`）。

### 2.2 唤醒引擎（`lib/client.js` 关键结构）

| 位置 | 内容 |
| --- | --- |
| `lib/client.js:196` | `WAKE_ASSET_BASE = '/voice-assets'` |
| `lib/client.js:238` | `WAKE_ORT_SCRIPT = '/voice-assets/ort/ort.wasm.min.js'`（**必须 wasm-only 构建**，注释解释了配 `ort.min.js` 会 `TypeError: c is not a function`） |
| `lib/client.js:241-246` | 模型表：`melspectrogram.onnx`、`embedding_model.onnx`、`silero_vad.onnx`、`keywords: { hey_jarvis: 'hey_jarvis_v0.1.onnx' }` |
| `lib/client.js:249-273` | `WAKE_WORKLET`：`AudioWorkletProcessor`，固定 **1280 采样**一帧，`port.postMessage` |
| `lib/client.js:397` 起 | `class WakeWordEngine`：`frameSize 1280`、`sampleRate 16000`、`melWindowFrames 76`；`ensureRuntime()`（注入 ORT script，`numThreads=1`，`wasmPaths` 必须传 `{mjs, wasm}` 对象形式，`lib/client.js:500-511`）；`load()` 建 4 个 `InferenceSession`（`:517-529`）；`start()` 走 `getUserMedia({audio:true})` + `AudioContext({sampleRate:16000})` + `audioWorklet.addModule(blobUrl)` + `AudioWorkletNode`（`:549-606`）；`stop()` 先停打分再释放麦克风与 `AudioContext.close()`（`:609-661`） |
| `lib/client.js:667-694` | 每帧：先 RMS 电平 → Silero VAD（`:701-714`，阈值 `>0.5`，带 12 帧 hangover）→ mel/embedding/classifier 链 |
| `lib/client.js:721-764` | mel 输出做 `x/10+2` 归一化、每帧切 5 个 32 bin、76 帧窗口进 embedding、16×96 环形历史进 keyword 分类器；判定条件 `score > threshold && speechActive && !coolingDown && running`，触发 `onDetect({keyword, score})`，冷却 2500 ms |
| `lib/client.js:804-813` | 状态快照：`wakeEnabled / wakeSupported / wakeReady / wakeListening / wakeArmed / wakePending / wakeThreshold / wakeKeyword / lastWakeAt / wakeError`，默认阈值 **0.5**，关键词 **hey_jarvis** |
| `lib/client.js:1799-1808` | 阈值可运行时设置，`clamp(0.05, 0.99)`；偏好写 `localStorage` 键 `dsh-voice-dialog/preferences/v1`（`:120`） |
| `lib/client.js:2386` 起 | `WakeStatusBar`：常驻诊断条（分数条、阈值刻度、麦克风状态、错误） |
| `lib/client.js:2517` | `apply(ctx)`：把按钮挂到 composer 工具行、把设置行挂进设置页（依赖 `@deepseek-ai/dsh-api-session-controller` 与 `@deepseek-ai/dsh-client-ui-conversation`，见 `dsh-voice-dialog/package.json:29-32`） |

**唤醒之后做什么**（`lib/client.js`）：`playWakeChime('wake')` 播提示音（`:327-382`，纯 WebAudio，不会污染语音识别），然后启动 Web Speech 云端识别，识别文本经 `session.prompt` 发到当前会话；`SILENCE_MS=1800` 收尾，`EMPTY_TIMEOUT_MS=5000` 空等待回退到待唤醒态（`:205-216`）。

### 2.3 自检页把“怎么跑起来”讲清楚了

`dsh-voice-dialog/assets/selftest.html`：纯静态页，因为它由 `/voice-assets/selftest.html` 提供，模型用相对路径 `.` 取（`:49-50`）。流程 = 加载 `ort/ort.wasm.min.js` → 设 `numThreads = 1` 与 `wasmPaths = {mjs, wasm}`（`:99-102`）→ `fetch` 4 个模型确认 200（`:107-120`）→ `InferenceSession.create` → `getUserMedia` → `AudioContext({sampleRate:16000})` → worklet → 逐帧打分，`score > 0.5 && speech` 判为命中（`:183-188`）。**没有用 sherpa-onnx，也没有用 onnxruntime-node：全部是 `onnxruntime-web`（wasm）。**

### 2.4 assets 体积（真实数值）

`dsh-voice-dialog/assets/`：4 个 ONNX 合计约 **5.19 MB**（`silero_vad.onnx` 1.81 MB、`embedding_model.onnx` 1.33 MB、`hey_jarvis_v0.1.onnx` 1.27 MB、`melspectrogram.onnx` 1.09 MB），`ort/ort-wasm-simd-threaded.wasm` **14.2 MB**，另加 `ort.min.js` 368 KB 与 `ort.wasm.min.js` 50 KB。总量约 19–20 MB。

### 2.5 这条路由在“你正在跑的这个实例”上是否可用

用只读 HTTP 探测本机 `http://127.0.0.1:19387`：

- `GET /` → **401**（需要会话凭据）；
- `HEAD /voice-assets/ort/ort.wasm.min.js` → **404**；
- `HEAD /voice-assets/melspectrogram.onnx` → **404**。

并且 `C:\Users\digua\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 里只有 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-experimental-voice-input-bundle`、`dsh-orb` —— **没有 `dsh-voice-dialog`**。

即：**当前这个实例既没有挂载 `/voice-assets` 路由，也没有 voice-dialog 包**；而悬浮球窗口即使能访问该端口，也拿不到会话 cookie（球窗是 `file://` 页面，从不做鉴权 HTTP）。所以「让球窗直接去 19387 拉模型」这条路**不可行**，模型必须由球自己的 Host 用 helper token 发出去。

---

## 3. 悬浮球侧的真实约束（决定改造点）

| 事实 | 来源 |
| --- | --- |
| 球窗由 helper 进程 `new BrowserWindow({... transparent, alwaysOnTop, frame:false, webPreferences:{preload, contextIsolation:true, nodeIntegration:false, sandbox:true}})` 创建，页面用 `loadFile(assets/floating.html)` | `packages/helper/src/main.ts:270-328` |
| **一切权限请求被拒**（含麦克风）：`denyWindowPermissions()` | `packages/helper/src/overlays.ts:32-36`，调用点 `packages/helper/src/main.ts:302` |
| 页面 CSP 写死：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' dsh-app://app; img-src 'self' data:; frame-src dsh-app://app`（**没有 `wasm-unsafe-eval`**） | `packages/helper/assets/floating.html:6` |
| 页面只经 preload 的 `window.dshOrb` 与主进程通信（send / invoke / on*），**没有任何 HTTP 请求** | `packages/helper/preload.cjs`、`packages/helper/assets/shell.js`（全文无 `fetch(`） |
| Host → helper：NDJSON socket（每进程随机 32 字节 token，走环境变量），已有消息类型 `session/block/turn/status/question/permission/history/reset/chrome/appearance/avatar/tcc/...` | `packages/host/src/orb.ts:382-450`、`:1144-1150` |
| helper → Host：`orb:prompt`、`orb:open`、`orb:new`、`orb:stop`、`orb:menu`、`orb:open-external`、`orb:tcc-*`、`orb:meme-*` 等 | `packages/helper/src/main.ts:109-249` |
| helper 已经会带 token 去 loopback 取头像：`GET http://127.0.0.1:<webPort>/.dsh-orb/avatar?v=N`，头 `x-dsh-orb-helper: <token>` | `packages/helper/src/main.ts:629-666`；Host 侧校验 `packages/host/src/routes.ts:78`、`:301-304` |
| helper 启动环境由 Host 注入：`DSH_ORB_TOKEN`、`DSH_ORB_SOCKET`、`DSH_ORB_WEB_PORT`、`DSH_ORB_APPEARANCE` | `packages/host/src/orb.ts:1156-1164` |
| 球上已有的可见状态：`#ball` 外圈 `box-shadow` 表示 pinned、`#dock-tab`、`#status` 文本、`body.running/.asking/.tcc-gating` 类、GIF 模式切换 | `packages/helper/assets/floating.css:682-780`、`packages/helper/assets/shell.js:793-826` |
| 组装时 `helper/assets/**` 整目录拷进 `dsh-orb/dist/helper/assets/`，且只构建 `src/*.ts`；`assets/` 下的普通 `.js` **照原样发布、不参与打包** | `packages/bundle/scripts/assemble.mjs`（`copyFrom('helper','assets', ...)`）、`packages/helper/tsdown.config.ts`、`packages/helper/package.json` 的 `files` |

**推论**：模型资产不能“复制进 assets”（会平白多 19 MB 进包），必须由 Host 从仓库里的 `dsh-voice-dialog/assets/` **按路径引用并发出去**；麦克风必须单独开口子；CSP 必须允许连 loopback 与 `blob:`；唤醒引擎放渲染层最省事（`window.ort` + WebAudio 的写法在 `selftest.html` 里已被验证可行）。

---

## 4. 推荐方案（已实现）：模型按路径引用 + 球窗内跑唤醒引擎

数据流（最终落地的形态）：

```
dsh-voice-dialog/assets/*.onnx + ort/            （仓库内，只读引用，不复制）
        │  按路径发现（env / cwd / 已安装包向上四级）
        ▼
helper  dsh-wake://assets/<file>                 （自定义标准协议，文件名白名单）
        │  .wasm 回 application/wasm，.onnx 回 application/octet-stream
        ▼
helper 球窗（file:// 页面，CSP 放行 dsh-wake://assets/ 与 blob:）
        │  onnxruntime-web(wasm) + AudioWorklet(1280/16k) + Silero VAD
        ▼
命中唤醒词 → 提示音 + 球上光环/徽标 + （可选）自动展开面板 + 状态回传 helper（Host 记日志）
```

Host 另外还开了一条等价的 loopback 路由 `/.dsh-orb/wake-assets/*`（helper token 鉴权，见 §4.1），
保留为「主窗口侧也能读同一份模型」的接口。球窗走 `dsh-wake://` 而不是那条路由，原因是：
`file://` 页面上的 `fetch` 带自定义头要过 CORS、把 socket token 写进 URL 又会落到页面地址里；
自定义协议既不需要 token，也不受 CORS 影响（真机是否完全如愿见 §6 第 4 条，未实测）。

### 4.1 改动清单（实际落地的文件）

**Host（`packages/host`）**

| 文件 | 改动 |
| --- | --- |
| `src/wake-assets.ts` | **新增**：`discoverWakeAssets()` / `readWakeDirectory()` 找并校验模型目录、`keywordFile()`、`wakeFiles()`、`resolveWakeAsset()`（白名单 + 拒绝 `..`）、`wakeAssetMime()` |
| `src/preferences.ts` | **新增** `WakeSettings` 与 `orb-wake.json` 配置（`enabled` / `keyword` / `threshold` / `assetDirectory` / `autoExpandOnWake`），`ProfileStore.wake()` / `setWakeEnabled()` |
| `src/routes.ts` | **新增** `GET|HEAD /.dsh-orb/wake-assets/<name>`：`x-dsh-orb-helper` 头或 `?token=` 两种鉴权（都走常数时间比较）、白名单文件名、`.wasm` 回 `application/wasm`；`OrbControl` 增加 `setWakeEnabled()` |
| `src/orb.ts` | 启动 helper 时注入 `DSH_ORB_WAKE`（`enabled / keyword / threshold / autoExpandOnWake`）与 `DSH_ORB_WAKE_ASSETS`（模型目录绝对路径）；`chrome` 消息里带上 `wakeEnabled`；新增 `setWakeEnabled()`；处理 helper 的 `set-wake` 消息 |

**helper（`packages/helper`）**

| 文件 | 改动 |
| --- | --- |
| `src/wake.ts` | **新增**：`readWakeConfig()`（读 `DSH_ORB_WAKE` / `DSH_ORB_WAKE_ASSETS`）、`registerWakeScheme()` / `serveWakeAssets()`（自定义 `dsh-wake://assets/` 协议 + MIME + 白名单）、`wakeAssetPath()` |
| `src/main.ts` | 球窗改走 `allowBallMicrophone()`：只放行 `media`（且只在请求音频时），其余权限继续拒绝；开 `orb:wake-config` / `-enable` / `-disable` / `-enabled` / `-report` 五个 IPC；`did-finish-load` 后按 profile 恢复监听（`loadFile` 本身不需要带任何 query） |
| `src/electron.d.ts` | 补 `protocol`、`setPermissionCheckHandler`、`loadFile(path, { query })` 的类型声明 |
| `src/menu.ts` | 右键菜单新增勾选项「语音唤醒（Hey Jarvis）」；找不到模型目录时该行禁用并显示「未找到本地模型」 |
| `preload.cjs` | 暴露 `wakeConfig()` / `wakeEnable()` / `wakeDisable()` / `wakeReport()` / `setWakeEnabled()` / `onWake()` |
| `assets/wake.js` | **新增**：唤醒引擎（ORT wasm-only、4 个模型、mel→embedding→classifier + Silero VAD、1280/16k、阈值 + 2500 ms 冷却、提示音、`enable()/disable()/syncFromHelper()`、诊断上报、采样率不符时线性重采样兜底） |
| `assets/shell.js` | 订阅唤醒事件：球上加 `wake-listening` / `wake-detected` / `wake-loading` / `wake-error` 类，面板内徽标文案，唤醒后按配置自动展开面板 |
| `assets/floating.html` | CSP 放行 `dsh-wake://assets/`（connect）、`blob:`（script/media）、补 `'wasm-unsafe-eval'`；新增 `#wake-badge` |
| `assets/floating.css` | 新增 `--wake*` 变量、球的外圈光环动画（`prefers-reduced-motion` 降级）、徽标样式及其 4 种状态配色 |

**bundle（`packages/bundle`）**

| 文件 | 改动 |
| --- | --- |
| `scripts/assemble.mjs` | 原来无条件 `chmod dist/computer-use/macos-sck-capture`，该文件是 macOS 专有构建产物（本机 `packages/computer-use/native/` 下没有），会让装配在 Windows 上崩在 `ENOENT`。改为 `existsSync` 后再 chmod —— 与本功能无关，但不修就没法验证装配 |

**新增测试**

| 文件 | 覆盖 |
| --- | --- |
| `packages/host/tests/wake-assets.test.ts` | 目录校验、白名单、目录穿越、MIME、env 覆盖、按关键词取模型 |
| `packages/host/tests/wake-route.test.ts` | 真起一个 loopback 服务挂真路由 + 真模型目录：`GET` 模型/`.wasm`/loader 的 200 与 content-type、错误 token 403、`..` 与未知文件 404、其它路由不受影响 |
| `packages/helper/tests/menu.test.ts` | 扩写：唤醒菜单行（双语、缺失时禁用）+ 新 preload 五个方法的通道断言 + 「页面依赖的唤醒 id / CSP / 四个状态 class」与 `floating.html`、`floating.css` 的一致性 |

**可配置项（都进 `orb-wake.json`）**

```json
{
  "enabled": false,
  "keyword": "hey_jarvis",
  "threshold": 0.5,
  "assetDirectory": "",
  "autoExpandOnWake": true
}
```

- `keyword`：目前只有 `hey_jarvis` 一个模型（`dsh-voice-dialog/assets/hey_jarvis_v0.1.onnx`）。配置成别的词时，Host 与 helper 都按 `<keyword>.onnx` 去找同名模型；**放一份别的 openWakeWord 模型是否就能换词，未验证**。
- `threshold`：对应 `client.js` 的 `wakeThreshold`，范围按 voice-dialog 的口径夹到 `0.05–0.99`。
- `assetDirectory`：留空则按顺序找 `DSH_ORB_WAKE_ASSETS` 环境变量 → `process.cwd()/dsh-voice-dialog/assets` → 从已安装包向上四级的 `<checkout>/dsh-voice-dialog/assets`。**不复制、不移动任何模型文件。**
  注意：仓库内默认值对「装在 repo 里」的场景有效；装到别处时请显式写 `assetDirectory` 或设 `DSH_ORB_WAKE_ASSETS`。

**为什么模型走自定义协议而不是 loopback HTTP**

Host 侧其实也开了一条 `/.dsh-orb/wake-assets/*` 路由（helper token 鉴权，已用真 socket 测过），但球窗最终用的是 helper 自己的 `dsh-wake://assets/` 协议：这样页面里的模型 URL 不需要带 helper socket token，`file://` 页面也不受 CORS preflight 影响。两条路都保留，Host 那条是给「以后想让主窗口也能读模型」留的接口。

### 4.2 为什么不是“直接把 client.js 拷到球里”

`client.js` 是给 Web GUI 写的 lazy-CJS 模块：它靠 `window.__ModuleLoader__.load` 注入 React、靠 `@deepseek-ai/dsh-client-ui-conversation` 拿会话、靠 `session.prompt` 发消息（`dsh-voice-dialog/lib/client.js:14-16`、`package.json:29-32`）。球窗里这四样都不存在（没有 React、没有模块加载器、没有会话对象，球只通过 `api.send(text)` 把文本交给 Host 的 Computer Use 会话）。所以复用的是**引擎与参数**，不是那个文件本身。

---

## 5. 备选方案

**B1 · 唤醒放在主窗口（Web GUI）侧，只把“已唤醒”转发给球。**
不新写引擎，复用 `dsh-voice-dialog` 的浏览器插件，只是把 `onDetect` 的结果从“开云端识别”改成“给球发一条消息”。
代价：需要 `dsh-voice-dialog` 装进 profile（当前**没装**，见 §2.5），并且要在球 ↔ 主窗口之间新加一条转发通道（球现在只接 Host socket，没有反向推 wake 的先例）。优点：模型仍由既有 `/voice-assets` 路由服务，改动最小；缺点：麦克风与唤醒只在主窗口开着时有效，用户合上主窗口就没唤醒。**未实现。**

**B2 · 把模型 + ORT 拷进 helper 的 assets，用自定义协议（`dsh-wake://`）或 `file://` 直读。**
脱离 Host 的 HTTP 路由，理论上更独立。代价：安装包体积 +19 MB（`assemble.mjs` 会把 `helper/assets/**` 全拷进 bundle），且 `file://` 下 `WebAssembly.instantiateStreaming` 拿不到 `application/wasm`，会退回较慢的非流式编译路径。
**本次的实现取了中间态**：自定义协议用上了（`dsh-wake://assets/`），但模型仍在仓库原处、按路径引用，不进包。

**B3 · 在 helper 主进程里跑 `onnxruntime-node`。**
要把 14 MB 的 native ORT 打进 Electron 运行时，并处理 Electron ABI 匹配，代价最高。**未实现。**

---

## 6. 风险与不确定点

**已确认（有代码/探测依据）**

- 唤醒模型与 ORT 运行时是**浏览器 wasm** 版本，球窗渲染层可直接跑（`selftest.html` 已验证同一套参数）。
- 球窗页面当前**没有任何网络请求能力/习惯**，CSP 也卡死；必须显式放行，否则模型下载会静默失败。
- 麦克风权限被 `denyWindowPermissions()` 全局拒绝；不放行则 `getUserMedia` 必然 reject。
- 本机 profile 用的是 **tgz 安装**，本次改动**不会**影响正在运行的球（见 §1）。
- 正在运行的实例**没有** `/voice-assets` 路由（探到 404），所以“白嫖现有路由”的想法不成立。

**未确认 / 需要真机验证（本次只读调研无法覆盖）**

1. **麦克风授权链**：Windows 上 Electron 的 `media` 权限是否只看 `setPermissionRequestHandler` / `setPermissionCheckHandler`，还是会受系统「麦克风隐私设置」二次限制 —— 未确认，必须实跑。本实现已把球窗从「拒绝一切」改成「只放行 `media`，且只在请求音频类型时放行」（`packages/helper/src/main.ts` 的 `allowBallMicrophone`）。
2. **`getUserMedia` 在 `file://` 页面**是否被 Chromium 以「非安全上下文」拒绝（`file://` 通常算可信来源，但没有实测）—— 未确认。
3. **AudioContext 自动播放策略**：球窗常年不聚焦，`new AudioContext()` 可能回 `suspended`（voice-dialog 里专门为此写了恢复逻辑，`dsh-voice-dialog/lib/client.js:555-567`）。本实现的降级是「从右键菜单开启 = 一次用户手势」，并且 `openMicrophone()` 会在 `state !== 'running'` 时直接报错给界面，而不是假装在听。实际能否 resume —— 未确认。
4. **`dsh-wake://` 协议下 ORT 能否正常加载**：`ort.wasm.min.js` 里有一条 `a.indexOf("blob:") !== 0` 的分支来定位 loader（已读过压缩源码确认），说明它按 URL 处理非 blob 的 loader 地址；自定义标准协议是否被 `WebAssembly.instantiateStreaming` 与动态 `import()` 一视同仁 —— 未确认。代码里 Worklet 仍走 `blob:`，模型与 wasm 走协议 URL。
5. **多出一路 16 kHz 采集是否影响 Computer Use 截图/录音**：本实现只在球窗本地处理，不上传、不写文件，但会不会与观测框/截图冲突 —— 未确认。
6. **CPU 占用**：16 kHz 三模型链每 80 ms 一帧，voice-dialog 在浏览器里可用，但在球窗常驻是否有感知开销 —— 未确认（本次未做性能测量）。
7. **换唤醒词**（除 `hey_jarvis` 外）需要额外的 openWakeWord 模型文件 —— 未验证。
8. **真正的“语音输入”**（唤醒之后的听写）没做：球窗的 CSP 是 `default-src 'self'`，Web Speech 识别需要连云端且要 `connect-src` 放行、还需要 `webkitSpeechRecognition` 可用；本次只在第 7 节里给出后续路径，**未实现**。

**另外两点工程风险**

- 唤醒引擎跑在球窗渲染层，意味着**球窗崩溃/重载就会丢唤醒**；helper 有 watchdog，但那是进程级的。
- 球窗是 `sandbox: true` + `contextIsolation: true`，所有新 IPC 都必须走 preload 白名单（已按此实现），不要在页面里直接 `require`。

---

## 7. 唤醒之后还能做什么（后续可选，本次未做）

1. **只做“可见反馈”**（本次的最小可用版本）：光环 + 徽标 + 提示音 +（可选）自动展开面板。**已实现**。
2. **接听写**：在球窗用 Web Speech（需要放宽 CSP 的 `connect-src` 到云端 STT 域名，或改用 `@deepseek-ai/dsh-experimental-voice-input-bundle` 的能力），把识别文本填进球的 composer。**未实现**。
3. **直接发车**：识别完成后调用既有的 `window.dshOrb.send(text)`（`packages/helper/preload.cjs:16-18`），等价于用户在球上按回车 —— 这会真正触发 Computer Use，属于“有副作用”的一步，建议单独加一个显式开关。**未实现**。

---

## 8. 唤醒在球上长什么样（本次实现的可见反馈）

| 状态 | 球的观感 |
| --- | --- |
| 未开启 | 一切照旧，没有任何新元素 |
| 加载中（`loading`） | 面板内徽标灰底「语音唤醒加载中…」 |
| 已监听（`listening`） | 球外圈一道蓝色呼吸光环；面板内徽标「语音唤醒已开启 — 说「Hey Jarvis」」；鼠标悬停球的 tooltip 同文案 |
| 已唤醒（`detected`） | 光环变绿加粗、脉冲加快；徽标变绿「已听到唤醒词」；播一声上行提示音；按配置自动展开面板；4 秒后回到已监听 |
| 出错（`error`） | 徽标红底，写明原因（例如 `NotAllowedError` / `audio context is suspended`），球不再监听 |

开关只有一个入口：右键球的菜单里的勾选项「语音唤醒（Hey Jarvis）」（中英双语文案见 `packages/helper/src/menu.ts`）。任何时刻关掉它都会立刻释放麦克风（`WakeEngine.teardown()` 先停打分再 `track.stop()` + `AudioContext.close()`）。

---

## 9. 构建与验证（本节为实际执行结果）

**环境**：Windows x64，Node `v24.9.0`（`C:\Users\digua\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node`）、pnpm `11.7.0`（同目录 `pnpm/bin/pnpm.mjs`）。未触碰 DSH 安装目录，未重启任何服务，未执行 `dsh-voice-dialog/scripts/*`。

### 9.1 `pnpm typecheck` —— 通过

```
$ tsc --noEmit -p packages/computer-use/tsconfig.json && tsc --noEmit -p packages/host/tsconfig.json
  && tsc --noEmit -p packages/helper/tsconfig.json && tsc --noEmit -p packages/client-settings/tsconfig.json
EXIT=0
```
（无任何 `error TS…` 输出。中途修掉的两个真实类型错误：`loadFile` 第二参数缺声明、`protocol` 未声明，均已补进 `packages/helper/src/electron.d.ts`。）

### 9.2 `pnpm -r --if-present build` —— 本沙箱内失败，直接调用等价步骤全部成功

```
packages/client-settings build$ tsdown
packages/helper build$ tsdown && tsdown --config tsdown.vendor.config.ts
packages/computer-use build$ tsdown && node ./scripts/copy-native.mjs
Error: spawn EPERM
    at spawn (node:child_process:813:9)
    at spawn3 (.../pnpm/dist/pnpm.mjs:108075:15)
  errno: -4048, code: 'EPERM', syscall: 'spawn'
EXIT=1
```

失败点是 **pnpm 无法 spawn 生命周期脚本**（本会话的文件沙箱禁止「程序以管道捕获另一个程序输出」的 spawn，即命名管道被拒），不是源码问题。改为直接执行同样的步骤：

| 步骤 | 结果 |
| --- | --- |
| `node node_modules/tsdown/dist/run.mjs`（在 `packages/client-settings`） | ✔ `lib/index.js` 0.40 kB、`lib/index.d.ts` 0.43 kB，`EXIT=0` |
| 同上（在 `packages/host`） | ✔ `lib/index.js` **119.67 kB**、`lib/index.d.ts` 4.58 kB，`EXIT=0` |
| 同上（在 `packages/helper`） | ✔ `lib/main.js`（最终一次 73.62 kB），`EXIT=0` |
| 同上（在 `packages/computer-use`） | ✔ 6 个文件共 230.16 kB，`EXIT=0` |
| `tsdown --config tsdown.vendor.config.ts`（helper，Shiki 词法包） | ✔ 26 个文件共 2.68 MB，`EXIT=0` |
| `node packages/bundle/scripts/assemble.mjs` | ✔ `assemble: dsh-orb is ready in C:\Users\digua\Desktop\dsh-orb-cordis\packages\bundle`，`EXIT=0` |

**第一次装配是在修掉 `assemble.mjs` 的 chmod 之前失败的**，原文：

```
Error: ENOENT: no such file or directory, chmod '...\packages\bundle\.assemble-KvXA2N\dist\computer-use\macos-sck-capture'
    at async file:///.../packages/bundle/scripts/assemble.mjs:68:1
EXIT=1
```
原因：`macos-sck-capture` 是 macOS 专有产物，本机 `packages/computer-use/native/` 里没有（Windows 上 `tsdown` 只产出 6 个文件，不含它），而装配脚本无条件 chmod。改成 `existsSync` 后再 chmod 即通过。

装配产物核对（均在 `packages/bundle/` 内）：

- `dist/helper/assets/wake.js` 存在，20 129 字节；
- `dist/helper/assets/floating.html` 的 CSP 已是新值，`<p id="wake-badge" hidden>` 在；
- `dist/helper/lib/main.js` 含 `dsh-wake` 与 `ipcMain.handle("orb:wake-config", …)`；
- `dist/host/index.js` 含 `/.dsh-orb/wake-assets/`、`wakeEnvironment()`、`record.type === "set-wake"`。

### 9.3 测试

`pnpm test` 在本沙箱**无法运行**：根脚本用的是 `node --test --test-isolation=process`，每个测试文件都要 spawn 子进程，直接撞上同一个 `spawn EPERM`（原文同 §9.2）。改为逐文件直跑（`node --experimental-transform-types <file>`，不进子进程）：

| 测试文件 | 结果 |
| --- | --- |
| `packages/host/tests/wake-assets.test.ts`（新） | **8 项全过**，`exit=0` |
| `packages/host/tests/wake-route.test.ts`（新，真 socket + 真模型） | **3 项全过**，`exit=0`；断言 `.wasm` → `application/wasm` 且 `content-length > 1 MB`、`.onnx` → `application/octet-stream`、错 token → 403、`..%2F..%2Fpackage.json` → 404、未知文件 → 404 |
| `packages/helper/tests/menu.test.ts` | **5 项全过**，`exit=0`（新增：唤醒菜单行双语 + 缺模型时禁用、preload 五个新通道 + `onWake` 订阅、以及「页面用到的唤醒 id / CSP / 四个状态 class」与 `floating.html`、`floating.css` 的一致性断言） |
| `packages/host/tests/routes.test.ts` | 2 项全过，`exit=0` |
| `packages/host/tests/` 其余 10 个文件 | `appearance / electron-runtime / open-main / overlay-guard / plugin / select-model / selection / services / windows-foreground` 全部 `exit=0` |
| `packages/client-settings/tests/section.test.mjs` | 2 项全过，`exit=0` |
| `packages/helper/tests/` 其余 8 个文件 | `avatar / chrome-windows / cloak / geometry / markdown / memes / overlay-geometry / transcript-model` 全部 `exit=0` |

**两个失败项，都与本次改动无关，是本机（Windows）既有的平台假设：**

1. `packages/host/tests/preferences.test.ts` → `✖ keeps the two model tracks and the selection language apart`：
   ```
   actual: 'millifraction'   expected: 'pixel'
   at packages/host/tests/preferences.test.ts:66:12
   ```
   该用例断言 `store.coordinateMode() === 'pixel'`，但 Windows 上 `defaultMillifraction()` 返回 `true`（`packages/host/src/preferences.ts`），为空 profile 的既定默认值。本次改动没有触碰 `readMillifraction` / `defaultMillifraction` 的语义（我在 `ProfileStore` 里只新增了 `wakeValue` 字段与两个方法）。**未修复**（按约束不动无关的既有行为）。
2. `packages/host/tests/runtime.test.ts` → `✖ creates a session, changes both models and access, and starts a new chat for millifraction`：
   ```
   Error: timed out waiting for the ball
     at waitFor (.../runtime.test.ts:244:45)
     at async TestContext.<anonymous> (.../runtime.test.ts:394:7)
   ```
   它先 `set-millifraction enabled: true` 再等「新会话被创建」；同一个 Windows 默认值让 `setMillifractionEnabled(true)` 变成无操作（`packages/host/src/orb.ts` 里 `if (this.store.millifractionEnabled() === enabled) return`），于是永远等不到。同样**未修复**。
   （该文件其余 13 项全过。）

另外 `packages/bundle/tests/install.test.mjs` 的两项 `exit=1` 是 `spawnSync(assemble.mjs)` 被沙箱拒（`built.status === null`，断言 `null !== 0`），属同一类环境限制；`assemble.mjs` 直接执行是通过的。

### 9.4 语法/加载检查（球窗代码不进 tsconfig，单独查）

```
node --check packages/helper/assets/wake.js      → EXIT=0
node --check packages/helper/assets/shell.js     → EXIT=0
node --check packages/helper/preload.cjs         → EXIT=0
node --input-type=module -e "import(...wake.js); new WakeEngine(...)"
  → status {"state":"disabled",...,"keyword":"hey_jarvis","threshold":0.7,...}
  → keywordFile() → hey_jarvis_v0.1.onnx          → EXIT=0
  → syncFromHelper() 后 onStatus 收到 ["disabled"]；publish('detected') 后为 ["disabled","detected"]
```

### 9.5 没能力验证的部分（诚实清单）

- **没有装到正在运行的 DSH 上，也没有重启它**（按约束）。本机 profile 用的是 `C:\Users\digua\.dsh\profiles\desktop\vendor\dsh-orb-0.0.0.tgz`，要生效必须 `pnpm --filter dsh-orb pack` 后重新安装并重开球 —— **未执行**。
- **麦克风授权链、`file://` 页面上的 `getUserMedia`、`AudioContext` 在未聚焦窗口能否 `resume()`、`dsh-wake://` 下 `onnxruntime-web` 能否真正建出 4 个 `InferenceSession`、以及真念「Hey Jarvis」能不能过阈值** —— 全部**未实测**，因为实测必须真的启动 Electron 球窗（会被沙箱拒绝 spawn，也会打扰正在使用的桌面）。
- **CPU 占用与阈值手感** —— 未测量。

### 9.6 未处理的收尾项

- 第一次失败的装配在 `packages/bundle/` 留下了一个 staging 目录 `.assemble-KvXA2N/`（`assemble.mjs` 自己 crash 时不会清理）。本次没有删除任何文件，所以它还在；可安全手动删除，下一次成功的装配不会再碰它。

---

## 10. 怎么用上它（需要在仓库外做决定，本次未执行）

1. 在仓库根执行 `pnpm build`（或在被沙箱限制的环境里按 §9.2 的等价步骤：逐个包跑 `tsdown`、helper 再跑一次 `tsdown --variant vendor`、最后 `node packages/bundle/scripts/assemble.mjs`）。
2. `pnpm --filter dsh-orb pack` 生成 `dsh-orb-0.0.0.tgz`，用它替换 `C:\Users\digua\.dsh\profiles\desktop\vendor\dsh-orb-0.0.0.tgz`（或直接在桌面应用的插件页重新添加这个 tgz）。
3. 重开悬浮球（球会跟随官方 dsh 进程，退出官方应用再打开即可；本次**没有**替你做这一步）。
4. 右键球 → 勾选「语音唤醒（Hey Jarvis）」：第一次会弹麦克风授权（Windows 上若系统隐私设置里禁用了桌面应用的麦克风，这里会失败并显示错误文案）。
5. 想改阈值/换成自己放的模型目录，编辑 profile 目录下的 `orb-wake.json`：

```json
{
  "enabled": true,
  "keyword": "hey_jarvis",
  "threshold": 0.5,
  "assetDirectory": "",
  "autoExpandOnWake": true
}
```

改完重启球生效（该文件在 helper 启动时读取一次）。


