# 悬浮球语音输入（唤醒后听写）· 实现说明

> 这份文档记录**唤醒以及唤醒之后那一步**：球录一句话 → 转成文字 → 填进球的输入框。
> 唤醒引擎本身的设计在 `voice-wake-for-orb-plan.md`，手动清单在 `wake-manual-test.md`。

## 0. 唤醒侧的两个真实 bug（本次在真机外实测发现并修掉）

把 helper 按 Host 的启动方式跑起来（`DSH_ORB_WAKE*` 环境变量 + 真实模型目录），
引擎根本没起来——**重启 DSH 也不会好**。两个原因：

| # | 症状（页面/日志） | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 球永远停在「语音唤醒加载中…」，helper 日志 `wake word stopped: onnxruntime script failed to load` | `floating.html` 的 CSP 只把 `dsh-wake://assets/` 放进了 `connect-src`，而 ORT 是作为**经典 `<script src="dsh-wake://…">`** 注入的，`script-src` 不含该 scheme → 标签被 CSP 拦掉 | `script-src 'self' 'wasm-unsafe-eval' blob: dsh-wake://assets/`；`menu.test.ts` 增加一条断言防回归 |
| 2 | CSP 修好后变成 `wake word stopped: Permission denied` | 每个窗口共用**同一个 session**：`openWindow()` 先装 `allowBallMicrophone`（放行 media），`attachOverlays()` 之后又装 `denyWindowPermissions`（一律拒绝）→ 后者把前者覆盖了 | 权限策略改成**认窗口**（只放行球窗自己的 `media` 请求，其余窗口继续拒绝），并在 overlay 装完之后再装一次 |

修完之后的实测（用 SAPI 合成一段 "Hey Jarvis"，16 kHz 单声道 PCM16，喂给被 stub 的
`getUserMedia`，让引擎以为自己在听麦克风）：

```
stub: {"state":"running","seconds":1.685,"tracks":1}
wake-listening → wake-detected expand-left expand-up expanded  「已听到唤醒词」
                → status「正在听你说…（说完停顿一下）」                ← 自动开始听写
FAKE-HOST got {"type":"transcribe","audioBase64":"UklGRiRYBw…"}        ← 481,828 B ≈ 15 s 的 16 kHz WAV
FAKE-HOST send {"type":"transcript","text":"打开记事本写一句问候"}
                → prompt:"打开记事本写一句问候"                        ← 文字进了球的输入框
```

也就是说：模型加载（`dsh-wake://` 协议 + ORT wasm + 4 个 onnx）、麦克风权限、
AudioWorklet 取帧、Silero VAD + 分类器判定、唤醒后的自动听写、WAV 上传、文本回填
这一整条**本地链路**都已实测通过；顺带排除了原计划里的未验证项「Windows 麦克风隐私
设置会挡住 Electron」——本机没有挡住。

剩下的唯一未实测环节：**宿主进程里 `ctx.speechToText` 那一次调用本身**（服务查找与调度）。
识别引擎已单独跑通，见第 2 节。

## 2. 本机语音识别链路已实测（不需要 DSH 重启就能验）

**模型缓存逐字节校验通过**（对照 provider 自带的 `runtime/assets.json` 固定版本）：

| 文件 | 大小 | sha256 |
| --- | --- | --- |
| `models/sensevoice-onnx/model.int8.onnx` | 239,233,841 ✓ | `c71f0ce0…cd51` ✓ |
| `models/sensevoice-onnx/tokens.txt` | 315,894 ✓ | `f449eb28…a1dc` ✓ |
| `models/silero/silero_vad.onnx` | 1,807,522 ✓ | `a35ebf52…af28` ✓ |

路径布局与 provider 的计算完全一致（`modelRoot = <dataRoot>/models/sensevoice-onnx`、
`vad = <dataRoot>/models/silero/silero_vad.onnx`，`dataRoot = dshHomePath('speech-to-text','sensevoice')`），
所以激活时判定为「已验证缓存」，**不会联网下载**。

**直接用 DSH 自己的 worker 转写**（worker 与依赖直接从 `app.asar` 里跑，Electron Node 模式 +
`app.asar.unpacked` 的原生 sherpa-onnx，没有复制任何东西）：

```
$ node dsh_orb/stt-test.mjs dsh_orb/hey-jarvis-canonical.wav
worker ready on port 56425 after 2s
result {"text":"Hey Javis.","audioSeconds":1.685,"inferenceSeconds":0.056}

$ node dsh_orb/stt-test.mjs dsh_orb/wake-sentence.wav     # 唤醒词 + 一句话 + 静音
result {"text":"Hey Javis. 打开即事本写一句问候。","audioSeconds":6.335,"inferenceSeconds":0.174}
```

返回结构是 `{ text, audioSeconds, inferenceSeconds }` —— 本插件的 wrapper 读的正是 `text`。

**整条链路（真实识别，非假数据）**：把合成的「Hey Jarvis + 一句话 + 静音」当作麦克风输入
（stub `getUserMedia`），球侧唤醒 → 自动听写 → 上传 120,364 B 的 16 kHz WAV → 真实 SenseVoice
转写（0.13 s）→ 文字回填输入框：

```
wake-detected expand-left expand-up expanded        「已听到唤醒词」
status「正在听你说…（说完停顿一下）」
FAKE-HOST transcribe: 120364 bytes, header=RIFF
FAKE-HOST send {"type":"transcript","text":"打开即事本写一句问候。"} (inference 0.128s)
prompt:"打开即事本写一句问候。"
```

**重启后如果状态行显示「宿主里没有语音转文字服务」**：说明宿主里没挂上语音插件。
到 DSH 主窗口 → Plugins → 确认 **Voice Input** 已启用（那四行由
`@deepseek-ai/dsh-experimental-voice-input-bundle` 的 `cordis.patch.yml` 插入；本 profile 的
`dsh.profile.bundles` 已包含它，且 profile 自己的 `cordis.patch.yml` 没有禁用它）。

## 3. 一句话链路
```
说出 “Hey Jarvis”
  └─ WakeEngine 判定命中（wake.js，球渲染层）
       ├─ 提示音 + 光环 + 自动展开面板（已实现）
       └─ 350 ms 后开始录一句：复用唤醒引擎已经打开的 16 kHz 麦克风 + Silero VAD
            ├─ 说完停顿 silenceMs（默认 1200 ms）→ 停止录音
            ├─ 上限 maxSeconds（默认 15 s）；一直没说话 6 s 放弃
            ├─ 组装成 16 kHz 单声道 PCM16 WAV（wake.js 的 framesToWav）
            └─ base64 → window.dshOrb.dictate()（preload）
                 └─ helper 主进程：orb:dictate → socket { type: 'transcribe', id, audioBase64 }
                      └─ Host（orb 插件）：ctx.get('speechToText') → resolve() → transcribe()
                           └─ 本机 SenseVoice（DSH 自带语音输入 bundle）→ 文本
                      ← socket { type: 'transcript', id, text } | { type: 'transcript-error', id, message }
                 ← helper 转发到页面：orb:transcript → applyTranscript()
            └─ 文本填进球的输入框（autoSend=false 时只填，等你自己回车）
```

