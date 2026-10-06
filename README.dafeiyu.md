# 大肥鱼定制版 · dafeiyu-orb

这是 [`dsh-orb`](https://github.com/mini-yifan/dsh-orb)（悬浮球 Agent 插件）的个人定制分支，
上游为 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的非官方衍生作品。
原作者与版权声明见 [`LICENSE`](./LICENSE) 与 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)，本仓库未做任何改动。

相对上游的改动：

| 改动 | 位置 | 说明 |
|---|---|---|
| 自训练唤醒词「大肥鱼大肥鱼」 | `dsh_orb/wake_*.py`、`dsh-voice-dialog/assets/dafeiyu.onnx` | 用 Edge TTS 合成正样本 + openWakeWord 预训练特征提取，导出单层分类器替换 `hey_jarvis`。**短语要说两遍**，分类器环长因此加宽到 28 槽 |
| 语音播报表情槽位 `speak` | `packages/helper/`、`memes.json` | 播放语音回复时切到「说话」GIF，区分于用户听写（`voice`）与流式吐字（`reply`） |
| 网页获取表情槽位 `webfetch` | `packages/helper/`、`memes.json` | 抓取网页时切到「打字(恼怒)」GIF，区分于其他工具调用共用的 `tool` |
| 到达问候槽位 `arrive` | `packages/helper/`、`memes.json` | 悬浮球开启时（含首次启动 DSH）先播一次「到达.gif」，播完接着播一次「打招呼 1.gif」；等球窗口真正显示后才开始计时 |
| 到达 GIF 的水平镜像 `到达 水平翻转.gif` | `dsh_orb/flip_gif.py` | 由 `到达.gif` 逐帧镜像而来，像素级一致（备用，见下） |
| 余额低于阈值时的闲置脸 `poor` | `packages/host/src/balance.ts`、`packages/helper/`、`memes.json` | 账号可用余额（充值 + 赠金）低于 60 元时，休息循环从「闲置」换成「自我安慰.gif」；余额未知（未登录 / 读失败）**不算 0** |

## 表情槽位

`memes.json` 的每个具名槽位对应球在某个状态下的循环帧。新增槽位要改四处，缺一处只会表现为
「球不变脸」，而单测全部照过：

| 位置 | 改什么 |
|---|---|
| `src/memes.ts` | `MemeConfig` 字段、`MemePicker` 方法、`readConfig` 里的 `readNamed`、`fallback` 默认值 |
| `src/main.ts` | `ipcMain.handle('orb:meme-<槽位>')` |
| `preload.cjs` | `meme<槽位>()` 转发 |
| `assets/shell.js` | 状态变量、`refreshFrames()` 预取、`syncGif()` 里的分支 |

`webfetch` 比其他槽位多一处：`syncGif` 靠 `gif.dataset.mode` 判断要不要重画 `<img>`，
所以**两个工具面必须用不同的 mode**，否则同一轮里 `web_fetch → bash` 的切换不会重画，
抓网页的脸会一直卡在球上。同理 `syncAgent` 的早退条件必须同时比较阶段和工具名——
连续两个工具都是 `tooling`，只看阶段的话每轮只有第一次会生效。

一次性的槽位（`click`、`done`、`wake`、`drop`、`arrive`）还要多改一处：`syncGif` 的测试夹具
（`tests/drop-frame.test.ts`、`tests/speak-frame.test.ts`、`tests/webfetch-frame.test.ts`、
`tests/transcript-model.test.ts`）把状态变量逐个解构出来，新增的分支若没在里面登记，
夹具会以 `ReferenceError: xxx is not defined` 挂掉——**报错信息像测试文件坏了，而不是像它抓到了改动**。
`speak-frame.test.ts` 的注释里就写着这条规矩。

`arrive` 是唯一一个「不是对任何事件作出反应」的槽位，也是唯一一个**列表**槽位（`files`，不是
`file`）：它由页面自己开场，所以

