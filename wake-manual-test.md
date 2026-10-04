# 悬浮球语音唤醒 · 手动验证清单

> 本文对应已安装到 profile 的新版 `dsh-orb`（版本号仍是 `0.0.0`）。
> 安装信息（本次操作的真实数值）：
>
> | 项目 | 值 |
> | --- | --- |
> | 安装路径 | `C:\Users\digua\.dsh\profiles\desktop\vendor\dsh-orb-0.0.0.tgz` |
> | 新 tgz 大小 | 20 883 490 字节 |
> | 新 tgz SHA256 | `6350C4CA5AAFCABB38B7EA2790824703AFDE0D2B9BD35522915241D42C2B0636` |
> | 旧备份 | `C:\Users\digua\.dsh\profiles\desktop\vendor\dsh-orb-0.0.0.tgz.bak-20261002_233933`（20 860 401 字节，SHA256 `594635610EB14FDDD22B511F5F7750509D30DF7C5978AA4744657DB25668BAC8`） |
>
> **重要：现在这套东西对正在运行的球无效。** helper 的进程里跑的还是旧代码，
> 必须**重启 DSH（至少完全退出官方应用再打开，让球进程重建）**之后才生效。
> 本文不替你重启，也不会替你重启。

---

## 0. 先重启，再验证

1. 完全退出 DeepSeek Harness（关主窗口不算退出；Windows 上要从托盘/任务栏彻底退出）。
2. 重新打开。球会跟着官方进程重建，新代码这时才装载。
3. 如果球没出现，先看第 5 节的日志。

**不需要**改 profile 的 `package.json`，也不需要重装插件——版本号没变，`file:` 指向的还是同一个路径。

---

## 1. 开启语音唤醒

只有一个入口：

- **右键点球** → 菜单里找 **「语音唤醒（Hey Jarvis）」**（英文界面下是 `Voice wake word (Hey Jarvis)`）→ 点一下打勾。

菜单里这一行的两种异常形态：

- 显示 **「语音唤醒（未找到本地模型）」** 且灰色不可点 → helper 没找到模型目录，跳到第 4 节。
- 勾不上/勾上后球毫无反应 → 看第 5 节的日志。

偏好文件（helper 启动时读一次，改了要重启球才生效）：

```
C:\Users\digua\.dsh\profiles\desktop\orb-wake.json
```

该文件在你第一次切换菜单开关时才会被写出（Host 侧持久化）。字段：

```json
{
  "enabled": true,
  "keyword": "hey_jarvis",
  "threshold": 0.5,
  "assetDirectory": "",
  "autoExpandOnWake": true
}
```

| 字段 | 含义 | 注意 |
| --- | --- | --- |
| `enabled` | 重启后是否自动开始监听 | 菜单开关就是改这一项 |
| `keyword` | 唤醒词 | **只有 `hey_jarvis` 有模型**；写别的词会去找 `<keyword>.onnx`，找不到就变成「未找到本地模型」 |
| `threshold` | 判定阈值，夹在 `0.05–0.99` | 误唤醒多就调高（如 `0.7`），喊不醒就调低（如 `0.4`） |
| `assetDirectory` | 模型目录 | 留空 = 自动找（见下） |
| `autoExpandOnWake` | 唤醒后是否自动展开面板 | 设为 `false` 就只亮光环不弹面板 |

模型目录（**不会被复制，是按路径引用**）：

```
C:\Users\digua\Desktop\dsh-orb-cordis\dsh-voice-dialog\assets
```

里面必须有 `melspectrogram.onnx`、`embedding_model.onnx`、`silero_vad.onnx`、`hey_jarvis_v0.1.onnx` 以及 `ort\ort.wasm.min.js`、`ort\ort-wasm-simd-threaded.mjs`、`ort\ort-wasm-simd-threaded.wasm`。
自动查找顺序：环境变量 `DSH_ORB_WAKE_ASSETS` → `进程工作目录\dsh-voice-dialog\assets` → 已安装包向上四级的 `<checkout>\dsh-voice-dialog\assets`。
**如果这个目录被移动或删除，唤醒就会失效**；这时把 `assetDirectory` 写成新的绝对路径即可。

---

## 2. 正常表现（对照检查）