音频**不出本机**：转写由 DSH 宿主进程里的 `ctx.speechToText` 完成，模型是
`C:\Users\digua\.dsh\speech-to-text\sensevoice\models\sensevoice-onnx\model.int8.onnx`
（SenseVoice int8 + `tokens.txt` + silero VAD，约 228 MB，已在磁盘上）。

### 3.1 不想喊唤醒词：右键菜单「语音输入（现在说一句）」

| 位置 | 行为 |
| --- | --- |
| 菜单行 | `packages/helper/src/menu.ts`；只在**唤醒引擎运行中**可用（录音复用引擎的麦克风），否则显示「语音输入（需先开启语音唤醒）」并置灰 |
| 触发 | helper → 页面发 `orb:dictate`；页面先展开面板再调用**同一个** `startDictation()` |
| 引擎没开 | 页面状态行提示「先开启语音唤醒（右键球）再试语音输入。」，不会开一个永远不来的麦克风 |
| 收到转写 | 面板若原本收起，会自动展开（否则文字落在看不见的输入框里），然后填入；`autoSend=true` 时直接发送 |

### 3.2 阈值实测（合成语音，供参考）

用 SAPI 合成的 "Hey Jarvis"（16 kHz 单声道 PCM16）循环喂给引擎，测首次命中耗时；
再用一段**不含唤醒词**的中文整句做误报对照（`dsh_orb/wake-threshold-test.mjs`）：

| threshold | 命中 | 首次命中 | threshold | 命中 | 首次命中 |
| --- | --- | --- | --- | --- | --- |
| 0.2 | ✓ | 1857 ms | 0.8 | ✓ | 1837 ms |
| 0.4 | ✓ | 1850 ms | 0.9 | ✓ | 1861 ms |
| 0.6 | ✓ | 1849 ms | 0.95 | ✓ | 1869 ms |

| 对照（不含唤醒词的中文整句） | 结果 |
| --- | --- |
| threshold 0.2（最灵敏） | 循环播放 24 s **未误报** |
| threshold 0.4 | 未误报 |

结论：这段合成音的得分高于 0.95；**命中需要完整说完一个短语（≈1.7 s，就是一次播放的时长）**。
真机建议：默认 `0.5` 起步；喊不醒就降到 `0.3–0.4`；出现误唤醒再升到 `0.7–0.8`。
（真机分数会低于这段干净合成音，所以"喊不醒"优先降阈值。）

### 3.3 录音时的实时声纹（复刻官方「语音输入」的波形）

官方那圈"声纹波动"不是频谱，是**实时音量**：`AudioContext.createAnalyser()` + 每 50 ms 取一次
`getFloatTimeDomainData` 的 RMS，把最近 80 个采样画成 80 根圆头竖线，最新的从**右**边缘进、
旧的往左推。球的录音行现在画的是同一个东西，几何与曲线都照抄官方的数值：

| 项 | 官方 capture row | 球的录音行 |
| --- | --- | --- |
| 音量来源 | `analyser` 的 RMS，50 ms 采样一次 | 引擎每帧的 RMS（1280 样本 @16 kHz = 80 ms） |
| 条数 / 画布 | 80 条，`viewBox="0 0 640 40"`，`x = i*8 + 4` | 同（条数取自 `WAVE_BARS`） |
| 静音 | 高 2 单位（y 19–21）的点线 | 同 |
| 满量程 | 高 36 单位（y 2–38） | 同 |
| 曲线 | `height = 1 + min(1, level * 5) * 17` | 同 |
| 明暗 | `opacity = 0.25 + i/120`，右端最亮 | 同 |
| 尺寸 | 高 24 px（低于 32 px 的录音键），`flex:1` | 同，配色用面板的 `--pin` |

两处**故意不一样**：

- **音量不从 WebAudio 拿，而是从唤醒引擎已经在跑的 16 kHz AudioWorklet 帧里算**（`wake.js` 的
  `processChunk`）。麦克风已经被引擎持有，再挂一个 `AnalyserNode` 就是第二路采集；而
  `processChunk` 是每一帧的必经之路——唤醒打分和听写都从这里过——所以在这里量一次，两件事共用。
- **只在 `dictationPhase === 'recording'` 时出现并绘制**。球窗口是常驻的，一个永远平着的波形会被
  当成坏掉的表；面板收起或已经在转写时，这一行就退回成原来那行状态文字（`#voice-wave` 是
  `display:none`，不是画成平的）。

每次 `dictate()` 会把音量历史清零，所以唤醒词和那声提示音不会被画进这一句的字幕里。
`body.wake-recording` 这个类由 `syncWake()` 单独负责开关——和徽章出自同一个函数，
不会出现"表在动但徽章说在待机"的错位。

### 3.4 听写结束后唤醒词被重新判定（真机 bug，已修）

**现象**（用户报的）：唤醒之后不说话 → 听写空转 6 秒自动结束 → **紧接着它自己又开了一次听写**
（又一次 `detected`、又一声提示音、面板又亮一次）。用户的原话是"它自动关闭之后，它又自动启用了语音识别"。

**根因**：听写期间 `processChunk` 在 `if (this.dictation !== undefined)` 那里直接 `return`，
`runModels` 完全不跑 —— 于是关键词链**自己的缓冲区一步都没前进**，停在了唤醒词那一刻：

| 缓冲区 | 听写开始时的内容 | 听写结束时的内容 |
| --- | --- | --- |
| `melBuffer`（76 帧 mel 滑动窗） | 唤醒词 | **还是唤醒词** |
| `embeddingHistory`（16 × 96 嵌入环） | 唤醒词 | **还是唤醒词** |
| `speechActive` | true | **true**（听写分支里没人更新它） |

听写一结束打分恢复，`while (this.melBuffer.length >= MEL_WINDOW_FRAMES)` 立刻拿这些旧帧去跑
嵌入 + 分类器 —— 判的正是刚刚那句唤醒词，`score` 再次过阈值，于是又一次命中。

两道本该拦住它的闸门也都失效了：

- `coolingDown` 只压 **`COOLDOWN_MS = 2500`**，而一句没人说话的听写要 **`DICTATION_NO_SPEECH_MS = 6000`** 才结束，
  冷却早就解除了；
- `speechActive` 仍是 true，所以 `score > threshold && speechActive` 这个条件也拦不住。

更麻烦的是它**会连着复发**：每轮循环只 `splice(0, 8)` 吐掉 8 帧，旧 mel 帧要好几轮才吐干净，
而每一轮又会顶出一次 6 秒的空听写。

**修法**：`finishDictation()` 里调用引擎本来就有的 `reset()`（它原本只在 `load()` 里用过），
把 `melBuffer`、`embeddingHistory`、VAD 的 `h/c` 递归状态和 `speechActive`/`vadHangover` 一起清掉。
于是听写一结束就从"静音"重新开始：窗口是空的、没有说话帧，**只有真的再喊一次唤醒词才能再次触发**。
注意 `reset()` 不碰 `state.frames`，所以已经录到的音频照样能正常组装成 WAV。