（1）它不放进 `refreshFrames()` 预取队列（那是十来个文件的排队，问候会排在休息循环后面）；
（2）`wearArriveFrame()` 用 `whenVisible()` 等窗口真正显示再起计时——helper 建窗时是
`show: false`，页面先跑一秒才 `showInactive()`，不等待的话用户只会看到 GIF 的后半段
（实测：窗口出现时动画已过去约 1 秒）。这条是被 `dsh_orb/watch_arrival.py` 当场量出来的；
（3）列表里的每一段按顺序播一遍：每一段拿到**自己的** `step`（`syncGif` 靠 mode 变化重载
`<img>`），因此第二段是从它自己的第 0 帧开始，而不是接着上一段的姿势；每段的时长就是它自己的
一遍（会自己重播的文件提前一点交棒，播完定住的文件给足整遍）。某一段的文件找不到只损失那一段，
后面的照播。当前实测总时长：到达 1734 ms + 打招呼 2280 ms ≈ 4.0 s。

## 余额低于阈值时的闲置脸（`poor`）

```json
"idle": { "file": "PNGTuber 闲置.gif" },
"poor": { "enabled": true, "below": 5, "file": "自我安慰.gif" }
```

`poor` 不是一个新状态，而是**同一个休息状态在另一个条件下的脸**：余额低于 `below`（元）时用
`poor.file`，否则用 `idle.file`。余额由宿主读、helper 转、页面决定，链路是：

| 层 | 做什么 |
|---|---|
| `packages/host/src/balance.ts` | `ctx.get('deepseekAccount').getBalance(client)`（DSH 账号与余额页用的同一个服务），把 `value`（充值钱包）与 `bonusWallets`（赠金钱包）里的 **CNY** 金额相加；非 CNY 不折算、直接跳过 |
| `packages/host/src/orb.ts` | 开球时读一次，之后**每小时**一次（`BALANCE_POLL_MS`），值变化时广播 `{ type: 'balance', cny, at }`；新连上的 helper 在 `hello` 时补发手上那次读数。读的是账号网站的 `GET …/api/v0/users/get_user_summary`，**不消耗余额**（没有模型调用、没有 token），一小时一次纯属「别没事敲别人接口」 |
| `packages/helper/src/main.ts` | `record.type === 'balance'` → `orb:balance`；页面加载完（`did-finish-load`）再补推一次 |
| `packages/helper/preload.cjs` | `onBalance(cb)` |
| `packages/helper/assets/shell.js` | `readBalance()`（非法值一律 `null`）→ `brokeNow()`（`null` 直接 false）→ `syncGif` 的休息分支按 `'poor'` / `'idle'` 两个不同 mode 重画 |

**未知 ≠ 0**：未登录、平台读失败、构建没有客户端版本，宿主一律发 `cny: null`，页面保持原来的闲置动画——
把失败读成零会让每台没登录的机器都摆出「自我安慰」，那是这个玩笑里唯一会变成错误陈述的分支。
`below` 写坏（负数、字符串）会被归零，于是永不触发；`below` 整个不写则用默认 5（`POOR_DEFAULTS`）。
一小时一次意味着**充值后那张脸最多还会挂一小时**才换回来——球开起来时那一次读数保证新启动是准的，
代价落在「一次会话中途跨过这条线」这种情形上。

一个必须知道的部署事实：**宿主那一半要重启 DSH 才会加载**（宿主插件在 DSH 进程里，
helper/页面那半重启 helper 即可）。所以改完 `balance.ts`/`orb.ts` 后，重新打包安装
（`assemble.mjs` → `pack_and_install.py`）再重启 DSH，余额才会真的被读。

## 到达 GIF 的镜像

`大肥鱼表情包整合/大肥鱼表情包整合/到达 水平翻转.gif` 是 `到达.gif` 的水平镜像，由
`dsh_orb/flip_gif.py` 生成（`python dsh_orb/flip_gif.py --force` 可重新生成，原图保留不动）。
当前 `arrive` 用的是原图；想换成镜像版只是改配置，helper 十秒内重读，但页面每次开窗只读一次，
所以下一次开球（或重启 DSH）才生效：

```bash
python dsh_orb/set_arrive_slot.py                              # 到达.gif + 打招呼 1.gif（当前）
python dsh_orb/set_arrive_slot.py "到达 水平翻转.gif"            # 只播镜像版
python dsh_orb/set_arrive_slot.py "到达 水平翻转.gif" "打招呼 1.gif"  # 镜像版接打招呼
python dsh_orb/set_arrive_slot.py --off                        # 关掉问候
```