| 阶段 | 你应该看到/听到 |
| --- | --- |
| 勾选菜单瞬间 | 球外圈出现一道**蓝色呼吸光环**（一圈向外扩散的描边），球上鼠标悬停有提示文字 |
| 面板内 | 出现一个**蓝色小徽标**，文案「语音唤醒已开启 — 说「Hey Jarvis」」（英文 `Wake word on — say “Hey Jarvis”`） |
| 加载中（勾选后头一两秒） | 徽标灰底「语音唤醒加载中…」；四个模型共约 5 MB 从本机磁盘读取，正常应在一两秒内结束 |
| 对着麦克风清楚说 “Hey Jarvis” | 光环**变绿加粗、脉冲加快**；徽标变绿「已听到唤醒词」；**听到一声上行提示音**（880→1320 Hz）；面板按配置自动展开；约 4 秒后自动回到蓝色监听态 |
| 连续说话 | 2.5 秒内不会重复触发（防抖冷却） |
| 取消勾选 | 光环和徽标立刻消失；Windows 任务栏托盘的**麦克风使用指示**应随之熄灭（说明麦克风真的被释放了） |

判定是**本机**完成的：不联网、不上传音频、不写音频文件。判定之后目前**不会**自动发消息或启动听写——只做到「看得见的唤醒反馈」。

---

## 3. 音频与隐私

- 只在这个球窗里采集，采样率 16 kHz，`onnxruntime-web`（wasm）本地推理。
- 关掉开关后 `WakeEngine` 会先停止打分，再 `track.stop()` 释放麦克风，最后关闭 `AudioContext`。
- 如果托盘麦克风图标在你关掉开关后**仍然亮着**，说明释放失败，请记录并在日志里找 `wake` 关键字。

---

## 4. 模型找不到怎么办

1. 确认 `C:\Users\digua\Desktop\dsh-orb-cordis\dsh-voice-dialog\assets` 还在，且上表 7 个文件齐全（4 个 `.onnx` + `ort\` 下 3 个文件）。
2. 若仓库被移走，二选一：
   - 在 `orb-wake.json` 里写 `"assetDirectory": "新路径\\dsh-voice-dialog\\assets"`；
   - 或给 DSH 的启动环境加 `DSH_ORB_WAKE_ASSETS=新路径\dsh-voice-dialog\assets`。
3. 改完重启球；菜单那一行应从「未找到本地模型」变回可勾选。

---

## 5. 失败了去哪看

**helper 的日志在启动它的那个进程的标准错误里**，也就是官方 DSH 的输出。按你启动方式选一个：

- 桌面应用启动：看应用的日志/开发者输出窗口（Host 会把 helper 的 stdout/stderr 转发并加前缀）。
- `dsh web` 启动：看那个终端窗口。

找这些前缀和关键字：

| 关键字 | 含义 |
| --- | --- |
| `dsh-orb helper: wake word stopped: <原因>` | 引擎报错并停止，`<原因>` 是原始错误（如 `NotAllowedError`、`audio context is suspended`） |
| `dsh-orb helper: wake word has no model directory` | 勾选时没有可用模型目录 |
| `dsh-orb: wake word is on but no dsh-voice-dialog assets were found` | 配置里开着唤醒，但 Host 没找到模型目录 |
| `dsh-orb: helper started pid …` | 球进程这一轮真的重建了（验证「重启是否生效」时看它） |

球窗自己的开发者工具（可选，需要临时打开）：球窗是独立 Electron 窗口，默认不开 DevTools；页面里的报错不会自动出现在终端。如果终端只有 `wake word stopped`，原因字段就是定位依据。

---

## 6. 上次报告 §6 里 5 个「未确认项」，分别怎么观察

在重启并勾选唤醒之后，逐项对照。**任何一项失败都请把第 5 节里对应的日志原文留下。**

### 6.1 麦克风授权链（Windows 隐私设置）

- **期望**：勾选后弹一次「允许使用麦克风」类授权（Electron/DeepSeek Harness 名义），允许后进入蓝色监听态。
- **怎么判定失败**：徽标立刻变**红底**并显示 `NotAllowedError` 或 `Permission denied` 一类文案；终端出现 `wake word stopped: NotAllowedError…`。
- **还要查**：Windows「设置 → 隐私和安全性 → 麦克风」里
  - 「让桌面应用访问你的麦克风」必须是**开**；
  - 关闭「让应用访问你的麦克风」会直接导致失败（本插件无法绕过，也不能提权）。
- **判定通过**：蓝环出现且托盘麦克风图标亮起。

### 6.2 `file://` 页面上的 `getUserMedia`