**同类入口一并堵掉**：`enable()` 在 `await this.load()` 之后也补了一次 `reset()`。
`load()` 只在第一次建模型时 `reset()`，之后 disable → enable 会拿着**上一次**的音频回来复判，
和上面是同一类错。

### 3.5 删掉唤醒后的绿圈

用户觉得那个绿圈没用（以后要用动画替换），所以整块删了：

- `body.wake-detected #ball` 的绿色光环（内圈 `0 0 0 6px rgba(46,160,67,.3)` + 外圈
  `0 0 30px 8px`），以及专为它写的 `@media (prefers-reduced-motion)` 块；
- 随之失去唯一引用的 `--wake-glow: rgba(46, 160, 67, 0.35)` —— 这个值记在这里，做动画时直接用。

**保留** `body.wake-listening #ball { box-shadow: none }`：它排在 `body.pinned #ball` 之后，
仍然是"只处于监听态时球上不带任何环（连 pinned 那圈灰色也不带）"的唯一来源；
删掉它会让固定面板的用户突然多出一圈灰色，等于凭空引入一个新环。

删掉之后，一次检测只由**提示音**和徽章文案（`已听到唤醒词`）表达，球本身不再有任何装饰。
`wake-detected` 这个类**没有删**——徽章的绿色仍然靠它。

### 3.6 唤醒成功播一次 `叹号.gif`

用户要求：喊中唤醒词的那一刻播一次 `叹号.gif`。

做法是复用已有的「一次性帧」机制（`click` / `done` 那套：`TimedFrame` + `step` 计数强制 `<img>` 重新加载 GIF），
新增第三个槽位 `wake`：

| 层 | 文件 | 加了什么 |
|---|---|---|
| 配置 | `~/.dsh/dsh-orb/memes.json` | `"wake": { "enabled": true, "file": "叹号.gif" }` |
| 选择器 | `packages/helper/src/memes.ts` | `MemeConfig.wake`、`MemePicker.wake()`、fallback、`readNamed(record.wake)`、配置示例注释 |
| IPC | `packages/helper/src/main.ts` | `ipcMain.handle('orb:meme-wake', …)` |
| 桥 | `packages/helper/preload.cjs` | `memeWake()` |
| 页面 | `packages/helper/assets/shell.js` | `wakeFrame/wakeShown/wakeTimer/wakeStep`、`fetchWake()`、`playWakeFrame()`、`syncGif()` 优先级、`refreshFrames()` 预取 |

三个刻意的选择：

1. **触发点**是 `applyWakeStatus()` 里 `if (wakeState !== 'detected') return` 这一关**之后**的第一句，
   排在 `setExpanded()` 和 `startDictation()` 之前——先给回应，再开面板、再抢麦克风。
   引擎的 `detected()` 由 `coolingDown` 保护（`COOLDOWN_MS = 2500`），每次检测只 `publish('detected')` 一次，
   所以动画不会因为 `detected` 状态保持 4 秒（`DETECTED_HOLD_MS`）而重播。
2. **`syncGif()` 的优先级是 `click` > `wake` > `done`**。点球是用户刚用手做的事，仍然最高；
   唤醒动画要压过「上一轮刚好结束」的 `done`——否则喊完唤醒词正等回应时，屏幕上还是上一个任务的收尾动画。
3. **首帧没预取到也会播**。`refreshFrames()` 挂在 `scheduleMemeBurst()` 上，`enabled:false` 时每
   `MEME_POLL_MS = 30000`（30 秒）才跑一轮，重启 DSH 后第一次唤醒很可能早于它。
   所以 `playWakeFrame()` 发现 `wakeFrame` 还没拿到时会现场 `fetchWake()` 一次再播，而不是静默跳过。

开销说明：`叹号.gif` 是 **1,186,460 字节 / 1120 ms / 28 帧**。它**不是每次唤醒都重新读盘**——
`refreshFrames()` 拿到一次就缓存在 `wakeFrame` 里，之后每次唤醒只是把同一份 data URL 重新挂到 `<img>` 上。
`1120 ms > ONE_SHOT_MIN_MS (900)`，所以整段播完，不会被截断。

路径上有个坑值得记一笔：`memes.json` 的 `dir` 指到的是 `大肥鱼表情包整合`（上一层），
而文件真实位置是 `大肥鱼表情包整合\大肥鱼表情包整合\叹号.gif`，靠 `MAX_DEPTH = 4` 的递归按裸文件名命中。
实测 `wake()` 返回 `ms=1120 bytes=1186460`，与文件本体字节数完全一致。

改 `memes.json` **不需要重启 DSH**（helper 侧 `CONFIG_TTL_MS = 10000`，每 10 秒重读一次）；
但 `memes.ts` / `shell.js` 属于打包内容，必须走「重打包 → 重装 → 重启 DSH」。

### 3.7 「点头」只在语音输入期间播（`voice` 槽位）

用户的现象：唤醒后叹号播完，球就一直播「点头」，不再回到闲置。

根因与唤醒动画无关，是两条规则的叠加：

1. **自定义头像本身就是 `点头.gif`**：`~/.dsh/profiles/desktop/orb-avatar` 与
   `大肥鱼表情包整合\大肥鱼表情包整合\点头.gif` **逐帧像素完全相同**（19 帧 / 760 ms / 500×500）。
2. **`syncGif()` 里有一条「面板展开 → 显示头像」的规则**：
   `const play = expanded || running || asking() || tccGateVisible || attachedSelection !== ''`，
   命中就 `gif.src = avatarSrc`。而配置里 `autoExpandOnWake: true`，唤醒会自动展开面板，
   而且**面板不会自己收起来**——于是头像（＝点头）一直循环，`idle` 永远轮不到。

改动如下：

| 层 | 文件 | 加了什么 |
|---|---|---|
| 配置 | `~/.dsh/dsh-orb/memes.json` | `"voice": { "enabled": true, "file": "点头.gif" }` |
| 选择器 | `packages/helper/src/memes.ts` | `MemePicker.voice()`（**返回 `data:` URL，不是 `TimedFrame`**）、`MemeConfig.voice`、fallback、`readNamed`、注释 |
| IPC | `packages/helper/src/main.ts` | `orb:meme-voice` |
| 桥 | `packages/helper/preload.cjs` | `memeVoice()` |
| 页面 | `packages/helper/assets/shell.js` | `voiceSrc` / `voicePending`、`loadVoiceFrame()`、`syncGif()` 的 voice 分支、`refreshFrames()` 预取、`setDictationPhase()` 重绘并按需取帧、**`play` 分支改成 `expanded && idleSrc === undefined`** |

三个要点：

1. **`voice` 是循环帧，不是一次性帧**。`click` / `done` / `wake` 都是 `TimedFrame`（带 `ms`，播一遍就撤），
   而 `voice` 要覆盖「麦克风开着 + 宿主还在识别」这一段**长度事先不知道**的时间，
   所以它和 `idle` / `typing` 一样返回 `data:` URL，由 `dictationPhase` 决定什么时候穿上、什么时候脱掉。
2. **`syncGif()` 里的位置是 `thinking` 之后、`hover` 之前**。放在 agent 自己的帧之下，是为了让
   「上一条还在流式回答」时球保留回答的脸；放在 `hover` 之上，是为了不让鼠标恰好停在球上就把麦克风状态盖掉。