参数按顺序就是要播的顺序；`--off` 之外都写 `{"enabled": true, "files": [...]}`。
脚本会先备份 `memes.json`，再核对「除了这个槽位以外每个键逐字节没变」才落盘。

镜像本身有三个坑，脚本都已绕过并逐帧校验（51 个 40 ms 采样点，镜像后**像素完全一致**）：

*   **透明**：源文件每帧都是 500×500 整幅 + 自带局部调色板 + `disposal=2` + 透明索引 255。
    调色板、disposal、透明索引任一丢失，球上就会出现一块色块而不是透明背景。
*   **抖动**：把 RGBA 直接交给 Pillow 的 GIF writer 会**默认带 Floyd–Steinberg 抖动**重新量化
    （在本文件上实测平均误差 2.6/255，平面区域出现噪点，`optimize` 还会顺手把透明索引挪走）。
    脚本自己按帧建调色板、`dither=NONE`——每帧本来就是调色板图（≤255 色），所以无损。
*   **帧数**：Pillow 会把连续相同的帧合并成一帧并累加时长（本文件结尾 11 帧定格 → 51 帧变
    41 帧，总时长仍是 2040 ms）。因此校验按**时间轴**比对，而不是按帧序号。

改完用这两个脚本自证（都在 `dsh_orb/`）：

```bash
node dsh_orb/verify_webfetch_slot.mjs      # 已安装的包里四段接线 + 素材能解析
node dsh_orb/walk_webfetch_sequence.mjs    # 用已安装的 syncGif 走一遍真实状态序列
python dsh_orb/fault_webfetch.py 1         # 注入故障，看测试是否真的失败（1/2/3，restore 复原）

node dsh_orb/verify_arrive_slot.mjs        # arrive 槽位：接线 + 每一段素材 + 一次性/等待显示的不变量
node dsh_orb/walk_arrive_sequence.mjs      # 用已安装的 syncGif 走一遍开场到休息的生命周期
python dsh_orb/fault_arrive.py 5           # 注入故障（1/2/3/4/5，restore 复原）
python dsh_orb/watch_arrival.py            # 重启 helper，逐帧比对球上究竟是哪个 GIF
python dsh_orb/flip_gif.py --force         # 重新生成镜像版并逐帧校验像素一致

node dsh_orb/walk_poor_sequence.mjs        # 用已安装的 brokeNow/syncGif 走一遍余额决策
node dsh_orb/verify_poor_slot.mjs          # poor 槽位：五层接线 + 配置 + 素材 + 页面能否解析
node dsh_orb/probe_poor_balance.mjs        # 桩宿主 + 真 helper：把余额消息发到球上，比对 <img> 字节
python dsh_orb/fault_poor.py 1             # 注入故障（1/2/3/4，restore 复原）
```

## 一次性动画的循环标记（闪帧的根因）

一次性槽位（`click`/`done`/`wake`/`drop`/`hover.intro`/`drag.intro`/`arrive` 的每一段）都是
「播一遍就交棒」，而**交棒时刻与 GIF 自身是否重播是同一件事**。这里踩过三轮，记一下：

**`loop` 的取值方向容易记反。** GIF 的 Netscape 扩展块里那个 16 位计数，
**`0` = 无限循环**，`1` = 再播一遍（共两遍），**整个块不存在 = 播一遍后停在末帧**。
拿 Pillow 读到的 `im.info["loop"]` 就是这个原始值，`0` 不是「播一次」：

```bash
python dsh_orb/loop_audit.py          # 逐通道打印循环标记与一遍时长
python dsh_orb/make_oneshot.py        # 试运行：报告将去掉哪些循环块
python dsh_orb/make_oneshot.py --apply  # 写入（自动备份 *.bak-loop-<时间戳>）
```

**会自循环的文件，在走完一遍的那一刻立刻从头重播**，所以「播一遍的定时器」只要落在这个边界上
（或之后）就会闪出一帧开场姿势。落点越接近边界越像抽奖——这正是「有时闪有时不闪」的来源。
`oneShotHoldMs` 因此不是简单地给整段时长，而是按文件自己的行为分派：

| 文件行为 | 调度 | 理由 |
|---|---|---|
| 无循环块（播完停住） | 给足整遍时长（`transition` 给整遍，`cue` 可再超 `ONE_SHOT_MIN_MS`） | 末帧是收尾姿态，停多久都安全 |
| 有循环块（会重播） | 一遍减去 `max(ONE_SHOT_CUT_MS, 15%)` | 必须赶在重播前交棒 |
| 有循环块 + 过渡型（intro） | 同上，`transitionHoldMs` | 接缝比末尾几帧重要 |