- **关注的疑点**：球窗是 `file://` 加载的页面，Chromium 理论上把 `file://` 当可信来源，但从未实测。
- **怎么判定失败**：和 6.1 一样的红底徽标，但错误是 `navigator.mediaDevices is undefined` / `getUserMedia is not a function` / `NotAllowedError`，且**系统隐私设置里麦克风是开的**——那就说明是 `file://` 的问题（而不是授权）。
- **怎么判定通过**：蓝环出现，且对着麦克风说话时（如果有诊断手段）能看到电平变化；最直接的证据就是念唤醒词能触发绿环。
- **可选加固**：如果这里失败，把球的页面改为从自定义协议/loopback 加载（代码里已留了 `dsh-wake://` 与 Host 的 `/.dsh-orb/wake-assets/*` 两条路），属于后续改动。

### 6.3 `AudioContext` 能否在未聚焦窗口 `resume()`

- **关注的疑点**：球常年不聚焦，`new AudioContext()` 可能停在 `suspended`，那样**一帧音频都不会回调**——看起来一切正常，但永远唤不醒。
- **怎么判定失败**：徽标**不长红**，蓝环也在，但无论怎么念都没反应；终端没有 `wake word stopped`。这是最隐蔽的一种。
- **代码里的行为**：`openMicrophone()` 会主动 `resume()`，并且当 `state !== 'running'` 时**直接报错**而不是假装在听。所以更可能看到的是红底徽标 + `audio context is suspended`。
- **怎么判定通过**：念唤醒词能触发绿环 + 提示音——提示音本身也证明音频输出可用。
- **辅助观察**：勾选后立刻说一句话，如果 4 秒内完全没有反应，优先怀疑这一项。

### 6.4 `dsh-wake://` 协议下 ORT 能否建出 4 个 `InferenceSession`

- **关注的疑点**：模型与 wasm 不再走 HTTP，而走 helper 自己的 `dsh-wake://assets/`；`WebAssembly.instantiateStreaming` 需要 `application/wasm`，动态 `import()` 需要能解析 loader 地址。
- **怎么判定失败**：勾选后徽标长时间停在灰底「加载中…」然后转红，原因里出现 `onnxruntime script failed to load` / `did not expose window.ort` / `no available backend found` / `c is not a function` 一类字样；或者 `<scheme> is not a registered protocol` 之类。
- **怎么判定通过**：一两秒内从灰底「加载中…」进入蓝色监听态（4 个模型都建好了才会走到蓝态）。
- **注意**：灰→蓝这一步**只证明模型和 wasm 加载成功**，不证明识别准确。

### 6.5 阈值手感 / 真念 “Hey Jarvis” 能否过阈值

- **怎么判定失败（漏报）**：蓝环常亮但念十次都没绿。先试：
  - 咬字清楚、离麦克风近一点、环境噪声小；
  - 把 `orb-wake.json` 的 `threshold` 从 `0.5` 降到 `0.35–0.4`，重启球再试。
- **怎么判定失败（误报）**：没念也频繁变绿+响提示音。把 `threshold` 调到 `0.65–0.75`。
- **怎么判定通过**：念一次 → 绿环 + 提示音 + 徽标「已听到唤醒词」，4 秒后回蓝；同一句话不会在 2.5 秒内触发两次。
- **性能观察**：监听期间球的拖拽/悬停是否明显变卡。本次**未做**任何 CPU 测量；如果明显卡顿，先关掉开关，并把这一条记下来。

---

## 7. 想回退

```powershell
Copy-Item 'C:\Users\digua\.dsh\profiles\desktop\vendor\dsh-orb-0.0.0.tgz.bak-20261002_233933' `
          'C:\Users\digua\.dsh\profiles\desktop\vendor\dsh-orb-0.0.0.tgz' -Force
```

然后重启 DSH。备份文件不会被自动删除。