3. **`play` 分支的修改才是这次「回得去」的关键**：`expanded` 单独一条不再足以显示头像，
   改成 `expanded && idleSrc === undefined`。即配了 `idle` 循环时，面板开着也播 `idle`；
   没配 `idle` 的 profile 行为完全不变（仍然回落到头像）。
   **副作用要记住**：头像现在只在 agent 真正工作时出现（`running` / `asking()` 等），
   面板静置时显示的是 `idle` 循环。

另外 `setDictationPhase()` 现在也会调 `syncGif()`（之前只有 `syncWake()`）：姿势是从这个阶段选出来的，
阶段变了却不重绘，球就会一直戴着上一个阶段的脸。

时序（`autoSend: true`）：`叹号` 1120 ms → `点头`（`recording` 起，到 `transcribing` 结束）→ 发送 →
`reply` / `thinking` / `tool` → `done`（摇铃）→ `闲置`。

### 3.8 鼠标移到球上时球闪一下（跑到面板左上角）

用户的现象：鼠标碰到球的瞬间，球（GIF）会跳到左上角闪一下。

**根因已经真机测出来了，是窗口重排本身，和页面布局无关。**

前两次修法都建立在「中间有一帧用了旧布局」这个猜测上，然后各自给出一种「事后纠正」的办法。
两次都在真机上完全无效。于是这一轮不再推理，改成两侧同时测量：

| 测什么 | 怎么测 | 结果 |
|---|---|---|
| 页面布局有没有错帧 | 往 `shell.js` 追加逐帧探针，每帧记 `window.screenX + ball.getBoundingClientRect().left/top`（球和 GIF 各一份），结果经 `document.title` 用 `GetWindowTextW` 读回 | 60fps 下**从未**离开过静止位置，整轮只有一帧偏 4px |
| 像素上到底有没有闪 | 球临时改成纯洋红（平色圆盘），用自建 BitBlt 以 **100fps** 扫一片网格、每帧算洋红质心 | 6 次悬停抓到 **7 帧**，每次质心都精确落在同一个像素 |

那 4px 是**第二版修法自己引入的**，不是原 bug：`bottom: 12px` 与 `top: 12px` 只在窗口正好是
球加两侧留白时才等价，而实测有一次客户区高度是 **316 CSS px**（316 − 12 − 288 = 16，比 12 多 4）。
横轴的不变量是准的，纵轴不是。

像素测量给出的是决定性数字。展开前：折叠窗口 `2185,409 390×390`；展开后：

```
expanded window : 1648,119 928x680        (928/1.25 = 742, 680/1.25 = 544)
```

偏移正好是 CSS 的 (−430, −232)，也就是方向类要补的那一段。而闪的那一帧：

```
t=  962 ms  centroid=300,300  600px from rest   magenta samples=144  → 屏幕 (1848,319)
t= 3202 ms  ...同一位置        t= 5452 ms  ...    t= 7693 ms  ...
t= 9942 ms  ...                t=12194 ms  ...    t=12202 ms  ...
```

**预测位置是 (1843,314)，实测 (1848,319)——差 5px，就是网格量化误差。**
`magenta samples=144` 表示网格内那 9 个采样点每个都满格（9 × 16 = 144），即**整个球盘**被完整画在了那里，
不是边缘、不是残影。

所以机制是：**窗口长大了，但它仍然呈现着折叠时那张画布，而那张画布被贴在「新窗口的原点」上。**
折叠画布里球在它自己的左上角（12, 12），于是球出现在新原点 + (12, 12)——比该在的地方左移一个面板、上移一个球。

**收起是同一件事的镜像，也测到了**：每周期有恰好一帧「根本没有球」（`6 of 1422`，间隔 2250ms 一次）。
收起时窗口从 928×680 缩回 390×390，旧画布里球在新原点 + (552, 305)——落到小窗口之外，于是球整帧消失。

第一版文档里写「收起从来不闪，所以不是合成器残留」，**那条判断是错的**：收起不是不闪，是**看不见**。
当时只是没人量过。

#### 为什么前两次修法注定失败

球的屏幕位置 = **窗口原点（主进程）** + **球在窗口内的偏移（渲染进程）**。
重排时要让球不动，这两项必须**在同一帧里**互抵。而它们分属两个进程、两次 IPC，
不可能落在同一张已提交的画布上。所以只要展开会改变窗口的原点或尺寸，
就**一定**存在一帧球在别处——差别只是被看见的是「错位」还是「消失」。

第一版给球加 `transform` 去钉住屏幕位置：那是在错误那一帧**之后**纠正，赢不了
（而且实测位移恒为 0，最可能是 Windows 上窗口矩形异步送达，`resize` 派发时 `window.screenX` 还是旧值）。

第二版改用「先要角落、再改窗口」：布局侧确实做到了每帧都对（探针证明了），
**但错的不是布局**——画布是新旧交替的问题，页面怎么排都没用。**别再试第三次「事后纠正」。**

#### 第二版修法留下的东西（保留，但不足以修好）

那次改动本身没有害处，只是**修错了地方**：

| 层 | 名字 |
|---|---|
| `FloatingPlacement` | `expandCorner(): ExpandState` —— 和 `setExpanded(true)` 用同一个 `expandedOverlayBounds()`，但不调 `setBounds`，只回答 |
| 主进程 | `ipcMain.handle('orb:expand-corner')` |
| preload | `api.expandCorner()` |
| 页面 `setExpanded(true)` | `applyDirection(await api.expandCorner())` → `await api.setExpanded(true)` → `applyDirection(state)` |

第二次 `applyDirection(state)` 不能省：球挂在屏幕边缘外时，展开的 overlay 会被 `clampWindowOrigin`
拉回工作区，那不在预测里。

上一轮那三个「钉球」函数（`anchorBall` / `pinBallToAnchor` / `releaseBall`）和那个 `resize` 监听
**已全部删除**，不是留着不用：一个跟布局较劲的 `transform` 比没有更糟（拖动中只有 `move()` 有权决定球的位置）。

#### 真正的修法：让窗口**永远不变尺寸**

既然错帧来自「窗口原点变了、球的偏移还没变」，那就让**折叠态和展开态的窗口矩形完全一致**。
展开不再是「把窗口长大」，而只是**把面板显示出来**（`panel.hidden`）：

- 窗口一直是面板尺寸（742×544），球永远待在同一个角，**屏幕位置在折叠和展开之间一模一样**；
- 方向只在**拖动结束时**重算，那时球本来就在动；
- 代价：折叠时窗口仍然覆盖 742×544，而里面只画了一个球。那块空白**必须能透过点击**，
  否则它会挡住桌面上那片区域。**拖动期间保持不穿透**（拖动时指针经常跑到球外，
  切回穿透会丢 pointerup）。

#### 点击穿透的判定必须在主进程，页面做不到

窗口大部分是空白，所以要 `setIgnoreMouseEvents(true, { forward: true })`，
指针在球或面板上时切回 `false`。看起来这只差一个「谁来判断指针在不在球上」，
而**唯一能判断的就是主进程**：