判断由页面自己做（`loopsForever()`）：GIF 是以 `data:` URL 交给页面的，字节就在手上，
`atob` 之后找 `NETSCAPE2.0` 读那两字节即可，比推断靠谱得多——**文件时长完全说明不了
它的末帧是收尾还是即将跨过的边界**。

**哪些文件该去掉循环块，看末帧是不是收尾姿态**，不能一刀切。判据是末段帧间运动 ÷ 全片平均：

```bash
python dsh_orb/loop_tail.py            # 打印每个文件的末段运动比与接缝差
```

实测：拎起 0.56x、下落 0.09x、叹号 0.24x、打招呼 0.45x → 收尾姿态，适合定住；
**摸头 2 是 1.58x、摇铃 0.93x → 仍在甩动，是循环型动作，改成一次性会冻在半空**，必须保留循环。
（`悬空`/`期待 2`/`闲置` 等常驻循环、以及靠重复 N 遍计时的 `sleep.yawn`，当然也不能动。）

两个实现上的坑：`ONE_SHOT_MIN_MS` 的 900 ms 地板**只对「播完停住」的文件成立**——
对会重播的文件把 hold 抬到 900 ms 只会让 360 ms 的动画播两遍多；而曾经写过
`min(max(cut, 900), ms - 1)`，在 ms < 970 时地板被上限压回，结果恒等于 `ms - 1`，
**恰好压在重播边界上**，等于把每个通道都推到抽奖边缘。

改动只在 `memes.json` 的 `dir` 指向的素材目录里，**不必重新打包**——
helper 每次 `fetch` 都现读文件转 data URL；代码改动仍需 `assemble.mjs` → `pack_and_install.py`。

## 唤醒词训练

```bash
python dsh_orb/wake_pipeline.py     # 六阶段流水线：合成 → 提特征 → 训练 → 导出 → 评估
```

训练环境的 Python/CUDA 环境名为 `indextts`（复用自另一个项目），**实际 TTS 用的是 Edge TTS**。

一个容易踩的坑：openWakeWord 的分类器吃的是一圈 embedding 环形缓冲，真机运行前该环已被约 3.2 秒
上下文填满，而零填充或冷启动特征训练出来的模型会对普通中文大量误触发。`wake_features.py` 里的
warm-up 就是为此存在——**改动特征提取逻辑时务必保持与 `packages/helper/assets/wake.js` 的
`FRAME_SIZE = 1280` @ 16 kHz 一致。**

环长按关键词分派（`RING_SLOTS`）：出厂的 `hey_jarvis` 是 16 槽，定制的「大肥鱼大肥鱼」是 **28 槽**。
唤醒词是**整句说两遍**，实测占 8.7–19.4 槽，16 槽装不下整句，也就无从分辨「两遍」和「一遍」。
一个槽是 **128 ms**（不是一帧的 80 ms），环长是模型接口的一部分（`[1, slots, 96]`），
`wake_features.WINDOW_FRAMES` 必须与它一致。

`reset()` 必须把环填成**安静房间**而不是零：模型从未见过含零的环，实测全零判 0.8625、
「27 个零 + 1 个真 embedding」判 0.9846（与说的是什么无关），而安静房间判 0.0001。
详见 `packages/helper/tests/wake-ring.test.ts`。

## 素材包

`大肥鱼表情包整合/` 是第三方 GIF 素材（约 274 MB，212 个文件），仅供个人使用，
其著作权属于各自作者。`memes.json` 的 `dir` 需指向该目录的上层路径。

`dsh-voice-dialog/assets/ort/`（onnxruntime-web，MIT）不入库，需从 CDN 获取。

## 本机相关

`dsh_orb/` 下的探针与打包脚本包含硬编码的 Windows 绝对路径，换机器需自行调整。
真正通用的部分是 `wake_*.py`。

## 开发

```bash
pnpm install
pnpm build
pnpm test
```

Windows 上测试需注意 Node 版本差异，`--test-isolation=process` 在 Node 22.22.2 下不识别。

MIT License，继承自上游。