- 页面知道自己的元素在哪，但它**永远发现不了指针到来**。窗口穿透时渲染进程**收不到任何
  `mousemove`**——`forward: true` 在本机**实测无效**，不是没配。实测方式：给 body 加一圈
  `box-shadow: inset` 染色，指针划过球时读边框颜色，恒为「渲染进程完全没收到事件」的颜色。
  （不能用 `document.title` 当探针：`applyStaticText()` 把 `messages.title` 写进
  `<title id="page-title">`，会覆盖任何 `document.title` 写入，窗口标题恒为「桌面 agent」。）
- 所以「页面上报布尔值」的设计**行不通**：页面永远报「不在」，窗口永久透明，球永远点不到。

于是反过来：**主进程轮询，页面上报几何**。

| 谁 | 做什么 |
| --- | --- |
| 主进程 | `setInterval` 30Hz 跑 `screen.getCursorScreenPoint()`，自己判断在不在任一矩形内，然后 `setIgnoreMouseEvents` |
| 页面 `syncHitTest()` | 只上报**矩形**（球 / 面板 / 停止键 / dock tab 的屏幕坐标），拖拽期间额外加上整窗 |
| preload | `setHitTest(regions)` / `direction()` |

判定用矩形而不是圆形：矩形的角本来就是透明的，说它是球的一部分并不损失什么。

**切换捕获的那一刻还要把指针位置告诉页面**（`sendPointer` → `orb:pointer` → `api.onPointer`）。
因为 `pointerenter` / `pointerleave` 描述的是**移动**，而指针**跳过边界后停住**就不会再有事件
（快速甩动、触控板点击、脚本 `SetCursorPos`）：页面最后看到的是边界另一侧的事件，于是
**面板开着而指针已经走了**，或者**指针停在球上而面板不开**，直到用户又动了鼠标。
主进程是唯一知道「越界发生了」的一方——因为改变窗口鼠标行为的就是它。

实测两种方式都通过：连续走上去、一次 `SetCursorPos` 瞬移上去，面板都开；移开后都收。

所以预览里的「先要角落、再改窗口」只是一个**正确的中间步骤**，不是终点：
它让布局每帧都对，但仍然每帧都在重排窗口。真正的终点是**不再重排**。

一条仍然成立的判断：**不要做 CSS 过渡**。窗口尺寸是瞬间变的，而球在屏幕上的位置**不该变**。
加过渡只会把一帧的闪现变成 200ms 的滑动。

#### 验收：0 / 1878 帧

`dsh_orb/flash_spot.py` 自建 `CreateDIBSection`（32bpp top-down）+ 单次 `BitBlt` +
`ctypes.string_at` 零拷贝读网格洋红像素，实测 100fps（`ImageGrab.grab` 每次约 30ms 固定开销，
只有 8~25fps，不可用）。往球上临时刷一层洋红（`ORB-FLASH-DEBUG`，只注入安装版，源码没有），
每帧算一次球心，再和静止位置比：

```
frames: 1878  median 10.00 ms (100 fps)
collapsed window: 1648,119 932x684
expanded window : 1648,119 932x684
the window is one rect in both states, as intended
frames with no ball at all : 0 of 1878
frames with the ball moved : 0 of 1878
```

**「窗口两种状态同尺寸」现在是验收项而不是失败条件**——改之前它当然不成立。

#### 测量本身踩过的坑（都是会骗人的）

- **整块 diff 判「面板开没开」不可用。** 窗口大部分透明，看得穿后面，而后面是 DSH 的流式输出，
  文字一直在变。实测「9.7% 变了」全是回复正在被写出来的那一条带状区域，跟面板无关。
  面板和流式文字的区别**不是「有没有变」而是「变得多密」**：开面板是一张 420×520 的卡片整片重绘，
  文字只划过格子。所以按 32px 格子算密度（`repainted_area`），取高密度格子的包围盒。
- **别用颜色判面板开合。** 深色主题下卡片是近黑，按「近白像素计数」永远是 0。
- **别从窗口矩形推算球的位置。** 球在哪一列由方向类决定，而这个方向页面**不再通过
  `document.title` 上报**了（标题被 `applyStaticText()` 占用），`page_direction()` 一直在静默回落成
  默认值，于是算出来的是**窗口里的空白**。可靠办法是 `find_moving_box()`——**GIF 每帧都在动**，
  两帧一减就是它，与方向、也与是否注入了洋红无关。
- **`SetCursorPos` 一次瞬移不是「更弱的真实悬停」，是另一种事件。** 窗口在主进程轮询到之前
  一直是穿透的，瞬移途中没有任何 `mousemove`，渲染进程可能整个错过这次越界。
  （这正是上面加 `orb:pointer` 的原因。）所以 `hover_works.py` 两种都测。

### 3.9 点头停不下来：收尾那一侧漏了重画

现象：唤醒后不说话（或识别完了），徽标已经回到「等待唤醒词」，**球却一直点头**，不回 `闲置`。

`voice`（点头）是按 `dictationPhase` 选的：

```js
if (voiceSrc !== undefined && (dictationPhase === 'recording' || dictationPhase === 'transcribing'))
```

`dictationPhase` 有两个边界，**两个都必须重画 GIF**——`syncWake()` 只管徽标和 class，不碰 `<img>`：

| 边界 | 函数 | 原来重画了吗 |
|---|---|---|
| 开口（进入录音/识别） | `setDictationPhase()` | ✅ 有 `syncGif()` |
| 收尾（录音或识别结束） | `endDictation()` | ❌ **只有 `syncWake()`** |

`endDictation()` 是所有结束路径的唯一汇合点（空语句、引擎被关、识别失败、host 不回话），
所以漏这一下，球就停在 `voice` 那一帧，直到别的事件碰巧触发 `syncGif()`。
**说话成功那条路看不出来**——转写结果会进输入框，`typing` / `running` 立刻把它挤掉；
而**空语句那条路什么都没有**，于是永远点头。

修法就是补上：

```js
function endDictation() {
  dictationBusy = false
  dictationPhase = undefined
  syncWake()
  syncGif()   // ← 补上
}
```

回落到 `idle`（`闲置`）的路径逐段确认过：`voice` 之后是
`hover`（要 `hovering`，唤醒走的是程序化展开面板、不置 `hovering` → 跳过）→
`play`（`expanded && idleSrc === undefined`，配了 `idle` 即 false → 跳过）→
`sleep`（`nap` 只在 `restingNow()` 里推进，而它要求 `!expanded` → 跳过）→
`skit`（偶发）→ **`idle`**。

测试也补了收尾那一侧：`transcript-model.test.ts` 里原来注释写着「两个边界都要重画」，
却只断言了 `setDictationPhase`——**断言没跟上注释**，这条缺口正是 bug 进来的地方。

## 4. 配置（`C:\Users\digua\.dsh\profiles\desktop\orb-wake.json`）

```json
{
  "enabled": true,
  "keyword": "hey_jarvis",
  "threshold": 0.5,
  "assetDirectory": "C:\\Users\\digua\\Desktop\\dsh-orb-cordis\\dsh-voice-dialog\\assets",
  "autoExpandOnWake": true,
  "dictation": {
    "enabled": true,     // 唤醒后是否接着录一句
    "silenceMs": 3800,   // 说完停顿多久算结束（300–10000）
    "maxSeconds": 15,    // 单句上限（2–120），也是送给语音服务的时长上限
    "autoSend": true     // false=只填进输入框；true=识别完直接发送
  }
}
```

改完要**重启 DSH**（Host 启动 helper 时把这份配置作为 `DSH_ORB_WAKE` 环境变量注入；
helper 读一次就固定）。`dictation` 字段缺失时用上面这套默认值。

## 5. 改到的文件

| 文件 | 改动 |
| --- | --- |
| `packages/host/src/transcribe.ts` | **新增** `createTranscriber(ctx)`：懒取 `speechToText`，`snapshot/select → prepare → resolve → transcribe`，全部不抛异常，返回 `{ok:text}` 或 `{ok:false,reason}` |
| `packages/host/src/orb.ts` | `wakeEnvironment()` 里带上 `dictation`；新增 `answerTranscription()`；`onControl` 处理 `transcribe` 消息 |
| `packages/host/src/preferences.ts` | `WakeSettings.dictation`（`DictationSettings`）+ 读写/夹取 |
| `packages/helper/src/wake.ts` | `WakeConfig.dictation` + `readDictation()` |
| `packages/helper/src/menu.ts` | 新增「语音输入（现在说一句）」菜单行（引擎未运行时置灰并换文案） |
| `packages/helper/src/main.ts` | `orb:dictate` IPC（转成 `transcribe` 消息）；`deliver()` 转发 `transcript` / `transcript-error`；`wakePayload()` 带上 `dictation`；菜单行动作 |
| `packages/helper/preload.cjs` | `dictate(payload)`、`onTranscript(cb)`、`onDictate(cb)` |
| `packages/helper/assets/wake.js` | `dictate({silenceMs,maxSeconds})`、`collectDictation()`、`finishDictation()`、`framesToWav()`；录音期间暂停唤醒打分；`teardown()` 会结束在途录音 |
| `packages/helper/assets/shell.js` | 命中唤醒后 `startDictation()`；`applyTranscript()` 填输入框或发送；状态行文案（正在听/没听清/超时/失败） |
| `packages/host/tests/preferences.test.ts` | 新增 `wake preferences` 两个用例（默认值、夹取、改开关后仍保留） |

### 本轮（实时声纹）

| 文件 | 改动 |
| --- | --- |
| `packages/helper/assets/wake.js` | 新增 `WAVE_BARS` 导出、`levelOf()`（RMS）、`level` 环形历史 + `resetLevels()` / `waveform()`；`processChunk` 每帧记一次音量；`dictate()` 与 `teardown()` 清空历史 |
| `packages/helper/assets/floating.html` | 新增 `#voice-row`，把 `#status` 和 `#voice-wave`（官方 `viewBox`）放成一行 |
| `packages/helper/assets/floating.css` | `#voice-row` / `#voice-wave` 的官方尺寸与配色；`body.wake-recording` 下才显示 |
| `packages/helper/assets/shell.js` | `buildWaveform()` / `restWaveform()` / `paintWaveform()` / `followWaveform()`；`syncWake()` 加 `wake-recording` 类；`setDictationPhase('recording')` 起绘制循环 |
| `packages/helper/tests/wake-levels.test.ts` | **新增**：环形历史的四个用例（初值、方向、滑动窗口、听写前的清零与共用） |
| `packages/helper/tests/transcript-model.test.ts` | **新增** `drawWaveform()` 与 4 个用例：把 `shell.js` 的函数体切出来 `new Function` 执行，验证官方曲线（静音点线 / 0.1 → 9.5 / 0.2 与 1.0 夹在 18，即 y 2–38）与复位；`wake badge` 用例补上 `wake-recording` 的断言 |
| `packages/helper/tests/menu.test.ts` | 断言表存在 `wake-recording` 规则、`#voice-wave` 在标记里、音量取自 `wake.waveform()`；并断言绿圈与 `--wake-glow` 不会回来 |

### 本轮（修自动重触发 + 删绿圈）

| 文件 | 改动 |
| --- | --- |
| `packages/helper/assets/wake.js` | `finishDictation()` 里调用 `this.reset()`（清 mel / embedding / VAD 状态与 `speechActive`），这是"听写结束后又自己开录"的根因修复；`enable()` 在 `load()` 之后也补一次 `reset()`，堵住 disable→enable 带着旧音频复判的同类入口 |
| `packages/helper/assets/floating.css` | 删掉 `body.wake-detected #ball` 的绿色光环、只服务于它的 `@media (prefers-reduced-motion)` 块、以及失去引用的 `--wake-glow`；唤醒那段的注释改成"检测只靠提示音和徽章"；保留 `body.wake-listening #ball` 并注明它仍在挡 pinned 环 |
| `packages/helper/tests/wake-levels.test.ts` | 新增 `wake scoring buffers` 用例：听写结束后 `melBuffer` 空、嵌入环 16 条全零、VAD 状态归零、`speechActive` 为 false；桩引擎补上已加载引擎本就有的 VAD 状态 |
| `packages/helper/tests/menu.test.ts` | 断言 `wake-glow` 与 `body.wake-detected #ball` 都不存在（钉住这次是有意删的） |

### 本轮（唤醒成功播 `叹号.gif`）

| 文件 | 改动 |
| --- | --- |
| `~/.dsh/dsh-orb/memes.json` | 新增 `"wake": { "enabled": true, "file": "叹号.gif" }`（这个文件不需要重打包） |
| `packages/helper/src/memes.ts` | `MemePicker.wake()`、`MemeConfig.wake`、`readConfig` 的 fallback 与解析、配置示例注释；实现与 `click`/`done` 一致：`timedFrame()` 取 GIF 自身时长 |
| `packages/helper/src/main.ts` | 新增 `ipcMain.handle('orb:meme-wake', …)` |
| `packages/helper/preload.cjs` | 新增 `memeWake()` |
| `packages/helper/assets/shell.js` | `wakeFrame/wakeShown/wakeTimer/wakeStep`；`fetchWake()` + `playWakeFrame()`（未预取到会现场取一次）；`syncGif()` 里插在 `click` 与 `done` 之间；`refreshFrames()` 预取；`applyWakeStatus()` 在 `detected` 关口后立刻调用 |
| `packages/helper/tests/memes.test.ts` | 新增 `wake` 槽位解析用例（正常 / 未配置 / `enabled:false` / 文件不存在四种） |
| `packages/helper/tests/transcript-model.test.ts` | 新增 `wires the wake reaction end to end`：三层连线、`wakeStep` 与时长、按需取帧、`syncGif()` 优先级顺序（`click` > `wake` > `done`）、只在 `detected` 关口之后播 |

### 本轮（「点头」只在语音输入期间播）

| 文件 | 改动 |
| --- | --- |
| `~/.dsh/dsh-orb/memes.json` | 新增 `"voice": { "enabled": true, "file": "点头.gif" }` |
| `packages/helper/src/memes.ts` | `MemePicker.voice()`、`MemeConfig.voice`、fallback、`readNamed(record.voice)`、配置示例注释；返回 `data:` URL（循环帧），不是 `TimedFrame` |
| `packages/helper/src/main.ts` | 新增 `ipcMain.handle('orb:meme-voice', …)` |
| `packages/helper/preload.cjs` | 新增 `memeVoice()` |
| `packages/helper/assets/shell.js` | `voiceSrc` / `voicePending`、`loadVoiceFrame()`；`syncGif()` 在 `thinking` 与 `hover` 之间插入 voice 分支，条件为 `dictationPhase` 是 `recording` 或 `transcribing`；`refreshFrames()` 预取；`setDictationPhase()` 调 `syncGif()` 并在 `recording` 起时按需取帧；**`play` 分支由 `expanded \|\| …` 改为 `… \|\| (expanded && idleSrc === undefined)`** |
| `packages/helper/tests/memes.test.ts` | 新增 `voice` 槽位用例：返回 `data:` URL、未配置 / `enabled:false` / 文件不存在都是 `null` |
| `packages/helper/tests/transcript-model.test.ts` | 新增两个用例：`wires the dictation pose to the recording, and only to it`（三层连线、阶段门控、`setDictationPhase` 重绘与按需取帧、优先级夹在 `thinking` 与 `hover` 之间）与 `gives the ball back its resting loop instead of an open panel holding the avatar`（钉住 `expanded && idleSrc === undefined`，并断言 `expanded \|\|` 不再出现） |

### 本轮（修「鼠标移上去球闪一下」，第二版）

第一版（在页面里用 `transform` 钉住球）**真机确认无效**，已整段删除。这一版改的是**顺序**，
动到了 helper 的 IPC 协议：

| 文件 | 改动 |
| --- | --- |
| `packages/helper/src/geometry.ts` | `FloatingPlacement` 新增 **`expandCorner(): ExpandState`**：与 `setExpanded(true)` 同一套 `expandedOverlayBounds()` 计算，但**不调 `setBounds`**（纯读，不动窗口） |
| `packages/helper/src/main.ts` | 新增 `ipcMain.handle('orb:expand-corner', …)`（只回答）；顺手修好上一轮编辑把 `orb:expand` 那一行压成一行的格式 |
| `packages/helper/preload.cjs` | 新增 `expandCorner()` |
| `packages/helper/assets/shell.js` | `setExpanded(true)` 的展开分支改成 **先 `applyDirection(await api.expandCorner())` 再 `await api.setExpanded(true)`**（之后照旧再 `applyDirection(state)`）；`applyDirection()` 去掉 `releaseBall()` 并补注释；**删除** `ballPin` / `anchorBall()` / `pinBallToAnchor()` / `releaseBall()` 与 `window` 的 `resize` 监听（共 54 行） |
| `packages/helper/tests/geometry.test.ts` | 新增 describe `the corner is knowable before the window grows into it` 四条用例：预测等于 `setExpanded(true)` 的返回且不碰窗口、两个方向各一条、被 `clampWindowOrigin` 拉回时仍一致（球 x=1800 时窗口被夹到 1190）、以及 **CSS 不变量** `--ball + 2 × --chrome === BALL_WINDOW_SIZE`（这条就是「折叠时方向类等于空操作」的依据） |
| `packages/helper/tests/transcript-model.test.ts` | 删掉 `pinBall()` 桩与 4 个钉球用例；新增 `wears the corner before the helper grows the window into it`（三层连线 + 顺序 + 中间必须戴上 + resize 之后仍 `applyDirection(state)`）与 `leaves nothing holding the ball across the resize`（钉球那套必须彻底不存在，且 `applyDirection` 仍是放置球的唯一手段） |

## 6. 已验证 / 未验证

**已验证（可复现）**

- 唤醒引擎真的能起来：CSP 修好后 ORT + 4 个模型加载成功、麦克风拿到、球进入 `wake-listening`
  （`dsh_orb/wake-test.mjs`）
- 真实唤醒判定：合成的 "Hey Jarvis" 喂进 stub 麦克风 → `wake-detected` + 面板自动展开
  （`dsh_orb/wake-detect-test.mjs`）
- 真实识别整条链路：唤醒 → 自动听写 → 上传 120,364 B WAV → 真实 SenseVoice → 文字进输入框
  （`wake-detect-test.mjs … transcribe-real`，见第 2 节输出）
- `framesToWav` 产物用 Python `wave` 模块校验：`channels=1 rate=16000 width=2`，24 s 音频 768,044 字节 ✓
  （宿主 `speechToText` 要求“canonical base64 + 16 kHz 单声道 PCM16 WAV”）
- 页面 → helper → socket → 回传 → 输入框整条链路：用 `dsh_orb/dictate-test.mjs`
  起假 Host，成功路径填进 `打开记事本写一句问候`，失败路径显示 `语音输入失败：假装识别失败` ✓
- 模型缓存与 provider 的固定版本逐字节一致；DSH 自己的 worker 2 秒载入并 0.06–0.17 秒出文本 ✓
- `wakeConfig()` 已经把 `dictation` 送到页面 ✓；helper/host 两侧 typecheck 通过 ✓；helper 单测 117/117 ✓
- 音量历史：`wake-levels.test.ts` —— 80 格初值全零、最新值落在**最右**一格、
  滑动窗口只留最新 80 帧且严格左旧右新、`dictate()` 前后清零并让听写帧进入同一份历史 ✓
- 波形几何：`transcript-model.test.ts` 的 `drawWaveform()` 把 `shell.js` 的三个函数真的跑起来 ——
  80 根条（条数取自引擎的 `WAVE_BARS`）、`x1 = i*8+4`、透明度 `0.25 + i/120`、
  静音 y 19–21、`0.1 → y 10.5–29.5`、`0.2` 与 `1.0` 都夹在 `y 2–38`、`restWaveform` 回基线 ✓
- 自动重触发的根因修复：`wake scoring buffers` 用例证明 `finishDictation()` 之后
  `melBuffer` 为空、嵌入环 16 条全零、VAD 的 `h/c` 归零、`speechActive` 为 false ✓
  （即：听写结束后缓冲区里不再残留唤醒词，分类器无从再次命中）
- 绿圈确实没了：`menu.test.ts` 断言 `wake-glow` 与 `body.wake-detected #ball` 都不存在 ✓
- 唤醒动画的槽位真的解析到了那个文件：拿真实 `~/.dsh/dsh-orb/memes.json` 调用 `wake()`，
  返回 `ms=1120 bytes=1186460`，与 `叹号.gif` 本体（1,186,460 字节、1120 ms）完全一致 ✓
- 唤醒动画三层连线齐全：`memes.test.ts` 的四种配置分支 + `transcript-model.test.ts` 的
  `wires the wake reaction end to end`（IPC / 桥 / 页面三处都能 grep 到；优先级顺序被钉住）✓
- 装进 desktop profile 的那份包与源码逐字节一致（`cmp` 过 `shell.js` 与 `preload.cjs`）✓
- 「点头」的根因是实测出来的，不是推的：`~/.dsh/profiles/desktop/orb-avatar` 与
  `大肥鱼表情包整合\大肥鱼表情包整合\点头.gif` **逐帧像素完全相同**（Pillow 解码后逐帧 `tobytes()` 比较）✓
- `voice` 槽位真的解析到那个文件：拿真实 `~/.dsh/dsh-orb/memes.json` 调用 `voice()` → 793,056 字节，
  与 `点头.gif`（＝头像）字节数一致 ✓
- 姿势门控与优先级顺序被单测钉住（`transcript-model.test.ts` 两个新用例）✓
- `expandCorner()` 是**执行**过而不是 grep 过的：它返回的方向与紧随其后的 `setExpanded(true)` 的返回
  完全相等（`left/up` 与 `right/down` 两个方向各一条），并且调用它**不会**改动窗口矩形 ✓
- clamp 情形也一致：球在 x=1800（挂在 1920 宽屏幕右缘外）时预测仍是 `left`，
  而 `setExpanded(true)` 落地后窗口 x 被夹到 `1920 - 742 + 12 = 1190` ✓
- 「折叠尺寸下方向类是空操作」这条前提有测试守着：`--ball(288) + 2 × --chrome(12) === BALL_WINDOW_SIZE(312)`，
  且 `floating.css` 里这两个变量各只声明一次、全工程没有任何 zoom（否则 CSS px 就不等于 DIP，整套推理失效）✓

**未验证（只差用户重启 DSH 这一步）**

1. 宿主里 `ctx.speechToText` 的服务查找与真机冷启动（引擎本身已单独跑通）。
2. 真人对着真麦克风说话的效果（阈值/停顿）；本机麦克风权限链已排除问题。
3. 「唤醒后不说话」这一条真人复现（第 3.4 节的根因是从代码路径推出来的：
   听写期间 `runModels` 不跑、缓冲区停在唤醒词、冷却已过期、`speechActive` 仍为 true）。
4. 唤醒动画的**观感**：1120 ms 播完、和随后的开面板/录音怎么衔接，只能真机看。
   链路和时长都已验，剩下的是审美判断。
5. 「点头只在语音输入期间」的真机观感：特别是 `recording` 起止那一刻换脸是否跟手
   （`setDictationPhase()` 已经补上 `syncGif()`，但肉眼看有没有闪一下只能真人判断）。
6. 展开那一帧是否真的不再闪（第 3.8 节）。**第一版补丁真机确认无效**，这一版换了机制：
   不再是「出错后再纠正」，而是让球根本不需要移动（展开前就把角落戴上）。
   剩下要眼睛确认的是「球在屏幕上的位置全程未动」这件事本身。
7. 「面板展开时球不移动」这条在**球半挂在屏幕边缘外**时不成立——那种位置会触发 `clampWindowOrigin`，
   球会跟着窗口被拉回工作区（这是有意的，否则面板会伸出屏幕）。只能用眼睛确认那一下不刺眼。

## 7. 出问题时看哪里

- 球面板里的状态行：`正在听你说…` / `没听清，再说一次吧。` / `识别超时了` / `语音输入失败：<原因>`
- 原因直接来自宿主：`宿主里没有语音转文字服务`（profile 没装语音输入 bundle）、
  `语音模型还没就绪，请再说一次`（冷启动）、`没有识别出文字`（录音太短/全静音）
- helper 日志（官方应用的输出里）会打印 `dsh-orb helper: wake word stopped: <原因>`；
  转写请求本身不打日志，只看球的状态行。
- **空听写结束后又自己开录一次**：这是第 3.4 节那个 bug 的样子。若复活，先确认
  `finishDictation()` 里的 `this.reset()` 还在——它一被删，`melBuffer` 就会带着唤醒词复判。
- **鼠标移上去球还是闪一下**：说明「先戴角落、再改窗口」这个顺序又被破坏了（第 3.8 节）。
  先看 `setExpanded(true)` 的展开分支里那次 `applyDirection(await api.expandCorner())` 是否还在，
  且**确实排在** `await api.setExpanded(true)` 之前——顺序一反，球就又会在面板尺寸的窗口里被画到左上角。

### 已知问题（同族，但这次**故意**没动）

**面板开着时把球拖过屏幕中线再松手，球会停在错的角上（会一直错到下次展开）。**
`finishPointer` → `moveBall` → `clampBall` → `orb:clamp`，而 `FloatingPlacement.clamp()` 在已展开时
会重跑 `setExpanded(true)`，方向可能翻转；`orb:clamp` 只回 `{docked}`，页面拿不到新方向，
于是 `expand-*` 类仍是旧的，球被画到窗口的另一侧（也就是面板上面）。

**为什么没有顺手用 `expandCorner()` 修**：这条路上窗口是**已展开**的。折叠态下「先戴角落」是空操作，
展开态下不是——提前戴新类会让球在**旧窗口**里先跳 430px，等于把「一直错」换成「闪一下再对」，
没有真正解决。要修得让 helper 把「翻转 + 重排」当成一次原子通知（或干脆不再用方向类定位球），
是另一个改动。真机验证时可以顺便试一下这个动作（面板开着把球拖到屏幕另一侧松手），确认现象是否存在。
- **唤醒时不播动画**：按顺序查这三处——`~/.dsh/dsh-orb/memes.json` 里有没有 `wake` 槽位；
  helper 日志里 `memes.json` 是否解析成功（文件坏掉会静默退回 fallback，所有槽位都变 null）；
  `dist/helper/assets/shell.js` 里有没有 `playWakeFrame`（没有就是包没换）。
  另外动画会被「拖拽中」压住——`dragging` 的优先级在 `syncGif()` 里仍然最高。
- **「点头」（或任何一张图）一直播、回不到闲置**：先确认它是不是**头像**而不是 meme 槽位。
  `ps` 里的 `orb-avatar` 是什么，球在面板展开/agent 工作时就会一直播什么。
  若确认是头像，检查两处：`syncGif()` 的 `const play = … || (expanded && idleSrc === undefined)`
  是否被改回 `expanded ||`（改回去就会重现本次这个问题）；以及 `memes.json` 里 `idle` 是否还在、
  文件是否还能解析——`idle` 解析不到时 `play` 分支依然会拿头像顶上，这是设计好的兜底。
- **语音输入期间不播 `voice`**：确认 `dictation` 是开着的（`voice` 姿势只跟着
  `dictationPhase` 的 `recording`/`transcribing` 走，唤醒后不录音就永远不会出现），
  以及 `memes.json` 里 `voice` 槽位的文件能解析到。
- **鼠标移上球时闪一下 / 球跳到面板角落**：这是第 3.8 节的窗口重排竞态。若复活，查三个调用点是否还在：
  `setExpanded()` 里 `anchorBall()` 必须排在 `await api.setExpanded(true)` **之前**；
  `window` 的 `resize` 监听里要有 `pinBallToAnchor()`（它才是「不画出错误那一帧」的那一环，
  少了它 `anchorBall()` 就只是个没用的锁存）；`applyDirection()` 末尾要有 `releaseBall()`。
  另外注意 `#ball` 上的 `transform` 只应在这一两个回合里存在——如果它长期不为空，
  说明 `releaseBall()` 没被调用，球的点击/拖拽命中区也会跟着偏。
