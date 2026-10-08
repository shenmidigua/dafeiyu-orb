import { renderMarkdown } from './markdown.js'
import {
  processLabel, reasoningSummary, processTitle, toolTitle, toolLabels, classifyTool, deriveSummary,
  formatToolBody, terminalCardModel, terminalFailed, readCardModel,
  searchCardModel, webCardModel, diffCardModel, diffTotals, diffLines,
  usageLabels, tokenUsageTotal, formatTokenCount,
} from './transcript-model.js'
import { upgradeCodeBlocks } from './highlight.js'
import { WakeEngine, WAVE_BARS, CONSECUTIVE_WINDOWS } from './wake.js'
import { Speaker } from './speech.js'
import {
  icon, THINK, CHEVRON_DOWN, CHEVRON_UP, SEARCH, GLOBE, BROWSE, EDIT, CODE, API, SPARKLE, COPY, CHECK, SPEAKER, STOP, stateSpinner,
} from './icons.js'

const api = window.dshOrb

/**
 * How long the ball keeps a face up for work happening in another conversation that is not writing.
 *
 * Reasoning and tool calls each get their own window on the same terms as the words do, and a longer one,
 * because neither reports itself as often: a model thinks in long stretches with nothing to say in between,
 * and a tool call is a single event rather than a stream. Too short and the face would drop and come back in
 * the middle of one thought, which reads as a stutter rather than as a state.
 */
const OTHER_WORK_HOLD_MS = 4000

/**
 * How long the ball keeps typing along after the last word arrived from another conversation.
 *
 * Another conversation's work reaches this page as one small message per kind per second — never as words,
 * see `announceOtherStream` in the host — and this is how long the last one is trusted. A window rather than
 * a state for the same reason the composer's is: the page cannot see the loop's own end, so it goes by the
 * last frame it heard.
 *
 * It is a *fallback*, not the mechanism: the host also reports when the attempt writing those words has
 * ended, and the face comes off then. The window is what covers a stream that ends without saying so, and it
 * deliberately outlives nothing — a face held only by its own timer is a ball that types on after the answer
 * is finished, which is the pause this pair of signals exists to remove.
 */
const OTHER_STREAM_HOLD_MS = 2500

/**
 * 球的全部动画：谁会播、什么条件触发、配置里叫什么。
 *
 * 这张表是"以谁为准"的声明，因为触发链是一条**有顺序**的判定，而顺序本身就是语义：
 * `syncGif()` 从上往下走，**第一个命中的分支赢**，下面的分支连看都不会被看。所以"两个条件同时
 * 成立时播哪个"这个问题，答案不在这两个槽位的注释里，而在这张表的行序里。表里从上到下 = 优先级
 * 从高到低，和 `syncGif` 里的分支顺序一一对应（`syncGif` 是唯一的调度点，其余函数只负责把某种
 * 状态摆好）。
 *
 * 配置键就是 `memes.json` 里的槽位名；"自动"= 不需要用户动手，它自己会播。
 *
 * ── 一次性提示（播一遍就交还，`{槽位}.enabled` 控制，文件 `{槽位}.file`）──
 *  1. drag      拎起.gif + 悬空.gif   「拖拽中」——你按住球在拖：先播 intro（拎起）再循环悬空
 *  2. drop      下落.gif              「拖拽松手」——落地那一下，一次性
 *  3. dockArrive 冒泡 1登场*.gif      「吸附后鼠标停在球的条上」：探出球 → 登场 clip → 循环（左右各一套）
 *  4. click     摸头.gif              「点了球一下」——你手动点出来的反应
 *  5. wake      叹号.gif              「麦克风听到唤醒词」——自动：确认词被识别到就播，并顺手打开面板、开始录音
 *  6. ask       问号.gif              「AI 停下来向你提问」——自动（`tool/call` + `ask_user_question`）
 *  7. nod       点头.gif              「你发了一条消息给 agent」——自动；**两个来源**见下面的说明
 *  8. fail      停止工作.gif          「回合出错 **或**你按了停止」——自动（`reason.kind` 是 error/aborted）
 *  9. done      摇铃.gif              「回合正常跑完」——自动（`reason.kind === 'completed'`）
 * 10. interrupted 惊吓.gif            「会话关闭时未收尾的回合被补发中断」——自动（`'interrupted'`）
 * 11. approval  问号.gif              「AI 等你批准一个工具」——自动（`'blocked'` 或 `approval/asked`）
 * 12. maxtokens 叹号.gif              「回合达到输出长度上限」——自动（`'max-tokens'`）
 *     8–12 这五条是**同一套机制**（回合怎么结束），判定与排查见下面的规则 G/H。
 * 13. arrive    到达.gif + 打招呼.gif 「页面刚加载完」——自动，**每次加载只播一遍**
 * 14. typing    记录 1.gif            「你在球面板的输入框里打字」；窗口 TYPING_HOLD_MS（3 s）。**只此一个来源**：
 *                                    DSH 主窗口的输入框不外发草稿/键入事件，所以"在主窗口打字"这件事主机看不到。
 *                                    试过退而求其次——在你**发出**消息时点亮它——但那是"消息发出**之后**才开始
 *                                    打字"，说的是假话，所以撤掉了；那一瞬间只有 `nod`（第 7 行）。
 * 15. reply     打字(普通).gif        「模型正在生成文字」——自动，状态来自 agentState === 'replying'
 * 16. tool      画板.gif              「模型正在调用工具」——自动；**按 `tool.tools` 再按工具名细分**，见下
 * 17. thinking  思考(认真地).gif      「模型在推理」——自动
 *
 * ── 同一个模型，但在**你没在看的那个对话**里（DSH 主窗口）──
 *    这里的三条**复用上面同名的槽位**（`reply`/`tool`/`thinking`），不是新槽位；分开列是因为它们是
 *    `syncGif` 里独立的三条分支，而且**排在 15–17 之后**——本页自己的状态整体优先于别的对话，这样
 *    "同一个回合同戴两张脸"时不会互相打架。每个都有自己的 mode 后缀，所以从一种切到另一种会重新播片
 *    而不是停在上一张的最后一帧。窗口是 `OTHER_STREAM_HOLD_MS`（2.5 s，文字）与 `OTHER_WORK_HOLD_MS`
 *    （4 s，工具与思考），由主机广播的种类刷新。
 * 18. reply-elsewhere   同上 reply     「主窗口在生成文字」
 * 19. tool-elsewhere    同上 tool      「主窗口在调用工具」；主机**带上工具名时**用 `tool.tools` 的专属脸
 * 20. thinking-elsewhere 同上 thinking  「主窗口在推理」
 *
 * ── 只要条件成立就一直戴着的状态 ──
 * 21. speak     PNGTuber 说话.gif     「球正在朗读」——自动
 * 22. voice     点头.gif              「麦克风在录音 / 正在转写」（dictationPhase）
 * 23. hover     期待 2.gif + 打招呼 1.gif「鼠标停在球上」——先播 intro（打招呼）再循环期待
 * 24. (无槽位)  ——                    「对话进行中 / 面板展开」：戴冻结头像 avatar
 * 25. sleep     打哈欠 + 睡觉*.gif    「闲置一段时间后」——自动：打哈欠 → 打盹 → 睡着，`sleep.afterMs`
 * 26. skit      带薪拉屎 / 饮料 / 跳舞 「球闲置时每隔 gapMs 演一小段」——自动（见规则 F：别的会话在干活时不演）
 * 27. poor      吸氧.gif              「余额低于 poor.below」——自动；没有 poor 配置时由下面接管
 * 28. idle      PNGTuber 闲置.gif     「什么都不成立时的默认循环」——兜底
 * 29. (无槽位)  ——                    什么都没有配置时：戴冻结头像并冻结它
 *
 * 两个不属于这张表的例外，避免以后找错地方：
 *  • **吸附（docked）时会提前 return**（`if (docked !== undefined)`），第 24 行以下全都不走——条上
 *    显示什么由吸附那套自己管，球这边"保持上一次画面不动"就是它对吸附的承诺。
 *  • **随机 burst 不在这里**：它由 `scheduleMemeBurst()` / `playMemeBurst()` 自己的定时器驱动，从
 *    整个 `dir` 目录里随机抽（`memes.json` 顶层那个 `enabled` 只管它，不是总开关）。
 *
 * ── 三条"改变上表含义"的规则，容易漏，所以写在这里 ──
 *
 * **A. 点头（第 7 行）有两个来源**，而且**可靠性不同**：一是**球自己的面板**发消息——页面在
 *    `submitComposer()` 里直接播，和发送是同一行代码，不可能漏；二是**DSH 主窗口**发消息——主机订阅
 *    `session/event` 认出 `user/message` 后广播 `{ outcome: 'user' }`，页面再播。第二条依赖全局订阅，
 *    而该订阅**不在这个插件的类型化事件表里**（历史上"写两遍都静默失败"就是这个原因），所以它写在
 *    `try/catch` 里，并且第一次收到任何会话事件时会往 `stream.log` 写一行作为可验证的凭据。
 *
 * **B. 工具名的细分（第 13 行）**：`tool` 是所有工具共用的那张脸；`tool.tools` 里按**工具名**列出的
 *    条目会覆盖它，没列到的工具（`grep`/`glob`/`write`…）继续用共用脸。名字就是工具卡片上的名字
 *    （`pwsh`/`edit`/`read`…），所以这是**纯配置**：改一行就换脸，DSH 改名了也只是那行失效、自动回落
 *    共用脸，不会报错。**取脸是按需的**（`loadNamedToolFrame`）：第一次遇到某个工具名才去问 helper，
 *    答案是"没有专属脸"也会被缓存，所以第二次不再问。另一个会话的工具名要**主机广播带过来**
 *    （`streamNews` 里的 `tool` 字段），因为球的对话记录不是那个对话、没有工具卡片可读。
 *
 * **C. 工具脸的最小显示时长**：按工具名取到的脸一旦戴上，**至少留 `TOOL_FACE_HOLD_MS`（1300 ms）**。
 *    片长只有几百毫秒而命令可能十毫秒就跑完，没有这个下限时同一支工具脸"有时候看得到有时候看不到"
 *    （这是实测报障）。它**只延迟、不否决**：该来的状态都会来，只是晚一点。共用脸不受此限，否则一个
 *    纯写字的回合会一直挂着工具图片。判定在**所有有意义的分支之后、回到待机之前**，所以它挡不住任何
 *    真实状态。
 *
 * **D. 陈旧的 `running` 不再被相信**：`agentState` 只认 `running === true` 的块，而"运行中"这个标记
 *    是主机打上的——一旦有路径没把它清掉，球就永远卡在工具脸，**而且因为块不再变化，页面收不到任何
 *    消息、自己走不回来**（这个 bug 报过两次）。所以：**对话记录静默超过 `STALE_BLOCK_MS`（20 s）时，
 *    所有块都不再算 running**。依据是干活的模型不可能静默这么久；而摘下面具的那次重绘必须**被安排**
 *    （`staleAgentTimer`），因为陈旧块不会再发消息。块后来又动了就会被重新信任。
 *
 * **E. 工具名的到达有前提**：主机只在**认得**这一帧时才广播名字——`tool-call-delta`（流式参数）或
 *    `block-start`/`block-end` 且块类型是 `tool-call`（参数一次给全）。两者都没有时只有 `tool/call`
 *    事件，名字到不了页面，于是一个列了 `tool.tools` 的工具**也会**显示共用脸。这不是配置错，而是
 *    主机没拿到名字。
 *    **排查工具**：`~/.dsh/dsh-orb/tools.log` 是唯一权威——主机每调一次工具写一行
 *    （`call name=grep id=… pending=none`），helper 每次被问名字写一行（`asked="grep" own-face=true`）。
 *    两边对着看就知道断在哪：**只有前半行** → 主机没广播，或页面没收到；**两半都有** → 名字通了，
 *    问题在画那一层。`stream.log` 里那些 `tool (pwsh) arriving` 是**每 15 秒的摘要**，短对话可能一次
 *    都写不出来，所以**不能**用它判断"有没有名字"。
 *
 * **F. "在休息"不只看本页的 `agentState`，还要看别的会话**：打盹（第 22 行）和小品（第 23 行）都由
 *    `restingNow()` 把门，而它原本只检查**本页自己的**工作状态（`agentState === ''`、`!running`…）。
 *    于是你在 DSH 主窗口工作时，球这边 `agentState` 一直是空的、**自认为在休息** → 跳舞/小品照样开演
 *    → **盖住"别的会话在工作"那三张脸**（这是实测报障的现象，逻辑上也不成立：那段时间球并不闲）。
 *    现在 `restingNow()` 把 `otherStreamAt` 的三个窗口和工具脸持有期也算作"不闲"。
 *
 * **G. 回合有六种结束方式，由 `turn/end` 的 `reason.kind` 决定**（表里第 8/9 行那些"回合结束"的脸照它分）。
 *    **六张脸全部实测通过**（`done` 摇铃、`interrupted` 惊吓、`ask` 问号 都亲眼看到过）：
 *
 *    | 配置槽位 | 含义 | 判定信号 |
 *    |---|---|---|
 *    | `done` | 任务完成 | `turn/end` 且 `reason.kind === 'completed'` |
 *    | `fail` | 出错 **或**被你手动停止 | `'error'` / `'aborted'`（停止按钮发的是 `aborted`） |
 *    | `interrupted` | 会话关闭时未收尾的回合被补发中断 | `'interrupted'` |
 *    | `approval` | 等待你批准工具 | `'blocked'`，**或**独立事件 `approval/asked` |
 *    | `ask` | AI 停下来提问 | 事件 `tool/call` 且**工具名**是 `ask_user_question` |
 *    | `maxtokens` | 达到输出长度上限 | `'max-tokens'` |
 *
 *    **信号长什么样**（照抄你会话记录里的真实结构，别凭感觉写）：
 *
 *    ```json
 *    {"type":"turn/end","seq":12837,"data":{"turn":96,"reason":{"kind":"aborted","reason":{"kind":"user"}}}}
 *    {"type":"tool/call","seq":12955,"data":{"turn":98,"step":3,"callId":"call_00_…","name":"pwsh","arguments":"…"}}
 *    ```
 *
 *    **`reason` 和 `name` 都在 `data` 里，不在事件顶层。** 这是本规则唯一一处曾经写错的地方（见下面的 H）。
 *
 *    **两个信号源，别混**：`assistant/message` 流那边的 `type: 'end'` 只说"这一段输出停了"，**不说为什么**
 *    —— 靠它区分 `done`/`fail` 只能猜。权威的是 `session/event` 里的 **`turn/end` + `reason.kind`**，它同时
 *    管**别的会话**（主窗口）：主机分类后广播 `{ type: 'session-turn', outcome: 'ended', category }` 到页面。
 *    **球自己的对话不重复播**：那六个事件在它自己的对话记录里本来就有，主机对"自己的会话"直接跳过，
 *    否则同一张脸会播两遍（和 `user/message` 不回声是同一个道理）。
 *    这个映射照 `@mzzsfy/dsh-turn-notify` 抄的 —— 两个插件读同一条流，不该对"发生了什么"有分歧。
 *
 *    **显示时长**：这些脸走 `TURN_END_MIN_HOLD_MS`（2200 ms）的下限。原因是 `oneShotHoldMs` 对**循环**片
 *    只留 85%（本意是"打断型提示快点把球还回去"），而这些片子不到一秒 —— 实测被报成"一瞬间"。
 *
 * **H. 这条链上失败一律是静默的，所以有三个必须记住的坑**（每一个都花掉一次重启）：
 *
 *    1. **`reason` 在 `data` 里**。第一版读的是 `event.reason`，永远 `undefined` → 六类**一个都没分类**。
 *       "没分类"和"没事件"在球上长得一模一样，所以它静默了整整一轮。
 *    2. **不要发明消息类型**。`helper` 的 `deliver()` 是**逐类型分派**的（19 种），**没有兜底分支**，
 *       不认识的类型**直接丢掉**。本规则第一版广播的是 `{ type: 'turn-ended' }` —— 这个类型 helper 不认识，
 *       所以消息在 helper 那一层就没了，页面永远收不到。**现在改走已经全线打通的 `session-turn`**
 *       （只新增一个 `outcome: 'ended'` 取值）。`deliver()` 现在也加了未知类型报错，不再静默。
 *    3. **页面侧的读取表要和主机的分类表对齐**。`TURN_END_READERS` 曾经只列了五个（漏了 `ask`），
 *       而球**自己**对话里的提问走的是另一条路（`playAskFrame`），把遗漏掩盖了 —— 只有"主窗口提问"断掉。
 *       现在 `packages/helper/tests/turn-end-readers.test.ts` 直接比对两份名单。
 *
 *    **排查顺序**（从最上游往最下游，每一步都有落盘证据）：
 *
 *    | 看哪里 | 说明 |
 *    |---|---|
 *    | `~/.dsh/dsh-orb/tools.log` 的 `event turn/end own=…` | 事件**有没有送到**、守卫有没有放行 |
 *    | 同文件的 `turn ended: <分类>` | 分类**成功没有**（没有这行 = 没分类，回去看坑 1） |
 *    | 同文件的 `sent kind=…` / `suppressed …` | 主机**发出去没有**、是不是被节流挡了 |
 *    | helper 的 stderr | `undelivered message type=…` = 踩了坑 2 |
 *    | `packages/helper/tests/turn-end-readers.test.ts` | 踩了坑 3 的话它会直接红 |
 */
const COLLAPSE_MS = 180
const ANIMATION_MS = 300
/**
 * The grace a docked ball used to get before a hover pulled it back out, in milliseconds.
 *
 * Nothing unsnaps on a hover any more — the strip drags the ball out, and a hover plays the arrival
 * clip instead — so this is the old grace and is kept only because the page's own test pins it as
 * the constant that *used* to be the second route out. The hover that does something now is
 * {@link DOCK_ARRIVE_DWELL_MS}, which is a dwell rather than a grace and is short enough to read as
 * one gesture.
 */
const DOCK_HOVER_DELAY_MS = 800
/** How often the page re-reads the burst config while bursts are off or unreadable. */
const MEME_POLL_MS = 30000
/** How long the typing frame stays after the last keystroke in the ball's own composer. */
const TYPING_HOLD_MS = 3000
/**
 * How long a per-tool face stays on the ball once it is up.
 *
 * The clips run about a second and a command can finish in ten milliseconds, so without a floor the face is only
 * seen when the tool happens to be slow — which arrived as a report that the same tool "sometimes" played its
 * animation and sometimes did not. Longer than the clips, so one full pass is always visible.
 *
 * Three seconds rather than the 1300 ms it started at: that was still reported as too brief to read, and a tool
 * call is a momentary event whose whole point is that the user notices it. It is a floor, so a slow tool — one
 * that is still running when the floor expires — is unaffected.
 */
const TOOL_FACE_HOLD_MS = 3000
/**
 * How long a block may claim to be running without the transcript saying anything else.
 *
 * A working model is never quiet for this long: tokens arrive on both sides of a tool call, and the call's own
 * status changes while it runs. A block that has stayed "running" through this much silence is one that whatever
 * should have settled it did not settle, and believing it leaves the ball stuck on a face with no way back —
 * which has now been reported twice, from two different directions.
 */
const STALE_BLOCK_MS = 20000
/**
 * How long a turn-ending face stays up, at least.
 *
 * `oneShotHoldMs` holds a looping clip for 85% of its length, which is right for a cue that interrupts something
 * — it hands the ball over before the clip's own loop point. But these are not interruptions: they are the ball
 * answering "the turn ended", and the clips are under a second, so the face was reported twice as a flash that
 * was barely caught. A floor is the same answer the per-tool faces got, for the same reason.
 */
const TURN_END_MIN_HOLD_MS = 2200
/** Grace after the wake chime before the recorder starts taking frames. */
const DICTATION_DELAY_MS = 350
/**
 * Shortest visible hold for a cue whose clip ends on its own last frame, milliseconds.
 *
 * Such a clip can be parked on that final pose for as long as the ball likes, which is what
 * keeps a short one from reading as a glitch rather than as an answer to what just happened.
 * A clip that restarts on its own cannot be held this way — holding it past its own length
 * only means watching it again — so it gets one pass instead; `oneShotHoldMs` has the rule.
 */
const ONE_SHOT_MIN_MS = 900
/**
 * The lead a clip that loops on its own is given when its hand-off has to be moved, in
 * milliseconds.
 *
 * A GIF decoder starts the animation over the moment it reaches the last frame, so a hand-off
 * that lands on a multiple of the clip's own length is a race: whichever runs first that
 * millisecond decides whether the first frame shows for an instant. This is the margin used
 * when the hold has to be nudged off such a boundary, and the floor of the proportional share
 * applied to longer clips.
 */
const ONE_SHOT_CUT_MS = 70
/**
 * How long the question face stays up once the agent has asked something, milliseconds.
 *
 * A fixed beat instead of one pass of the file, which is the rule every other one-shot here
 * follows, and the exception is what the face is *for*. The question GIF a pack ships loops
 * forever, so `oneShotHoldMs` would hand it one pass minus a lead — under a second — and what the
 * user has to be able to see is that the ball has stopped and is waiting on them, which a blink
 * does not say. The clip is free to run several of its own passes inside this beat: there is no
 * pose to hand over to at the end, because what follows is whatever the ball was already doing.
 */
const ASK_HOLD_MS = 6000
/** How long to wait for the host's transcript before telling the user it went missing. */
const DICTATION_TIMEOUT_MS = 90000
/**
 * Cadence the live level waveform repaints at, matching the official voice-input row.
 * Only the repaint is throttled: the history behind it advances one entry per audio frame,
 * so the waveform scrolls at the rate the levels actually arrive instead of at this rate.
 */
const WAVE_STEP_MS = 50
/**
 * How long the meter keeps showing the reading that woke the ball.
 *
 * A detection is decided on three consecutive windows and the ball chimes on the third, so the
 * whole run is about 380 ms of audio and the engine is already into its cooldown - streak cleared,
 * dots dark - by the time the chime is heard. A user who looks up at the sound therefore has
 * nothing left to read, which is exactly the question the meter was asked to answer ("the bar never
 * got there and it fired anyway"). A held reading is not a live score and is not drawn as one: it
 * is the record of one run, and it expires on its own. Long enough to read a number, short enough
 * that the next thing the ball does is not explained by a stale one.
 */
const WAKE_HOLD_MS = 2600
const DOCK_DRAG_OFF_PX = 24
/**
 * How far below the window's top edge the docked strip is drawn, in CSS pixels.
 *
 * The bar's own `top`, mirroring `#dock-tab { top: … }` in `floating.css`. Nothing computes with it
 * any more, and that is the point: it equals `DOCK_GLOW` — the distance `dockedTabBounds` lifts the
 * window above the ball's row — so the two cancel in the hand-off's own y. See the note there; the
 * constant is kept because the tests read it to check the CSS and the module still agree, which is
 * what would catch one of them being changed on its own.
 */
const DOCK_TAB_INSET = 8
/**
 * How far inside the display edge the dock parks the ball, in CSS pixels.
 *
 * Mirrors `DOCK_IN_PAD` in `geometry.ts`, and it is the page's second copy of a number the helper
 * owns — {@link DOCK_TAB_INSET} is the first. It has to be a copy rather than a measurement for the
 * same reason: the bar's box says where the display edge is, but the ball's own slot is a constant
 * further in and nothing on screen is drawn at it while the ball is hidden.
 *
 * It is the position the hand-off has to put the ball at, so a copy that drifts is a ball that
 * jumps the moment it is pulled out. `dock-tab-drag.test.ts` reads both this and the module's own
 * constant and compares them.
 */
const DOCK_IN_PAD = 5
/**
 * How long the pointer has to rest on the strip before the arrival is worth playing.
 *
 * Held at zero, and the zero is the whole of the decision: a wait here was measured as essentially the
 * entire cost of the gesture — with a peek round trip of ~32 ms on this machine, the entrance appeared
 * 127 ms after the hand reached the strip, of which 121 ms was this timer, and the hand can feel that on
 * a thing it touches on purpose. Playing at once is also what makes the strip feel like a control rather
 * than a hint, so the strip's hover is now: the ball comes out (still a round trip, still `peekDock`),
 * and the entrance starts with it.
 *
 * What the wait was for is recorded rather than deleted, because the argument for it has not changed and
 * may come back: a hand crossing the strip on its way somewhere else is not a hover, and the clip is a
 * whole gesture — 2.28s of it — so playing on the crossing would make every pass down the edge of the
 * screen fire one. It is kept as a timer rather than cut out of `beginDockArrive` so that threshold can be
 * restored by changing this one number: the arm/drop structure around it is what makes "crossed" and
 * "rested" different, and only the number says how long. The press that pulls the ball back out is
 * unaffected either way: it is a separate gesture with its own listener, and it does not wait for this.
 */
const DOCK_ARRIVE_DWELL_MS = 0
/**
 * Whether hovering the docked strip pulls the ball out.
 *
 * Off while the pull-out is being retired. A hover on the strip then does nothing: the ball stays in its strip
 * wearing whatever it was wearing, and the click that pulls it out — `beginDockDrag`, a separate gesture with its
 * own listener — is untouched. Both halves of the gesture read this, so nothing is left half-shown: the peek that
 * grows the window, and the arrival clip that greets it.
 *
 * One switch rather than a deletion on purpose. The gesture has a dozen constants and a round trip through the
 * helper behind it, so "pause it, then decide" is a line here, while "take it out" is a change to the geometry,
 * the hit-testing, the content sizing and the tests — and the reason to retire it is a judgement about whether
 * the frame is wanted, which is exactly the kind of thing that gets re-decided.
 */
const DOCK_HOVER_ENABLED = false
/**
 * How much wider than the docked strip the arrival counts as hovered, in CSS pixels.
 *
 * The main process holds the window over a reported rect plus its own `CAPTURE_MARGIN`, so a
 * pointer 1px outside the strip is inside a window that is capturing and still generates the
 * events this is read from. Measured off the tab element rather than restated from `geometry.ts`,
 * so the two cannot drift: the only loose end is this margin, which the test pins to the helper's
 * own constant.
 */
const DOCK_ARRIVE_MARGIN_PX = 8
/**
 * How much further the pointer has to travel *past* the peeking ball before the peek is put away,
 * in CSS pixels.
 *
 * The peek has no tolerance at all without this, and the ball is flush with the screen's inner
 * edge: `peekBallOrigin` puts it at `bounds.width - BALL_SIZE / 2`, so its left edge is the last
 * pixel column the hand can be on before it has left the ball. A single pixel of tremor there
 * crosses from "on the ball" to "off it", and since leaving is what dismisses the peek, the ball
 * goes away and comes back with every twitch — the strip flickering under a hand that never
 * actually left it.
 *
 * So the two directions are given different bars rather than one shared edge: a hand has to be
 * clearly off the ball to dismiss the peek, and only has to be near it to raise one. That is what
 * hysteresis is for, and it is why this is not a second `DOCK_ARRIVE_MARGIN_PX`: that one widens
 * the strip so the two sides of the protocol agree about where the strip *is*, while this one
 * deliberately makes them disagree about where the peek *ends* — the entry bar and the exit bar
 * are 12px apart on purpose, and a pointer anywhere between them keeps whatever it had.
 */
const DOCK_PEEK_RELEASE_PX = 12
const COMPOSER_MIN_PX = 72
const COMPOSER_LINE_PX = 20
const COMPOSER_MAX_PX = COMPOSER_MIN_PX + COMPOSER_LINE_PX * 3
const RECOMMENDED_SUFFIX = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i
const PERMISSION_PRESETS = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * Reads assistant replies aloud through the local IndexTTS service.
 *
 * The settings page owns the switches: the host pushes `speech: { enabled, autoPlay, endpoint }` in
 * every `chrome` message, so turning speech on takes effect without a rebuild or a restart. Off is
 * the default, because a fresh profile has no service behind it and a play button that never works
 * is worse than no button.
 *
 * `?speech=off` / `?speech=<url>` still override the host, which is how you test a port without
 * touching the profile file.
 *
 * A missing server is not announced: speech fails quietly and the orb behaves exactly as it did
 * before, which is what should happen when an optional service is not installed.
 */
const speechParams = new URLSearchParams(location.search)
const SPEECH_ENDPOINT = speechParams.get('speech') ?? 'http://127.0.0.1:8765'
/**
 * Block key → its read-aloud button.
 *
 * Declared here rather than next to the other transcript maps because the speaker is configured
 * during module evaluation, which immediately notifies its listener — reaching a `const` further
 * down would be a temporal dead zone error on every page load.
 */
const speechButtons = new Map()
/**
 * The speaker's state listener, called indirectly.
 *
 * The speaker is configured during module evaluation and notifies its listener straight away, but
 * the real implementation lives further down inside the transcript scope. A `function` declaration
 * there would not be visible from here — hoisting stops at the enclosing scope — so the binding is
 * created up front as a no-op and the transcript scope assigns the real one over it. Until that
 * assignment the notification has nothing to repaint, because no button exists yet.
 */
let syncSpeechButtons = () => {}
const speaker = new Speaker({
  endpoint: SPEECH_ENDPOINT,
  onState: (state) => syncSpeechButtons(state),
  // Starting the service is the host's job: the page can spawn nothing, and the host is what knows
  // how this machine launches it. Resolves once it is up — or once it has given up.
  ensure: () => (typeof api?.ensureSpeech === 'function'
    ? api.ensureSpeech()
    : Promise.resolve({ ok: false })),
})
if (speechParams.has('speech')) {
  speaker.configure({ enabled: speechParams.get('speech') !== 'off' })
}

const zh = {
  title: '桌面 agent',
  stop: '停止',
  fresh: '新建',
  history: '历史',
  historyEmpty: '还没有 Computer Use 对话。',
  untitled: '未命名对话',
  placeholder: '向桌面 agent 发送消息…',
  accessReadOnly: '仅可查看',
  accessWrite: '工作区内修改',
  accessFull: '完全权限',
  cancel: '放弃',
  skip: '跳过',
  next: '下一题',
  submit: '提交',
  prev: '上一题',
  recommended: '推荐',
  custom: '输入你的答案',
  incomplete: '请先完成这道问题。',
  unanswered: '请选择一个选项或填写自定义答案。',
  think: '思考',
  running: '运行中',
  stopped: '已停止',
  failed: '失败',
  tooLong: '最多 8000 个字符，已保留输入。',
  truncated: '已截断',
  chipDismiss: '移除',
  tccTitle: '使用桌面 agent 需要两项 Mac 权限',
  tccAppHint: '在列表里打开 {name}。',
  tccScreenName: '屏幕录制',
  tccScreenReason: '让 agent 看见当前窗口。',
  tccScreenPath: '系统设置 → 隐私与安全性 → 屏幕录制',
  tccScreenOpen: '打开「屏幕录制」设置',
  tccAccessibilityName: '辅助功能',
  tccAccessibilityReason: '让 agent 点击和输入。',
  tccAccessibilityPath: '系统设置 → 隐私与安全性 → 辅助功能',
  tccAccessibilityOpen: '打开「辅助功能」设置',
  tccStatusMissing: '未开启',
  tccStatusGranted: '已开启',
  tccStatusNeedsRelaunch: '已开启，请退出后重开',
  tccFooter: '打开开关后，请完全退出 {name} 再打开。只关主窗口无效。插件不能替你重启官方应用。',
  tccLater: '稍后',
  tccDismiss: '关闭',
  wakeListening: '语音唤醒已开启 — 说「{word}」',
  wakeDetected: '已听到唤醒词',
  wakeRecording: '正在听你说…',
  wakeTranscribing: '正在识别…',
  wakeLoading: '语音唤醒加载中…',
  wakeFailed: '语音唤醒不可用：{why}',
  wakeOff: '语音唤醒已关闭',
  wakeUnavailable: '语音唤醒未能启动。',
  dictating: '正在听你说…（说完停顿一下）',
  dictationEmpty: '没听清，再说一次吧。',
  dictationLost: '识别超时了，再说一次吧。',
  dictationFailed: '语音输入失败：{why}',
  dictationNeedsWake: '先开启语音唤醒（右键球）再试语音输入。',
  // Read-aloud failures used to be silent, which made a dead service indistinguishable from a
  // button that does nothing. Each of these names one way that can happen.
  // The wording used to promise "the first run loads the model, about half a minute". Nothing loads
  // a model any more — the service behind `/speak` is a proxy to a hosted voice and is answering in
  // under a second — so promising a half-minute wait would be the misleading half of the two.
  speechStarting: '正在启动朗读服务…',
  speechOffline: '朗读服务没在运行，自动启动也没成功。',
  speechTimeout: '朗读超时了，服务可能还卡在上一条。',
  speechAutoplay: '浏览器拦了自动播放，先点一下面板再试。',
  speechPlayback: '音频播放失败。',
  speechServer: '朗读服务报错：{why}',
}
const en = {
  title: 'Desktop agent',
  stop: 'Stop',
  fresh: 'New',
  history: 'History',
  historyEmpty: 'No Computer Use chats yet.',
  untitled: 'Untitled',
  placeholder: 'Ask the desktop agent…',
  accessReadOnly: 'Read Only',
  accessWrite: 'Workspace Write',
  accessFull: 'Full access',
  cancel: 'Dismiss',
  skip: 'Skip',
  next: 'Next',
  submit: 'Submit',
  prev: 'Previous question',
  recommended: 'Recommended',
  custom: 'Type your answer',
  incomplete: 'Please complete this question first.',
  unanswered: 'Please select an option or enter a custom answer.',
  think: 'Think',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Failed',
  tooLong: 'Limit is 8000 characters. The text was kept.',
  truncated: 'truncated',
  chipDismiss: 'Remove',
  tccTitle: 'Desktop agent needs two Mac permissions',
  tccAppHint: 'In the list, turn on {name}.',
  tccScreenName: 'Screen Recording',
  tccScreenReason: 'Lets the agent see the current window.',
  tccScreenPath: 'System Settings → Privacy & Security → Screen Recording',
  tccScreenOpen: 'Open Screen Recording settings',
  tccAccessibilityName: 'Accessibility',
  tccAccessibilityReason: 'Lets the agent click and type.',
  tccAccessibilityPath: 'System Settings → Privacy & Security → Accessibility',
  tccAccessibilityOpen: 'Open Accessibility settings',
  tccStatusMissing: 'Off',
  tccStatusGranted: 'On',
  tccStatusNeedsRelaunch: 'On — quit and reopen',
  tccFooter: 'After the switches are on, quit {name} completely and open it again. Closing the main window does not quit. This plugin cannot restart the official app.',
  tccLater: 'Later',
  tccDismiss: 'Dismiss',
  wakeListening: 'Wake word on — say “{word}”',
  wakeDetected: 'Wake word heard',
  wakeRecording: 'Listening to you…',
  wakeTranscribing: 'Transcribing…',
  wakeLoading: 'Starting wake word…',
  wakeFailed: 'Wake word unavailable: {why}',
  wakeOff: 'Wake word off',
  wakeUnavailable: 'Wake word did not start.',
  dictating: 'Listening… (pause when you finish)',
  dictationEmpty: 'Did not catch that — please say it again.',
  dictationLost: 'Transcription timed out — please say it again.',
  dictationFailed: 'Voice input failed: {why}',
  dictationNeedsWake: 'Turn the wake word on first (right-click the ball).',
  speechStarting: 'Starting the read-aloud service…',
  speechOffline: 'The read-aloud service is not running, and starting it did not work.',
  speechTimeout: 'Read-aloud timed out — the service may still be busy with the previous reply.',
  speechAutoplay: 'The browser blocked autoplay — click the panel once and try again.',
  speechPlayback: 'Audio playback failed.',
  speechServer: 'The read-aloud service failed: {why}',
}

const PROMPT_LIMIT = 8000
// The UI language mirrors the main window's, delivered on the appearance
// message; until it arrives the page follows the system like the web client.
let messages = (navigator.language || '').toLowerCase().startsWith('zh') ? zh : en
let chatLabels = toolLabels(messages === zh)
let usageText = usageLabels(messages === zh)

/** Switch the page dictionary; refreshers re-render from the new one. */
function applyLocale(locale) {
  if (locale !== 'zh' && locale !== 'en') return
  const next = locale === 'zh' ? zh : en
  if (next === messages) return
  messages = next
  chatLabels = toolLabels(messages === zh)
  usageText = usageLabels(messages === zh)
  document.documentElement.lang = locale
}

function applyColorScheme(dark) {
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  // Theme sheets key dark overrides on body[data-ds-dark-theme], as in Harness.
  document.body.toggleAttribute('data-ds-dark-theme', dark)
}

const colorScheme = window.matchMedia('(prefers-color-scheme: dark)')
applyColorScheme(colorScheme.matches)
colorScheme.addEventListener('change', () => applyColorScheme(colorScheme.matches))

function promptText(prompt) {
  return (prompt.innerText ?? prompt.textContent ?? '').replaceAll('\u00a0', ' ')
}

function composeSend(instruction, selection) {
  if (selection === '') return instruction
  const joiner = '\n\n'
  const room = PROMPT_LIMIT - instruction.length - joiner.length
  if (room <= 0) return instruction
  const mark = `\n${messages.truncated}`
  let body = selection
  if (body.length > room) {
    const kept = Math.max(0, room - mark.length)
    body = kept === 0 ? mark.slice(0, room) : `${selection.slice(0, kept)}${mark}`
  }
  return `${instruction}${joiner}${body}`
}

function insertPlainText(prompt, text) {
  if (text === '') return
  if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) return
  prompt.append(text)
}

function editableTarget(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement
  if (element == null || typeof element.closest !== 'function') return false
  return element.closest('input, textarea, [contenteditable="true"]') !== null
}

function isComposing(event) {
  return event.isComposing === true || event.keyCode === 229
}

function parseRecommendedLabel(label) {
  return RECOMMENDED_SUFFIX.test(label)
    ? { label: label.replace(RECOMMENDED_SUFFIX, ''), recommended: true }
    : { label, recommended: false }
}

function emptyDrafts(questions) {
  return questions.map(() => ({ selected: [], custom: '', skipped: false }))
}

function draftAnswered(draft) {
  return draft.selected.length > 0 || draft.custom.trim() !== ''
}

function draftCompleted(draft) {
  return draftAnswered(draft) || draft.skipped
}

function buildAnswer(questions, drafts) {
  return {
    answers: questions.map((item, index) => {
      const value = drafts[index]
      if (value.skipped) return { id: item.id, selected: [] }
      const custom = value.custom.trim()
      return {
        id: item.id,
        selected: custom === '' || item.multiSelect === true ? value.selected : [],
        ...(custom === '' ? {} : { custom }),
      }
    }),
  }
}

function permissionText(preset) {
  if (preset === 'read-only') return messages.accessReadOnly
  if (preset === 'workspace-write') return messages.accessWrite
  return messages.accessFull
}

function main() {
  document.documentElement.lang = messages === zh ? 'zh' : 'en'
  const stop = document.querySelector('#stop')
  const newConversation = document.querySelector('#new-conversation')
  const historyButton = document.querySelector('#history')
  const permissionRoot = document.querySelector('#permission')
  const permissionButton = document.querySelector('#permission-button')
  const permissionLabel = document.querySelector('#permission-label')
  const permissionMenu = document.querySelector('#permission-menu')
  const ball = document.querySelector('#ball')
  const dockTab = document.querySelector('#dock-tab')
  const panel = document.querySelector('#panel')
  const wakeMeter = document.querySelector('#wake-meter')
  const wakeMeterFill = document.querySelector('#wake-meter-fill')
  const wakeMeterScore = document.querySelector('#wake-meter-score')
  const wakeMeterStreak = document.querySelector('#wake-meter-streak')
  const transcript = document.querySelector('#transcript')
  const questionRoot = document.querySelector('#question')
  const questionEyebrow = document.querySelector('#question-eyebrow')
  const questionTitle = document.querySelector('#question-title')
  const questionDetail = document.querySelector('#question-detail')
  const questionOptions = document.querySelector('#question-options')
  const questionCustom = document.querySelector('#question-custom')
  const questionError = document.querySelector('#question-error')
  const questionPager = document.querySelector('#question-pager')
  const questionProgress = document.querySelector('#question-progress')
  const questionPrev = document.querySelector('#question-prev')
  const questionNextNav = document.querySelector('#question-next-nav')
  const questionSkip = document.querySelector('#question-skip')
  const questionContinue = document.querySelector('#question-continue')
  const questionCancel = document.querySelector('#question-cancel')
  const historyList = document.querySelector('#history-list')
  const status = document.querySelector('#status')
  const voiceWave = document.querySelector('#voice-wave')
  const prompt = document.querySelector('#prompt')
  const composer = document.querySelector('#composer')
  applyStaticText()
  // Worn before anything is drawn, because the ball is only ever positioned by these classes.
  // The real answer comes over IPC a moment later; this is the same corner the helper puts the
  // ball in on a fresh profile (right edge, slightly below centre, panel opening leftward), so on
  // a default profile the correction is a no-op and nothing is ever drawn in the wrong column.
  applyDirection({ horizontal: 'left', vertical: 'down' })
  if (typeof api.direction === 'function') {
    void api.direction().then((state) => {
      if (state != null) applyDirection(state)
      // Reported once the direction is settled, so the first rects the main process polls against
      // are the ball's real ones. Until then the window is click-through, which is the right way
      // round: a ball that cannot be clicked yet is better than a window that swallows the first
      // click of a session.
      syncHitTest()
    })
  }

  let expanded = false
  let pinned = false
  let running = false
  let attachedSelection = ''
  let tccGateVisible = false
  let processGroup
  let processClock
  let dragging = false
  let collapsing = false
  let skipClick = false
  let skipDockCommit = false
  let suppressExpand = false
  let docked
  /**
   * Whether the carry in progress came out of the dock, and so wears no carry face of its own.
   *
   * A press on the ball closes a hand on something the user could see, and the whole drag vocabulary
   * applies: the lift, then the hang loop for as long as it is held. A pull out of the strip does
   * not. The ball was hidden a moment ago and there is no pose to lift out of, so the carry has no
   * face to wear and the ball keeps the one it arrived with — which is the drop it plays on the way
   * out, and then its resting pose.
   *
   * It is a second flag rather than a reuse of {@link dragging} because `dragging` is load-bearing
   * well beyond the picture: it is the hit-test region, the reason a hover does not expand the panel,
   * and the flag the release reads. Only the face is being suppressed here.
   */
  let carriedFromDock = false
  /**
   * Whether the gesture in progress is a pull out of the dock, where the ball undocks and the hand
   * does not carry it.
   *
   * This is the other half of {@link carriedFromDock}, and the two are consequences of the same
   * fact — that a pull out of the strip is not a carry. That one is about the *picture* (no lift, no
   * hang loop, the drop instead); this one is about the *motion*, and it is the one the user can feel.
   *
   * What a pull does instead of following the hand is travel: the helper slides the ball back on
   * screen from behind the edge over `DOCK_SLIDE_OUT_MS`, and the drop plays across that slide, so
   * the ball is seen coming in and falling at once. The pointer keeps its own job — it is what
   * recognised the pull and what ends it — but it does not drag the ball, and the ball is not put
   * under the cursor. That pairing is the feel: inward travel and 下落 together, hand off.
   *
   * It lasts for the whole gesture rather than just the slide, because the moments after the slide
   * are the ones where a follow would show: the pointer is still down and still moving, and a ball
   * that began travelling and then snapped onto the cursor would read as two gestures. Which is why
   * it is cleared on the *press* and on the release, and read by the move handler alone.
   *
   * A flag of its own, and not a reuse of `carriedFromDock`, because the two answer different
   * questions and only one of them is about the gesture's honesty: the face a dock pull wears is
   * settled (there is no pose to lift out of), but whether the ball follows the hand is a feel the
   * user is still deciding on. Keeping them apart is what makes bringing the follow back a one-line
   * change — drop this guard in the move handler and the centre grab below it is live again.
   */
  let undocking = false
  /**
   * The side a press on the strip started from, latched on `pointerdown` and kept for the gesture.
   *
   * It is separate from {@link docked} because the hand-off clears `docked` mid-gesture while the
   * pull is still being measured: the direction has to survive that, or the threshold would be
   * compared against the wrong edge and every move past the hand-off would read as inward.
   */
  let dockSide
  /**
   * The pointer's own last position, in screen coordinates and in the page's, kept for the docked
   * strip's drag.
   *
   * A press on the strip has no grab offset to measure — the ball is not under the pointer, it is
   * parked off the screen edge — so both the hand-off and the offset it hands to every later move
   * are derived from these four numbers instead. `screen - client` is the window's own origin, which
   * is the whole of the conversion between the coordinates `orb:move` is expressed in and the ones
   * `getBoundingClientRect` is measured in. See `handDockDragToBall`.
   */
  let lastScreenX = 0
  let lastScreenY = 0
  let lastClientX = 0
  let lastClientY = 0
  let dockPointerInside = false
  /**
   * The dwell timer for the docked arrival: armed when the pointer arrives on the strip, and
   * dropped when it leaves before {@link DOCK_ARRIVE_DWELL_MS} is up. See `beginDockArrive`.
   *
   * Distinct from `dockArriveTimer`, which is the clip's own hold.
   */
  let dockHoverTimer
  let collapseTimer
  let collapseFrame
  let pointer
  let lastOrigin
  // Where the pointer last was, in the page's own coordinates. The window is the overlay rect in
  // both states, so most of it is empty space over the desktop, and "is the pointer on one of
  // ours" has to be answered against the elements rather than against the window. See
  // `pointerOnBallOrPanel()` and `syncHitTest()`.
  let pointerAt
  let permission = 'danger-full-access'
  let permissionOpen = false
  let historyOpen = false
  let pending
  let sessionId = ''
  let avatarSrc = 'deepseek-avatar-square.gif'
  // The named frames the helper hands over, plus the meme bursts.
  let idleSrc
  // The resting loop's other face: worn instead of `idleSrc` while the account is nearly out of
  // money. `balanceCny` is what the host last read — `null` while nobody has said, which is not the
  // same as zero and does not turn this face on.
  let poorSrc
  let poorBelow = 0
  let balanceCny = null
  let hoverSrc
  let hoverIntroSrc
  let hoverIntroMs = 0
  // Whether the peek's intro file restarts on its own. It decides how the hand-off to the loop
  // is scheduled, so it travels with the frame rather than being re-read at the switch.
  let hoverIntroLoops = false
  let introUntil = 0
  // The dictation pose: worn for exactly as long as the ball is taking the user's voice, and
  // dropped the moment it is not. Unlike the one-shots above it is a loop, because the length
  // of a dictation is not known when it starts.
  let voiceSrc
  let voicePending = false
  // The speaking pose: worn while the ball reads an answer aloud. Same shape as the dictation
  // pose — a loop held for as long as the audio runs — but a different fact about the ball, so it
  // is a different frame and a different state variable.
  let speakSrc
  let speakPending = false
  // Whether read-aloud is running right now, mirrored out of the speaker's own state. Kept here
  // because `syncGif` is not a method of the speaker and still has to be able to ask.
  let speakActive = false
  let introTimer
  let typingSrc
  let replySrc
  let thinkingSrc
  let toolSrc
  // When the last frame of each kind arrived from a conversation that is not this ball's own — the DSH window
  // the user is actually looking at. Keyed by kind (`typing`, `thinking`, `tool`), because a turn is not one
  // activity: it reasons, then writes, then runs a tool, and only the writing is words arriving. Kept apart
  // from `agentState` on purpose: that is *this* page's turn, and letting somebody else's stream set it would
  // move the ball's own clock, ring its own bell and put the transcript's tool cards into a state nothing ran.
  const otherStreamAt = new Map()
  // The fetch face: a `data:` URL worn while a web page is being fetched. Separate from `toolSrc`
  // because a pack that names one has said something specific about that one call, and every other
  // tool still shares `tool`. `undefined` when the pack names no such file, which is what leaves
  // `tool` in charge of a fetch as well.
  // One face per tool name, as the pack answered for each: a `data:` URL, or `null` for "this call wears the
  // shared tool face". Keyed by the name in the transcript's tool card. See `loadNamedToolFrame`.
  const toolFrames = new Map()
  const toolFramePending = new Set()
  // When the transcript last changed. A block marked running counts as running only while this is recent: see
  // `agentPhase`, and `STALE_BLOCK_MS` for why the page second-guesses the flag at all.
  let transcriptAt = Date.now()
  // The one pending repaint for "the claim that was keeping a face up has gone stale". See `stage`.
  let staleAgentTimer
  // The tool another conversation is calling, as the host reported it. Empty when the host did not say — an
  // older host, or a frame that carried no name — in which case the shared tool face is what a call over there
  // wears, exactly as before this existed.
  let otherTool = ''
  // The poor frame's read, kept from racing the sweep with itself: two passes over `refreshFrames()`
  // can overlap, and the frame is a whole GIF.
  let poorPending = false
  // The click reaction: one pass of a GIF whenever the ball itself is clicked.
  let clickFrame
  let clickShown
  let clickTimer
  let clickStep = 0
  // The arrival: the clips the ball turns up with, played once each the moment this page opens,
  // before anything has been asked of it. It is the only cosmetic here that is not a reaction to
  // anything — see `wearArriveFrame` — and the flag keeps the sequence to one run per page.
  let arriveShown
  let arriveStep = 0
  let arrivePlayed = false
  /**
   * The docked arrival: the ball comes half way out of the edge on a hover of the strip, and the
   * entrance clip plays on it once the pointer has rested there, followed by the loop the ball rests
   * on while the pointer stays.
   *
   * The ball's only way back onto the desktop is still the drag in `dockTab`'s own listeners — this
   * is a greeting, not a way out, and nothing here may unsnap anything. What it does do is *show*
   * the ball: the strip is 34px of grey against the edge, and a clip played behind a hidden ball
   * would be a greeting nobody could see. The dock survives it and the ball is still not the user's
   * to move. Cached like the other named frames, because the pack's clip is megabytes and every
   * hover would otherwise re-read it. The frames are `{ left, right }`, each `{ file, loop }` — the
   * entrance that edge plays and the resting loop it hands over to — and only one thing is timed by a
   * number on this page: how long the pointer has to rest before the entrance is worth playing
   * ({@link DOCK_ARRIVE_DWELL_MS}, which is zero). How long the entrance stays up is not a number here
   * at all: the frame carries the length the helper measured off the file (`gifDurationMs`), so a clip
   * that is re-cut hands over on its own last frame. The loop has no hold; it ends with the hover or
   * the dock. Two edges rather than one because the ball is drawn flush against a screen edge looking
   * into the screen, so a clip drawn for the right edge faces out on the left: see {@link dockArriveFor}.
   */
  let dockArriveFrame
  let dockArriveShown
  let dockArriveStep = 0
  let dockArriveTimer
  /** Whether the frame is being read right now, so two hovers inside one read share it. */
  let dockArrivePending = false
  /**
   * The sources already handed to a decoder, so a frame is warmed once rather than on every hover.
   *
   * A `data:` GIF arrives already downloaded, but not already *decoded*: Chromium still has to turn its
   * frames into bitmaps, and an `<img>` paints a placeholder — the little broken-image icon inside a
   * white edge — until that is done. The clip that showed it on every hover was the avatar: 7.7MB,
   * already being decoded from page load, and still going when a hover swapped `src` underneath it.
   * See {@link warmFrame}.
   */
  let warmedFrames = new Set()
  /**
   * Whether the ball is currently standing half out of its edge, shown by a hover rather than by a
   * hand.
   *
   * The page's half of the helper's own `peeking`. It is what the `docked-peek` class on the body
   * follows — and so what makes the ball visible again — and it is what {@link pointerOnUi} asks
   * before it will count the ball itself as something the pointer is on.
   *
   * Dropped by `applyDocked` the moment there is no dock left, and *only* there: a peek that ends
   * because the user pulled the strip must not tell the helper to put the window back on its tab,
   * because the helper is about to be asked to slide the ball out from exactly where the peek left
   * it, and it has to still believe the ball is standing there.
   */
  let dockPeeked = false
  /**
   * Whether the sweep has finished its read.
   *
   * Without it, a pack that names no clip — the shipped default — would re-ask on every turn of the
   * poll and re-read a missing file for the life of the page. The read happens once; a slot that is
   * empty stays empty, which is also what the other named frames do.
   */
  let dockArriveRead = false
  // The finished-task frame: one pass of a GIF whenever a turn ends by itself.
  let doneFrame
  let doneShown
  // The acknowledgement. Not a state but an event: it is shown for the length of its own clip and then gone,
  // which is why it carries a step rather than a flag.
  /** The tool face in hand and the floor on how soon it may be replaced. See the note inside `syncGif`. */
  const toolFaceHoldState = { mode: '', until: 0 }
  let nodFrame
  let nodPending = false
  let nodTimer
  let nodStep = 0
  let nodShown
  let doneTimer
  let doneStep = 0
  // The failure face: one pass of a GIF whenever a turn ends because it failed. The other reading of
  // the same edge, so the two are mutually exclusive by construction — see `playFailFrame`.
  let failFrame
  let failShown
  let failTimer
  let failStep = 0
  let failPending = false
  // The question face: one shot of a GIF the moment the agent stops the turn to ask something,
  // worn for `ASK_HOLD_MS` and then handed back. It sits beside the finished-task frame because
  // the two are the same kind of event — the turn changed shape — and apart from it because they
  // say opposite things: one turn is over, the other is parked waiting on the user.
  let askFrame
  let askShown
  let askTimer
  let askStep = 0
  // Whether a read of that frame is already in flight, so two questions arriving inside one read
  // share it instead of racing each other over the same GIF.
  let askPending = false
  // The wake reaction: one pass of a GIF the moment the keyword fires, before the speaker
  // has said anything. It is the only cosmetic that answers the wake word itself.
  let wakeFrame
  let wakeShown
  let wakeTimer
  let wakeStep = 0
  // The carry face: the pickup plays once, then this loop is worn for as long as the ball is
  // held. Same shape as the peek above, so picking the ball up reads as a gesture.
  let dragSrc
  let dragIntroSrc
  let dragIntroMs = 0
  // Whether the pickup file restarts on its own; see `hoverIntroLoops`.
  let dragIntroLoops = false
  let dragIntroHold = 0
  let dragIntroUntil = 0
  let dragIntroTimer
  // The release face: one pass of a GIF the moment the pointer lets go. It is an event, not a
  // state — the carry wears `drag`, and what follows the carry is this, so it is kept apart from
  // `dragSrc` rather than being a second loop the carry could fall back to.
  let dropFrame
  let dropShown
  let dropTimer
  let dropStep = 0
  let agentState = ''
  // The name of the tool call the agent is waiting on, `''` when none is. Kept beside the phase
  // rather than inside it so `restingNow` and the other phase readers stay a plain string test.
  let agentTool = ''
  // The nap timeline: how long the ball has been untouched, and which frame it reached.
  let sleepInfo
  const sleepFrames = []
  const sleepLoading = new Set()
  /** `undefined` while awake, otherwise `{ kind: 'yawn' | 'sleep', index }`. */
  let napShown
  /** The yawn, read lazily: `undefined` until the read starts, `null` once it failed. */
  let yawnSrc
  let yawnLoading = false
  let sleepTimer
  let restStartAt = 0
  /** Starting the read this long before the nap keeps the first yawn from arriving late. */
  const YAWN_PREFETCH_MS = 5000
  // The idle skit: a scripted little loop the ball plays now and then while it rests.
  let skitInfo
  let skitTimer
  let skitPlaying = false
  let skitFrame
  // The skit clip played last, so the next one is drawn from the rest of the pool. Held here rather
  // than in the helper because the plan is read once per page and the rotation outlives that read.
  let skitLastSrc
  let hovering = false
  let typingAt = 0
  let typingTimer
  let memeInfo
  let memeTimer
  let memePlaying = false
  // Wake word: the engine lives in this page, the switch lives in the helper's menu.
  // `wakeState` mirrors what the engine last reported, and `wakeDetail` carries the
  // reason text an error state shows.
  let wakeState = 'disabled'
  let wakeDetail = ''
  // The live meter's last reading. Held as numbers rather than read back out of the DOM, so that a
  // repaint — the panel opening, the meter being unhidden — redraws from the engine's report instead
  // of from whatever the page last wrote.
  let wakeScore = 0
  let wakeAbove = false
  let wakeStreak = 0
  let wakeThreshold = 0.95
  // The reading a completed run fired at, held on screen for `WAKE_HOLD_MS` after it fired. See
  // `holdWake` for why the live reading cannot be the whole answer, and `paintWakeMeter` for how the
  // two are drawn apart.
  let wakeHeld
  // The length the fill was last drawn at. The bar has to be able to cross the line in the same
  // frame the engine counts the window, so the direction of the change decides whether the sheet
  // animates it; without a remembered length there is no direction to compare against.
  let wakeDrawn = 0
  /**
   * What to call the wake word in the status line.
   *
   * The engine reports the keyword it was configured with, and that name is a file stem, not
   * something to read aloud: a self-trained keyword is `dafeiyu`, and telling the user to say
   * "dafeiyu" would be worse than useless. Anything without a known spoken form falls back to the
   * raw name rather than to the shipped one — a wrong word is worse than an odd one.
   */
  // The wake word is the phrase said TWICE, so the hint has to say it twice too: a user told to say
  // 「大肥鱼」 once is being sent at a word the model was trained to ignore. Kept in step with
  // `WAKE_SPOKEN_NAMES` in `src/wake.ts` by `tests/wake-names.test.ts`.
  const KEYWORD_NAMES = { hey_jarvis: 'Hey Jarvis', dafeiyu: '大肥鱼大肥鱼' }
  let wakeKeyword = ''
  // One dictation at a time: the recorder lives on the engine's microphone.
  let dictationBusy = false
  let dictationTimer
  // What the user's sentence is doing right now: `recording` while the engine holds the
  // microphone for one utterance, `transcribing` while the host turns it into text.
  // `undefined` means no dictation is in flight. The engine cannot say this — it stops
  // reporting after its detection window, and it never sees the transcription at all.
  let dictationPhase
  // The live level waveform beside the status line: its bars, the animation frame that
  // repaints them, and the timestamp of the last repaint. The bars are built once; the
  // frame loop runs only while the engine holds the microphone for an utterance.
  const waveBars = []
  let waveFrame
  let wavePainted = -Infinity
  // The engine reports every state change through `onStatus`, so this page never has
  // to guess what the engine is doing.
  const wake = new WakeEngine(api, {
    onStatus: (status) => { applyWakeStatus(status) },
    // The score deliberately never reaches the helper: it arrives about eight times a second while
    // the microphone is open, and only this page's meter reads it.
    onScore: (update) => { applyWakeScore(update) },
  })
  let historyItems = []
  const blocks = new Map()
  // Last message per block key: the locale refresh re-renders from it.
  const blockData = new Map()
  let lastTccStatus

  /**
   * Re-apply every static label. Called at startup and on locale changes;
   * dynamic regions (permission, history, question, TCC gate, transcript) are
   * refreshed separately from their stored state.
   */
  function applyStaticText() {
    document.querySelector('#page-title').textContent = messages.title
    const stopButton = document.querySelector('#stop')
    stopButton.setAttribute('aria-label', messages.stop)
    stopButton.title = messages.stop
    const newConversationButton = document.querySelector('#new-conversation')
    newConversationButton.setAttribute('aria-label', messages.fresh)
    newConversationButton.title = messages.fresh
    const historyToggle = document.querySelector('#history')
    historyToggle.setAttribute('aria-label', messages.history)
    historyToggle.title = messages.history
    document.querySelector('#input-label').textContent = messages.placeholder
    prompt.dataset.placeholder = messages.placeholder
    questionCancel.textContent = messages.cancel
    questionSkip.textContent = messages.skip
    questionPrev.setAttribute('aria-label', messages.prev)
    questionNextNav.setAttribute('aria-label', messages.next)
    questionPrev.textContent = '‹'
    questionNextNav.textContent = '›'
    const chipDismiss = document.querySelector('#selection-chip-dismiss')
    chipDismiss.setAttribute('aria-label', messages.chipDismiss)
    chipDismiss.title = messages.chipDismiss
    document.querySelector('#tcc-screen-name').textContent = messages.tccScreenName
    document.querySelector('#tcc-screen-reason').textContent = messages.tccScreenReason
    document.querySelector('#tcc-screen-path').textContent = messages.tccScreenPath
    document.querySelector('#tcc-screen-open').textContent = messages.tccScreenOpen
    document.querySelector('#tcc-accessibility-name').textContent = messages.tccAccessibilityName
    document.querySelector('#tcc-accessibility-reason').textContent = messages.tccAccessibilityReason
    document.querySelector('#tcc-accessibility-path').textContent = messages.tccAccessibilityPath
    document.querySelector('#tcc-accessibility-open').textContent = messages.tccAccessibilityOpen
    document.querySelector('#tcc-title').textContent = messages.tccTitle
    document.querySelector('#tcc-later').textContent = messages.tccLater
    const tccClose = document.querySelector('#tcc-dismiss')
    tccClose.setAttribute('aria-label', messages.tccDismiss)
    tccClose.title = messages.tccDismiss
    for (const option of permissionMenu.querySelectorAll('button')) {
      option.textContent = permissionText(option.dataset.preset)
    }
  }

  /** Re-render every text surface after the dictionary switched. */
  function refreshAllText() {
    applyStaticText()
    renderPermission()
    renderHistory()
    if (pending !== undefined) renderQuestion()
    if (tccGateVisible && lastTccStatus) showTccGate(lastTccStatus)
    refreshProcessLabel(processGroup)
    refreshTranscriptLocale()
    syncWake()
  }

  /** Locale-dependent labels inside the transcript, from the stored messages. */
  function refreshTranscriptLocale() {
    for (const [key, node] of blocks) {
      const block = blockData.get(key)
      if (block === undefined) continue
      if (block.kind === 'user') continue
      if (block.kind === 'reasoning') {
        node.querySelector('.think-title').textContent = messages.think
        node.querySelector('.visually-hidden').textContent = block.running ? messages.running : ''
      } else if (block.kind === 'tool') {
        updateToolNode(node, block)
      } else {
        updateAssistantNode(node, block)
      }
    }
    refreshProcessLabel(processGroup)
  }

  function pageClosed() {
    return globalThis.document?.body == null
  }

  /**
   * Build the level waveform's bars, once.
   *
   * The geometry is the official voice-input capture row's, unit for unit: eighty bars
   * eight units apart across a 640 x 40 box, each a single rounded stroke drawn from the
   * baseline at y=20, with the opacity ramp making the newest sample the brightest.
   */
  function buildWaveform() {
    if (voiceWave === null) return
    for (let index = 0; index < WAVE_BARS; index += 1) {
      const bar = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      bar.setAttribute('x1', String(index * 8 + 4))
      bar.setAttribute('x2', String(index * 8 + 4))
      bar.setAttribute('y1', '19')
      bar.setAttribute('y2', '21')
      bar.setAttribute('stroke', 'currentColor')
      bar.setAttribute('stroke-width', '3')
      bar.setAttribute('stroke-linecap', 'round')
      bar.setAttribute('opacity', String(0.25 + index / 120))
      voiceWave.appendChild(bar)
      waveBars.push(bar)
    }
  }

  /**
   * Park every bar on the baseline: two units tall, which is the dotted line the official
   * row shows for silence rather than an empty box.
   */
  function restWaveform() {
    for (const bar of waveBars) {
      bar.setAttribute('y1', '19')
      bar.setAttribute('y2', '21')
    }
  }

  /**
   * Draw one snapshot of the engine's levels, oldest at the left and newest at the right.
   *
   * The curve is the official one: two units at silence up to thirty-six at a full-scale
   * level, which is five times the measured RMS clamped at 1 — speech lands in the middle
   * of the box instead of pinning every bar to its ceiling.
   */
  function paintWaveform(levels) {
    for (let index = 0; index < waveBars.length; index += 1) {
      const height = 1 + Math.min(1, levels[index] * 5) * 17
      waveBars[index].setAttribute('y1', String(20 - height))
      waveBars[index].setAttribute('y2', String(20 + height))
    }
  }

  /**
   * Follow the microphone for as long as one utterance is being recorded.
   *
   * The loop ends itself the moment the phase leaves `recording`, so the meter cannot
   * outlive the recording it describes — and the bars go back to the baseline, because a
   * frozen waveform is indistinguishable from a live one that stopped hearing anything.
   */
  function followWaveform() {
    if (waveFrame !== undefined) return
    restWaveform()
    wavePainted = -Infinity
    waveFrame = requestAnimationFrame(function step(now) {
      if (dictationPhase !== 'recording') {
        waveFrame = undefined
        restWaveform()
        return
      }
      waveFrame = requestAnimationFrame(step)
      if (now - wavePainted < WAVE_STEP_MS) return
      wavePainted = now
      paintWaveform(wake.waveform())
    })
  }

  /**
   * Draw the wake state.
   *
   * The collar and the badge both come from this one function, so the ball can never
   * show a state the engine is not actually in. `listening` and `detected` are the two
   * states the user has to be able to tell apart without reading anything.
   *
   * The page's own dictation phase outranks the engine's state wherever the two disagree.
   * They disagree for most of every dictation: the engine holds `detected` for a few seconds
   * and then reports `listening` again, while the recording runs until the speaker pauses
   * and the transcription until the host answers. Read from the engine alone, the badge would
   * tell the user to say the wake word again in the middle of their own sentence.
   *
   * It is also the only writer of the recording class, which is what reveals the live level
   * meter: a meter shown from anywhere else could disagree with the badge next to it.
   */
  function syncWake() {
    if (pageClosed()) return
    const recording = dictationPhase === 'recording'
    const transcribing = dictationPhase === 'transcribing'
    const listening = !recording && !transcribing && wakeState === 'listening'
    // A live recording is the same thing to look at as a detection: the ball has the
    // microphone and it is taking words, so it wears the same green.
    const detected = recording || (!transcribing && wakeState === 'detected')
    document.body.classList.toggle('wake-listening', listening)
    document.body.classList.toggle('wake-detected', detected)
    // Recording is the one phase with a live *level* row in the panel, so that row is sized and
    // shown from this single class rather than from the phase being read twice. The wake meter is a
    // different question and answers it below.
    document.body.classList.toggle('wake-recording', recording)
    document.body.classList.toggle('wake-loading', wakeState === 'loading')
    document.body.classList.toggle('wake-error', wakeState === 'error')
    document.body.classList.toggle('wake-transcribing', transcribing)
    // The meter is up exactly while the wake engine is the one holding the microphone *and scoring
    // it*: listening, the detection hold, and the wait for a transcript. The engine keeps scoring
    // through all three — only the recorder stops it — so hiding the bar for any of them hides a
    // live score, and a wake that lands in the hidden one is a chime with no reading beside it.
    //
    // `recording` is the opposite case and the reason this is not simply "listening or detected":
    // the recorder has the microphone and nothing is being scored, so the bar would be frozen at the
    // last reading of a finished stream and read as a live one. A held reading is the one thing that
    // stays up through it, because a hold is a record of what fired rather than a live score.
    const scoring = !recording && (listening || wakeState === 'detected' || transcribing)
    const meterVisible = scoring || heldWake() !== undefined
    if (wakeMeter !== null) {
      wakeMeter.hidden = !meterVisible
      // Re-drawn on the way in, so the first frame after the microphone opens shows the engine's
      // standing score rather than whatever the last stream left behind.
      if (meterVisible) paintWakeMeter()
    }
    const badge = document.querySelector('#wake-badge')
    if (badge === null) return
    let text = ''
    if (recording) text = messages.wakeRecording
    else if (transcribing) text = messages.wakeTranscribing
    else if (wakeState === 'loading') text = messages.wakeLoading
    else if (listening) {
      // Filled in from the engine's own report, so a profile that trains its own word does not
      // get told to say the shipped one.
      text = messages.wakeListening.replace('{word}',
        KEYWORD_NAMES[wakeKeyword] ?? wakeKeyword)
    }
    else if (detected) text = messages.wakeDetected
    else if (wakeState === 'error') {
      text = wakeDetail === ''
        ? messages.wakeUnavailable
        : messages.wakeFailed.replace('{why}', wakeDetail)
    } else if (wakeState !== 'disabled') text = messages.wakeUnavailable
    badge.textContent = text
    badge.hidden = text === '' || !expanded
    // The ball itself is the always-visible surface: a tooltip explains the collar.
    const ballButton = document.querySelector('#ball')
    if (ballButton !== null) {
      if (text === '') ballButton.removeAttribute('title')
      else ballButton.title = text
    }
  }

  /** Apply one engine report: state, wording, and the one cosmetic that follows a wake. */
  function applyWakeStatus(status) {
    if (status === null || typeof status !== 'object') return
    wakeState = typeof status.state === 'string' ? status.state : wakeState
    wakeDetail = typeof status.detail === 'string' ? status.detail : ''
    if (typeof status.keyword === 'string' && status.keyword !== '') wakeKeyword = status.keyword
    syncWake()
    if (wakeState !== 'detected') return
    // Before anything else, so the reading that fired is on the meter in the same frame as the
    // chime. Everything after this point makes the meter stop being able to explain the wake: the
    // engine's next window clears the streak and the dots with it, and the recording that follows
    // stops the scoring altogether.
    holdWake(wakeScoreIn(status.detail))
    // The acknowledgement comes first: it has to be on screen before the panel opens and
    // before the recorder takes over, because it is the only sign that the ball heard its
    // name rather than merely the sound of someone talking to it.
    playWakeFrame()
    // A detection that the user cannot see is not a feature. Opening the panel shows
    // the badge and puts the composer in reach, which is where the next step starts.
    if (wake.autoExpand() && !expanded && !pinned && !running && !asking()) void setExpanded(true)
    void startDictation()
  }

  /**
   * Build the meter's streak dots, one per window the detection rule needs in a row.
   *
   * Built from `CONSECUTIVE_WINDOWS` rather than written into the markup because the dots are the
   * rule drawn as a picture: three dots next to a rule that fires on two windows would teach the
   * user something false, and the two places would drift the first time the constant changed.
   */
  function buildWakeMeter() {
    if (wakeMeterStreak === null) return
    wakeMeterStreak.replaceChildren()
    for (let i = 0; i < CONSECUTIVE_WINDOWS; i += 1) {
      const dot = document.createElement('i')
      dot.className = 'wake-meter-dot'
      wakeMeterStreak.append(dot)
    }
  }

  /**
   * Apply one scored window: the classifier's own report, once per window while listening.
   *
   * Nothing here is judgement — the engine has already decided what counts. `above` is the raw
   * threshold comparison and `streak` is the run the detection rule acts on, so a bar past the line
   * with no dot lit is the cooldown or a quiet VAD, not a bug, and it has to stay visible as that.
   */
  function applyWakeScore(update) {
    if (update === null || typeof update !== 'object') return
    if (typeof update.score === 'number' && Number.isFinite(update.score)) wakeScore = update.score
    if (typeof update.threshold === 'number' && Number.isFinite(update.threshold)) wakeThreshold = update.threshold
    wakeAbove = update.above === true
    wakeStreak = typeof update.streak === 'number' ? update.streak : 0
    paintWakeMeter()
  }

  /**
   * The score a detection fired at, out of the detail the engine reports with it.
   *
   * `detected()` publishes `score 0.987`. Read from the status rather than from the last window on
   * the score channel on purpose: the two arrive on different channels, and the status is the one
   * that means "this is a detection, not a coincidence". A detail that does not parse leaves the
   * hold to fall back to the live reading, which is the same window anyway.
   */
  function wakeScoreIn(detail) {
    const match = /score ([0-9.]+)/.exec(typeof detail === 'string' ? detail : '')
    const value = match === null ? Number.NaN : Number(match[1])
    return Number.isFinite(value) ? value : undefined
  }

  /**
   * Hold the reading that just fired, so the meter still answers "why" after the chime.
   *
   * A detection is three consecutive windows and the ball chimes on the third, so the whole run is
   * about 380 ms and the engine has already cleared the streak by the time the sound arrives. On top
   * of that the bar is animated, the recording that follows stops the scoring, and the end of that
   * recording resets the reading to zero — between them, a user who looks up at the chime has
   * nothing left to read, and reports the ball as having woken for no reason. The hold is what makes
   * the reading survive long enough to be read, and it is drawn as a record rather than as a live
   * score (`held`).
   *
   * @param score - the score the engine reported with the detection, or undefined.
   */
  function holdWake(score) {
    const held = score === undefined ? wakeScore : score
    if (wakeHeld !== undefined) clearTimeout(wakeHeld.timer)
    const expiresAt = Date.now() + WAKE_HOLD_MS
    const timer = setTimeout(() => {
      // The check is not a duplicate of the clear below it: this timer belongs to one particular
      // hold, and a newer hold taken in the meantime must not be cancelled by the older one's
      // expiry. The `clearTimeout` above is not enough on its own — a callback that has already
      // been queued still runs.
      if (wakeHeld === undefined || wakeHeld.expiresAt > Date.now()) return
      wakeHeld = undefined
      // The hold is also what can be keeping the meter on screen, and it is the only state that
      // ends by itself: without this the bar would stay up over a microphone nothing is scoring.
      syncWake()
    }, WAKE_HOLD_MS + 30)
    wakeHeld = { score: held, expiresAt, timer }
    // The two edges of a hold are handled the same way on purpose. A hold is one of the two things
    // that can keep the bar on screen - `syncWake`'s rule reads it directly - so taking one changes
    // the answer to a question this function does not own, and the expiry already re-decides for the
    // same reason. Drawing without re-deciding touches only the half that cannot bring the bar back:
    // the reading would be there, and not shown. `syncWake` paints whenever it shows the bar, so it
    // covers both.
    syncWake()
  }

  /**
   * The held reading while its hold lasts, or undefined.
   *
   * This comparison — not the timer — is what decides. `holdWake` fires its timer 30 ms *after* the
   * hold ends, and a timer that is late is a timer doing its job, so the reading has to be able to
   * let go on its own. What the timer does instead is the one thing a comparison cannot: make the
   * page re-decide, at the moment the hold ends, whether the bar still belongs on screen.
   */
  function heldWake() {
    return wakeHeld !== undefined && Date.now() < wakeHeld.expiresAt ? wakeHeld : undefined
  }

  /**
   * Draw the engine's last reading.
   *
   * The two lengths go out as CSS variables instead of as pixel widths: the track's length is the
   * layout's business (`--ball`), and the score is a fraction of it, so neither number has to be
   * known here. Clamped because a variable is a promise the rest of the sheet reads, and a score
   * outside 0..1 would paint the fill past the track's edge.
   *
   * A held reading outranks the live one for its hold: it is drawn at the score that fired, carries
   * the whole rule as lit dots, and wears the crossed colour, because a run that fired is by
   * definition all three of those things. Everything else is the live report, unchanged.
   */
  function paintWakeMeter() {
    if (wakeMeter === null) return
    const held = heldWake()
    const score = held === undefined ? wakeScore : held.score
    const above = held === undefined ? wakeAbove : true
    const streak = held === undefined ? wakeStreak : CONSECUTIVE_WINDOWS
    wakeMeter.style.setProperty('--wake-score', String(Math.min(1, Math.max(0, score))))
    wakeMeter.style.setProperty('--wake-threshold', String(Math.min(1, Math.max(0, wakeThreshold))))
    wakeMeter.classList.toggle('hot', above)
    wakeMeter.classList.toggle('held', held !== undefined)
    if (wakeMeterScore !== null) wakeMeterScore.textContent = score.toFixed(3)
    // A crossing has to be drawn in the frame the engine counts it: the ball chimes two windows
    // after the first one over the line, so a bar that eases upwards is still on its way there when
    // the wake is heard. Only a falling reading is animated — that is the direction where the
    // 128 ms steps would otherwise read as flicker, and the one where arriving late costs nothing.
    if (wakeMeterFill !== null) wakeMeterFill.classList.toggle('falling', score <= wakeDrawn)
    wakeDrawn = score
    if (wakeMeterStreak === null) return
    const dots = wakeMeterStreak.children
    for (let i = 0; i < dots.length; i += 1) {
      dots[i].classList.toggle('on', i < streak)
    }
  }

  /** Base64 for a binary buffer, chunked so a long utterance cannot blow the call stack. */
  function base64Of(buffer) {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    }
    return btoa(binary)
  }

  /**
   * End the dictation: give the badge back to the wake word and release the recorder.
   *
   * The one place all three happen, so a phase can never outlive the recording it describes. The
   * badge has to say "your turn to speak the wake word" again however the dictation ended — an
   * empty utterance, a switched-off engine, a failed transcription, or a host that never
   * answered — and the ball has to stop nodding at the same moment, because the pose is chosen
   * from that same phase.
   */
  function endDictation() {
    dictationBusy = false
    dictationPhase = undefined
    syncWake()
    // The closing edge of the phase, and the one every ending really travels: clearing the phase
    // without repainting leaves the ball wearing the dictation pose until something else happens
    // to redraw it. After an empty utterance nothing else does — the user said nothing, the
    // engine gave up, and the ball goes on nodding at a wake-word listener that is already
    // listening again. Every ending comes through here, so one repaint covers them all.
    syncGif()
  }

  /** Move to the next dictation phase, redrawing the badge straight away. */
  function setDictationPhase(phase) {
    dictationPhase = phase
    if (phase === 'recording') {
      followWaveform()
      // The pose may not have been prefetched yet on the first wake after a restart. Start it
      // now rather than showing the resting face through the user's first sentence.
      if (voiceSrc === undefined) void loadVoiceFrame()
    }
    syncWake()
    // The dictation pose is chosen from this phase, so a phase that changes without a repaint
    // leaves the ball wearing the face of the phase before it.
    syncGif()
  }

  /**
   * After a wake: record one utterance on the microphone the engine already holds and ask
   * the host to transcribe it. The transcript fills the composer (and is sent only when the
   * profile asks for that), so the wake word plus one sentence is a complete hands-free turn.
   */
  async function startDictation() {
    const settings = wake.config?.dictation
    if (settings === undefined || settings.enabled !== true) return
    if (dictationBusy || typeof api.dictate !== 'function') return
    // The recorder lives on the wake engine's microphone: without a live engine there is
    // nothing to record, so say that instead of opening a microphone that never starts.
    if (wake.running !== true) {
      status.textContent = messages.dictationNeedsWake
      return
    }
    dictationBusy = true
    clearTimeout(dictationTimer)
    // Handing the recording to the host is the only outcome that keeps the ball busy, because
    // it is the only one the host answers (`applyTranscript` releases the recorder then).
    // Every other way out of this function has to release it in the `finally` below: one
    // dictation left "in flight" makes the guard above swallow every later wake whole — no
    // recording, no error, not even the closing tone — until the page is reloaded.
    let handedOff = false
    try {
      // The detection chime is a WebAudio tone on the same output; let it die out first.
      await wait(DICTATION_DELAY_MS)
      if (wake.running !== true) return
      status.textContent = messages.dictating
      setDictationPhase('recording')
      const wav = await wake.dictate({ silenceMs: settings.silenceMs, maxSeconds: settings.maxSeconds })
      if (wav === undefined) {
        // The engine gave up without hearing anything and has already sounded that cue, so
        // the line says the same thing instead of going blank and looking like a dead ball.
        status.textContent = messages.dictationEmpty
        return
      }
      // Turning the switch off mid-utterance also ends the recording: do not transcribe it.
      if (wake.running !== true) {
        status.textContent = ''
        return
      }
      // The microphone is released by now; only the host's answer is still outstanding.
      setDictationPhase('transcribing')
      await api.dictate({ audioBase64: base64Of(wav) })
      handedOff = true
      // A host that never answers must not leave the ball stuck on "recognizing".
      dictationTimer = setTimeout(() => {
        endDictation()
        status.textContent = messages.dictationLost
      }, DICTATION_TIMEOUT_MS)
    } catch (error) {
      status.textContent = messages.dictationFailed.replace('{why}', error instanceof Error ? error.message : String(error))
    } finally {
      if (!handedOff) endDictation()
    }
  }

  /** Put one finished transcript into the composer, or send it when the profile asks. */
  function applyTranscript(payload) {
    if (payload === null || typeof payload !== 'object') return
    if (dictationBusy) clearTimeout(dictationTimer)
    // The host has answered, so the ball is back to waiting for the wake word — whether the
    // answer was a sentence, an empty one, or a reason it could not be recognized.
    endDictation()
    if (typeof payload.error === 'string' && payload.error !== '') {
      status.textContent = messages.dictationFailed.replace('{why}', payload.error)
      return
    }
    const text = typeof payload.text === 'string' ? payload.text.trim() : ''
    if (text === '') {
      status.textContent = messages.dictationEmpty
      return
    }
    status.textContent = ''
    // The transcript lands in the composer, so the panel has to be open to see it.
    if (!expanded) void setExpanded(true)
    insertPlainText(prompt, text)
    syncComposerHeight()
    const send = wake.config?.dictation?.autoSend === true
    if (!send) {
      prompt.focus()
      return
    }
    if (typeof composer.requestSubmit === 'function') composer.requestSubmit()
    else composer.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }

  async function startWake() {
    const config = await api.wakeConfig()
    if (config === null || typeof config !== 'object') return
    if (config.ready !== true) {
      // No model directory was configured on the host side; say so instead of
      // leaving the ball looking like it is listening.
      await wake.publish('error', 'no local models')
      return
    }
    wake.configure(config)
    void wake.enable()
  }

  function freezeGif(gif) {
    const still = () => {
      if (gif.dataset.mode !== 'still' || gif.naturalWidth === 0) return
      const canvas = document.createElement('canvas')
      canvas.width = gif.naturalWidth
      canvas.height = gif.naturalHeight
      const context = canvas.getContext('2d')
      if (context === null) return
      context.drawImage(gif, 0, 0)
      try {
        gif.src = canvas.toDataURL()
      } catch {
        // The GIF already reset to its first frame.
      }
    }
    if (gif.complete && gif.naturalWidth > 0) still()
    else gif.addEventListener('load', still, { once: true })
  }

  function asking() {
    return pending !== undefined
  }

  /**
   * Whether a frame's own file starts over by itself, read from the bytes the helper sent.
   *
   * The page is handed every image as a `data:` URL, so the same repeat block the decoder
   * reads is already in hand. A repeat count of zero means the file restarts the instant it
   * reaches its last frame; no block at all means it plays once and stops there, holding that
   * frame. Reading it beats inferring it from the length: a file's length says nothing about
   * whether its last frame is the end of the clip or a boundary it is about to cross again.
   */
  function loopsForever(src) {
    if (typeof src !== 'string') return false
    const comma = src.indexOf(',')
    if (comma < 0 || !src.startsWith('data:') || !src.slice(0, comma).includes(';base64')) return false
    let raw
    try {
      raw = atob(src.slice(comma + 1))
    } catch {
      return false
    }
    // Application extension: name(11) + sub-block size(1) + sub-block id(1) + count(2).
    const at = raw.indexOf('NETSCAPE2.0')
    return at >= 0 && raw.charCodeAt(at + 13) === 0 && raw.charCodeAt(at + 14) === 0
  }

  /**
   * How long a cue — a reaction the ball shows on its own account — stays up before the ball
   * goes back to what it was doing.
   *
   * A file that restarts on its own is given one pass and a little less. The hand-off has to
   * land before the frame the decoder restarts from, because landing on it is a coin flip: the
   * next pass has already begun, so one frame of the opening pose leaks out before the pose
   * that follows takes over. The margin is a share of the clip's own length, so a long cue
   * earns a long lead, with {@link ONE_SHOT_CUT_MS} as the floor. One pass is all such a file
   * gets — holding it longer would only mean watching it play again.
   *
   * A file that stops on its own last frame is given its whole length and then some, which is
   * what lets {@link ONE_SHOT_MIN_MS} do its job: a short cue that ends on a settle is held
   * there long enough to read as an answer rather than a blink, at no risk of a restart.
   */
  function oneShotHoldMs(ms, loops) {
    if (loops !== true) return Math.max(ms, ONE_SHOT_MIN_MS)
    return Math.max(ms - Math.max(ONE_SHOT_CUT_MS, Math.round(ms * 0.15)), 120)
  }

  /**
   * How long a transition — a clip that ends by handing over to another animation — is given.
   *
   * A transition is the opposite of a cue: the loop it leads into should start the moment the
   * clip has finished, not after the clip has held a pose. A file that plays once already ends
   * there, so it is given its own length exactly, which is what makes the seam invisible. One
   * that starts over on its own has to give up its last frames instead, since landing the
   * hand-off before the restart is the only way to keep the opening pose from showing twice.
   */
  function transitionHoldMs(ms, loops) {
    if (loops !== true) return ms
    return Math.max(ms - Math.max(ONE_SHOT_CUT_MS, Math.round(ms * 0.15)), 120)
  }

  function syncGif() {
    if (pageClosed()) return
    syncSleep()
    // Read once, with a default, so this function stops being a list of everything the page has to hand it.
    // The page tests compile `syncGif` out of this file and inject its captured variables one at a time, so
    // every new module-level value it reads turns every one of those files red with "x is not defined" — which
    // happened three times. A default here means the compiled body runs with nothing injected, and the only
    // thing the tests then have to provide is what they are actually about.
    const holdStream = typeof OTHER_STREAM_HOLD_MS === 'number' ? OTHER_STREAM_HOLD_MS : 2500
    const holdWork = typeof OTHER_WORK_HOLD_MS === 'number' ? OTHER_WORK_HOLD_MS : 4000
    const streamAt = typeof otherStreamAt !== 'undefined' && otherStreamAt !== null ? otherStreamAt : new Map()
    // The pack's per-name answers, which a compiled body has no counterpart for either: an empty map is the
    // honest default — it means "no tool has its own face", which is what every pack meant before this slot.
    const namedToolFaces = typeof toolFrames !== 'undefined' && toolFrames !== null ? toolFrames : new Map()
    // The tool a foreign conversation is calling, defaulted for the same reason: a compiled body has no such
    // variable, and `''` is the honest default — it means "nobody said which tool", which is what this page
    // assumed about every call over there before the host started sending names.
    const namedOtherTool = typeof otherTool === 'string' ? otherTool : ''
    // The acknowledgement cue's marker, defaulted for the same reason as the three above: a compiled body has
    // no such variable, and `undefined` is the honest value — it says no nod is playing.
    const nodMarker = typeof nodShown !== 'undefined' ? nodShown : undefined
    // The turn-ending cue's marker, defaulted like the rest: a compiled body has no such variable, and
    // `undefined` is the honest value — it says no ending is being shown.
    const turnEndMarker = typeof turnEndShown !== 'undefined' ? turnEndShown : undefined
    // The tool face in hand and the floor on how soon it may be replaced. Inlined rather than reached for
    // through module scope, because the page tests compile this function alone and a name it cannot see is a
    // rule that silently stops being tested. `faceHold` is the state object: on the page it is the module-level
    // pair, and a test hands in its own.
    const faceHold = typeof toolFaceHoldState === 'object' && toolFaceHoldState !== null
      ? toolFaceHoldState
      : { mode: ``, until: 0 }
    const holdTheToolFace = () => {
      if (faceHold.mode === '') return false
      if (Date.now() >= faceHold.until) {
        faceHold.mode = ''
        return false
      }
      return true
    }
    const notedToolFace = (mode) => {
      faceHold.mode = mode
      faceHold.until = Date.now() + (typeof TOOL_FACE_HOLD_MS === 'number' ? TOOL_FACE_HOLD_MS : 1300)
    }
    const gif = document.querySelector('#ball-gif')
    // Being carried around the desktop outranks every pose, including the click reaction — unless
    // the carry started at the dock, which has no carry face: see {@link carriedFromDock}. Skipping
    // the branch rather than special-casing the source is what lets the drop below show through, so
    // a pull out of the strip is the ball falling out of it and then resting, with no hang loop in
    // between. Everything the *gesture* needs is unaffected — the hit-test, the suppressed hover and
    // the docking are `dragging`'s, and that is untouched.
    if (dragging && dragSrc !== undefined && !carriedFromDock) {
      const intro = dragIntroSrc !== undefined && Date.now() < dragIntroUntil
      const mode = intro ? 'drag-intro' : 'drag'
      if (gif.dataset.mode !== mode) {
        gif.dataset.mode = mode
        gif.src = intro ? dragIntroSrc : dragSrc
      }
      return
    }
    // The release that follows the carry. It sits directly under `drag` so that picking the ball
    // up again cuts the drop short — the ball is being carried, and that is the more current fact
    // — and above everything else because it is the other half of the gesture the user just made.
    if (dropShown !== undefined) {
      const mode = `drop-${dropShown.step}`
      if (gif.dataset.mode !== mode) {
        gif.dataset.mode = mode
        gif.src = dropShown.src
      }
      return
    }
    // The arrival at the dock: the greeting the ball plays *instead of* coming back out, worn while
    // it stays hidden behind the strip. It is a cue the user asked for with their own hand — the
    // pointer came to rest on the strip — so it sits with the click reaction rather than with the
    // states below, and above the click reaction because the hand that pulled the strip is the
    // gesture in progress. A carry cuts it off: the strip is being dragged, and the ball is on its
    // way out.
    if (dockArriveShown !== undefined) {
      const shown = dockArriveShown
      const mode = `dock-arrive-${shown.step}`
      // The source is compared too, not just the mode: the entrance and the loop it hands over to
      // share one step, so the mode does not change across the hand-off, and only the source tells
      // the image element to switch from the entrance's frames to the loop's.
      //
      // The assignment itself stays plain and synchronous. Every hover changes the ball's whole
      // picture at once, and an `<img>` paints an empty white box for as long as the incoming frames
      // take to decode — a box that showed on *every* hover, not just the first. The cure for that is
      // not to make this line asynchronous, which would leave the ball wearing the old clip and race
      // every later state against the wait; it is to have the frames decoded *before* the line runs,
      // so the browser has a bitmap the moment `src` moves. That is {@link warmFrame}, and it is
      // called the instant the frame is read — at startup and again on any on-demand read — which is
      // the only point at which it can be free.
      if (gif.dataset.mode !== mode || gif.src !== shown.src) {
        gif.dataset.mode = mode
        gif.src = shown.src
      }
      return
    }
    // The click reaction outranks everything else: it is the only state the user asked for directly.
    if (clickShown !== undefined) {
      const mode = `click-${clickShown.step}`
      if (gif.dataset.mode !== mode) {
        gif.dataset.mode = mode
        gif.src = clickShown.src
      }
      return
    }
    // The wake reaction. It outranks the finished-task frame because it is the newer of the
    // two events when they collide: a turn that ends within the second after a wake must not
    // swallow the acknowledgement the user is waiting for before they start speaking.
    if (wakeShown !== undefined) {
      const mode = `wake-${wakeShown.step}`
      if (gif.dataset.mode !== mode) {
        gif.dataset.mode = mode
        gif.src = wakeShown.src
      }
      return
    }
    // The agent has stopped and asked the user something. It outranks the finished-task frame, the
    // greeting, and every face the agent wears while it works — `tool` above all, because that is
    // the one this event arrives *as*: a question is a running tool call, so a branch below the
    // tooling face would never be reached and the ball would show its drawing board while it waited
    // for an answer. It sits below the wake reaction, the only cue that is the user's own voice
    // being answered: this face is a six-second *hold* rather than a cue, so a chime borrowing the
    // ball for half a second costs it nothing, while the reverse would swallow the acknowledgement.
    if (askShown !== undefined) {
      const mode = `ask-${askShown.step}`
      if (gif.dataset.mode !== mode) {
        gif.dataset.mode = mode
        gif.src = askShown.src
      }
      return
    }
    // The run failed. It is the same event as the finished-task frame below and the opposite news, so
    // it sits directly above it: one of the two is up at any moment, never both. Like every other cue
    // it outranks the resting poses — including the poor face, which is a *state* — and hands the ball
    // back to whatever the resting logic says as soon as its one pass is over.
    if (failShown !== undefined) {
      const mode = `fail-${failShown.step}`
      if (gif.dataset.mode !== mode) {
        gif.dataset.mode = mode
        gif.src = failShown.src
      }
      return
    }
    // The task just finished. Like the click reaction this is its own event rather than a
    // state to sit in, so it briefly outranks the resting poses: a turn that ends while the
    // pointer happens to rest on the ball still has to be visible.
    if (nodMarker !== undefined) {
      const mode = `nod-${nodMarker.step}`
      if (gif.dataset.mode !== mode) {
        gif.dataset.mode = mode
        gif.src = nodMarker.src
      }
      return
    }
    if (turnEndMarker !== undefined) {
      const mode = `turn-end-${turnEndMarker.step}`
      if (gif.dataset.mode !== mode) {
        gif.dataset.mode = mode
        gif.src = turnEndMarker.src
      }
      return
    }
    if (doneShown !== undefined) {
      const mode = `done-${doneShown.step}`
      if (gif.dataset.mode !== mode) {
        gif.dataset.mode = mode
        gif.src = doneShown.src
      }
      return
    }
    // The arrival: the greeting the ball turns up with, up only in the first seconds of a page's
    // life. It sits below every event cue above and above every state pose below, which is the
    // whole of its rule: the user's own hand and the agent's own events are never swallowed by a
    // greeting, and nothing that is merely a *state* — a stream, a fetch, a resting loop — ever
    // gets to be the first thing seen when the orb comes up. It is not a state itself: the page
    // owns both ends of it, so a cue that outranks it here delays that one clip by its own length
    // and the sequence carries on where it left off. The step is per clip, which is what makes the
    // second one start from its own first frame instead of inheriting the pose of the first.
    if (arriveShown !== undefined) {
      const mode = `arrive-${arriveShown.step}`
      if (gif.dataset.mode !== mode) {
        gif.dataset.mode = mode
        gif.src = arriveShown.src
      }
      return
    }
    // Typing in the ball's own composer outranks every other cosmetic state.
    if (typingSrc !== undefined && Date.now() - typingAt < TYPING_HOLD_MS) {
      if (gif.dataset.mode !== 'typing') {
        gif.dataset.mode = 'typing'
        gif.src = typingSrc
      }
      return
    }
    // The agent is streaming a text answer: the ball types along. Reasoning has its own frame.
    if (replySrc !== undefined && agentState === 'replying') {
      if (gif.dataset.mode !== 'reply') {
        gif.dataset.mode = 'reply'
        gif.src = replySrc
      }
      return
    }
    // A tool call is running. A fetch wears its own face when the pack names one, because it is the
    // call the user watches rather than waits for; everything else — and a fetch in a pack that
    // names no such file — keeps the shared one.
    //
    // The two get different `dataset.mode` values on purpose, and not for tidiness. `mode` is the
    // only thing this function compares before touching `src`, so sharing one mode between two
    // different images means the swap from a fetch to the next tool call in the same turn repaints
    // nothing and leaves the fetch face frozen on the ball.
    if (agentState === 'tooling') {
      // Inlined rather than called, and the same three lines appear in the other conversation's branch below.
      // `syncGif` is the one function the page tests compile out of this file, so every helper it calls is one
      // more name those bodies have to define — which has now cost three rounds of test wrangling for no
      // behaviour anyone can see. Four duplicated lines are cheaper than a list of things a body must have.
      const named = agentTool !== '' ? namedToolFaces.get(agentTool) : null
      const mode = named !== null && named !== undefined ? `tool-named:${agentTool}` : 'tool'
      const src = named ?? toolSrc
      if (src !== undefined) {
        if (gif.dataset.mode !== mode) {
          gif.dataset.mode = mode
          gif.src = src
        }
        // Only a face drawn for this tool by name. The shared face is what a turn with no mapping wears, and
        // holding that would leave a picture of a tool on a ball that is only writing.
        if (named !== null && named !== undefined) notedToolFace(mode)
        return
      }
    }
    // The agent is reasoning about the request.
    if (thinkingSrc !== undefined && agentState === 'thinking') {
      if (gif.dataset.mode !== 'thinking') {
        gif.dataset.mode = 'thinking'
        gif.src = thinkingSrc
      }
      return
    }
    // Everything below is *another* conversation's work, so it comes after everything above, which is this
    // page's own turn. The three kinds are ranked the way this page ranks its own: words first, because that
    // is the answer somebody is waiting for, then a call, then reasoning. Each has its own mode, so stepping
    // from one kind to the next starts the clip again instead of leaving it where the last one stopped.
    //
    // Words being written in a conversation this ball is not in — the DSH window the user is actually looking
    // at. The same face as the ball's own answer, because it is the same event one window over.
    if (replySrc !== undefined && Date.now() - (streamAt.get('typing') ?? 0) < holdStream) {
      if (gif.dataset.mode !== 'reply-elsewhere') {
        gif.dataset.mode = 'reply-elsewhere'
        gif.src = replySrc
      }
      return
    }
    // A call running over there. `otherTool` is the name the host sent with the window, and it is what makes a
    // pack's per-tool faces reachable from the conversation the user is actually typing in — the ball's own
    // transcript is elsewhere, so this page has no tool card to read the name from. `agentTool` is deliberately
    // not consulted: that is this page's own call, which the branch above already answered for.
    if (Date.now() - (streamAt.get('tool') ?? 0) < holdWork) {
      const named = namedOtherTool !== '' ? namedToolFaces.get(namedOtherTool) : null
      const suffix = named !== null && named !== undefined ? `tool-named-elsewhere:${namedOtherTool}` : 'tool-elsewhere'
      const src = named ?? toolSrc
      if (src !== undefined) {
        if (gif.dataset.mode !== suffix) {
          gif.dataset.mode = suffix
          gif.src = src
        }
        if (named !== null && named !== undefined) notedToolFace(suffix)
        return
      }
    }
    // Thinking out loud over there. Its window is the longest of the three, because reasoning arrives as
    // nothing in particular between the words rather than as a stream of its own.
    if (thinkingSrc !== undefined && Date.now() - (streamAt.get('thinking') ?? 0) < holdWork) {
      if (gif.dataset.mode !== 'thinking-elsewhere') {
        gif.dataset.mode = 'thinking-elsewhere'
        gif.src = thinkingSrc
      }
      return
    }
    // The ball is reading an answer aloud. This sits with the agent's own frames rather than with
    // dictation below it, because it is the ball doing the talking: when the two overlap, the
    // thing the user can actually hear is the one the face should be showing.
    if (speakSrc !== undefined && speakActive) {
      if (gif.dataset.mode !== 'speak') {
        gif.dataset.mode = 'speak'
        gif.src = speakSrc
      }
      return
    }
    // Dictation outranks the pointer: the microphone is open and the ball is taking the user's
    // voice, which is a bigger fact about what it is doing than where the mouse happens to rest.
    // It sits deliberately below the agent's own frames, so a turn still streaming from the last
    // message keeps its face while the user dictates the next one.
    if (voiceSrc !== undefined && (dictationPhase === 'recording' || dictationPhase === 'transcribing')) {
      if (gif.dataset.mode !== 'voice') {
        gif.dataset.mode = 'voice'
        gif.src = voiceSrc
      }
      return
    }
    // The pointer is on the ball: the intro plays once, then the peek loop holds.
    if (hoverSrc !== undefined && hovering) {
      const intro = hoverIntroSrc !== undefined && Date.now() < introUntil
      const mode = intro ? 'hover-intro' : 'hover'
      if (gif.dataset.mode !== mode) {
        gif.dataset.mode = mode
        gif.src = intro ? hoverIntroSrc : hoverSrc
      }
      return
    }
    // The tool that just finished can still be in hand when nothing has taken its place yet. Everything the
    // pack asked for has had its chance by now — this sits below every branch that means something — so the
    // hold can only ever delay the resting faces at the bottom.
    if (holdTheToolFace()) return
    // An open panel wears the avatar face — but a configured meme loop outranks it. The ball is
    // not doing anything in particular just because the panel happens to be showing, and a pack
    // that names an `idle` has already said what the ball looks like when it is not doing
    // anything. Without a loop to fall back on the avatar still applies, so a profile with no
    // memes behaves exactly as before. The poor face counts as a resting loop here for the obvious
    // reason: it is the same state under a condition, and a pack that names only that one has still
    // said what the ball looks like at rest.
    //
    // `running` is in this condition and nowhere else. A turn in flight briefly wore the reasoning face
    // instead, on the theory that a turn in progress is work in progress — and it made a *resting* ball wear a
    // tool face, which is what a missing reasoning frame plus a tool-shaped fallback adds up to. The frozen
    // avatar is vague, but it is never wrong about which action is happening, and a model between two chunks is
    // not doing any action in particular.
    const play = running || asking() || tccGateVisible || attachedSelection !== ''
      || (expanded && idleSrc === undefined && !brokeNow())
    if (play) {
      if (gif.dataset.mode !== 'play') {
        gif.dataset.mode = 'play'
        gif.src = avatarSrc
      }
      return
    }
    // Nobody has touched the ball for a while: it yawns, then naps, then dozes off until it
    // is used again. The mode carries the step, so each frame of the timeline actually
    // reaches the image.
    const nap = sleepFrameAt()
    if (nap !== undefined) {
      if (gif.dataset.mode !== nap.mode) {
        gif.dataset.mode = nap.mode
        gif.src = nap.src
      }
      return
    }
    // A scripted little skit plays now and then while the ball rests. The mode carries the
    // step, so every frame of the skit actually reaches the image.
    if (skitFrame !== undefined) {
      const mode = `skit-${skitFrame.step}`
      if (gif.dataset.mode !== mode) {
        gif.dataset.mode = mode
        gif.src = skitFrame.src
      }
      return
    }
    // While the ball rests, a configured loop keeps it moving instead of a frozen frame. A pack that
    // names a `poor` frame says the resting loop is not one face but two: the ordinary one, and the
    // one for an account that is nearly out of money. Which of them is worn is a decision rather than
    // a state, so it is made here, on every repaint — a balance that falls below the line changes the
    // face the ball is already wearing, and topping up changes it back.
    //
    // Docked, neither of them: the ball belongs to the strip and wears what the strip puts on it. So
    // docked returns *before* the idle branch and, just as importantly, before the `still` branch
    // below — that one is the frozen avatar for a ball with no loop to wear, and reaching it froze the
    // ball onto a canvas and painted that back over the clip, which read as a flicker at the end of
    // every hover. Leaving the element alone is the whole of the docked contract: whatever the strip
    // last put on it stays, and the arrival above replaces it when the dwell fires.
    if (docked !== undefined) return
    const broke = brokeNow()
    if (broke || idleSrc !== undefined) {
      const mode = broke ? 'poor' : 'idle'
      if (gif.dataset.mode !== mode) {
        gif.dataset.mode = mode
        gif.src = broke ? poorSrc : idleSrc
      }
      return
    }
    if (gif.dataset.mode === 'still') return
    gif.dataset.mode = 'still'
    gif.src = avatarSrc
    freezeGif(gif)
  }

  /**
   * Whether the ball should be wearing the poor face instead of its ordinary resting loop.
   *
   * Three things have to hold, and the third is the one worth stating: the balance has to be *known*.
   * The host pushes `null` when nobody is signed in, when the Platform cannot be reached or when the
   * build carries no client version, and a failed lookup is not a zero — reading it as one would put
   * the sad face on every machine that never signed in, which is the opposite of the joke.
   */
  function brokeNow() {
    if (poorSrc === undefined || balanceCny === null) return false
    return balanceCny < poorBelow
  }

  /**
   * The ball is at rest: neither the user nor the agent is doing anything with it. Only
   * while this holds does the nap clock run, and any activity starts it over.
   *
   * Another conversation counts. `agentState` is only ever about *this* panel's transcript, so while the user
   * works in the DSH window the ball reads as idle here — and the skit and the nap clock, which are gated on this,
   * would go off in the middle of somebody else's answer and paint over the very face that says work is happening.
   * Reported as the skit covering the work animations, which is exactly what it was.
   *
   * The windows are read without going through `syncGif`'s local copies: this is module scope, and the values are
   * the module-level constants. Nothing here clears a window — that is the repaint's business, not a predicate's.
   */
  function restingNow() {
    const elsewhere = otherStreamAt
    const busyElsewhere = Date.now() - (elsewhere.get('typing') ?? 0) < OTHER_STREAM_HOLD_MS
      || Date.now() - (elsewhere.get('tool') ?? 0) < OTHER_WORK_HOLD_MS
      || Date.now() - (elsewhere.get('thinking') ?? 0) < OTHER_WORK_HOLD_MS
    // And the floor under a per-tool face: while one is still up, the ball is not resting either.
    const holdingFace = toolFaceHoldState.mode !== '' && Date.now() < toolFaceHoldState.until
    return !pageClosed() && !hovering && !expanded && !running && !asking()
      && !tccGateVisible && attachedSelection === '' && agentState === ''
      && !busyElsewhere && !holdingFace
      && !document.body.classList.contains('docked')
  }

  /** One pass of the yawn plus how many passes the pre-roll runs for, or `null` while it is off. */
  function yawnPlan() {
    return sleepInfo?.yawn ?? null
  }

  /** How long the whole yawn pre-roll lasts, or 0 while there is none. */
  function yawnTotalMs() {
    const plan = yawnPlan()
    return plan === null ? 0 : plan.ms * plan.times
  }

  /**
   * What the nap is doing at `elapsed`: `undefined` while the ball is still awake, a `yawn`
   * repetition during the pre-roll, then the `sleep` frame that is due.
   *
   * The pre-roll counts as nap time, so the timeline behind it is simply shifted by its own
   * length. Only the yawn knows how long it runs, which is why the shift cannot be folded
   * into `afterMs` in the helper.
   */
  function napPhaseAt(elapsed) {
    if (sleepInfo === undefined || sleepInfo === null || elapsed < sleepInfo.afterMs) return undefined
    const since = elapsed - sleepInfo.afterMs
    const plan = yawnPlan()
    const total = yawnTotalMs()
    if (plan !== null && since < total) {
      // Each repetition lasts exactly one pass of the file, so the last yawn still finishes.
      return { kind: 'yawn', index: Math.min(Math.floor(since / plan.ms), plan.times - 1) }
    }
    const step = Math.floor((since - total) / sleepInfo.stepMs)
    return { kind: 'sleep', index: Math.min(step, sleepInfo.count - 1) }
  }

  /**
   * Time until the next nap boundary, or `null` once the last frame holds until the ball is used.
   * A boundary is a yawn repetition, the handoff after the last yawn, or a nap step.
   */
  function napDelay(elapsed, phase) {
    if (sleepInfo === undefined || sleepInfo === null) return null
    if (phase === undefined) {
      // Wake twice on the way in: once to start reading the yawn, once when the nap begins.
      const prefetchAt = sleepInfo.afterMs - YAWN_PREFETCH_MS
      const waiting = yawnPlan() !== null && yawnSrc === undefined && elapsed < prefetchAt
      return Math.max(100, (waiting ? prefetchAt : sleepInfo.afterMs) - elapsed)
    }
    const plan = yawnPlan()
    const since = elapsed - sleepInfo.afterMs
    if (phase.kind === 'yawn') {
      // `napPhaseAt` only reports a yawn while the plan exists, so `plan` is set here.
      const total = yawnTotalMs()
      const boundary = phase.index < plan.times - 1 ? (phase.index + 1) * plan.ms : total
      return Math.max(100, boundary - since)
    }
    if (phase.index >= sleepInfo.count - 1) return null
    return Math.max(100, yawnTotalMs() + (phase.index + 1) * sleepInfo.stepMs - since)
  }

  /** Arm the next nap step, or wake the ball when it is in use. */
  function syncSleep() {
    clearTimeout(sleepTimer)
    sleepTimer = undefined
    if (sleepInfo === undefined || sleepInfo === null || !restingNow()) {
      restStartAt = 0
      napShown = undefined
      return
    }
    if (restStartAt === 0) restStartAt = Date.now()
    const elapsed = Date.now() - restStartAt
    // The yawn is by far the largest frame, so its read starts before the nap does.
    if (yawnPlan() !== null && elapsed >= sleepInfo.afterMs - YAWN_PREFETCH_MS) void loadYawn()
    napShown = napPhaseAt(elapsed)
    const delay = napDelay(elapsed, napShown)
    if (delay !== null) sleepTimer = setTimeout(() => { void sleepTick() }, delay)
  }

  async function sleepTick() {
    syncSleep()
    if (napShown !== undefined && napShown.kind === 'sleep') await loadSleepFrame(napShown.index)
    syncGif()
  }

  async function loadSleepFrame(index) {
    if (index < 0 || sleepFrames[index] !== undefined || sleepLoading.has(index)) return
    if (typeof api.memeSleepFrame !== 'function') return
    sleepLoading.add(index)
    try {
      const src = await api.memeSleepFrame(index)
      if (typeof src === 'string' && src !== '') sleepFrames[index] = src
    } catch {
      // A missing file simply leaves the resting loop in place.
    } finally {
      sleepLoading.delete(index)
    }
  }

  /** Read the yawn once. A failure is remembered as `null` so it is not retried every frame. */
  async function loadYawn() {
    if (yawnSrc !== undefined || yawnLoading) return
    if (typeof api.memeYawn !== 'function') return
    yawnLoading = true
    try {
      const src = await api.memeYawn()
      yawnSrc = typeof src === 'string' && src !== '' ? src : null
    } catch {
      yawnSrc = null
    } finally {
      yawnLoading = false
    }
  }

  /**
   * The nap frame to show and the mode that carries its step, or `undefined` while the ball
   * is awake. While the next step is still being read, the previous one stays on screen.
   */
  function sleepFrameAt() {
    const phase = napShown
    if (phase === undefined) return undefined
    // The yawn is one file played over and over: the mode carries the repetition, which is
    // what makes the image element reload it and start again from the first frame.
    if (phase.kind === 'yawn') {
      if (yawnSrc === undefined) void loadYawn()
      if (yawnSrc === undefined || yawnSrc === null) return undefined
      // Frame 0 is fetched alongside it so the handoff out of the yawn has something to show.
      void loadSleepFrame(0)
      return { mode: `yawn-${phase.index}`, src: yawnSrc }
    }
    let index = phase.index
    if (sleepFrames[index] === undefined) {
      void loadSleepFrame(index)
      index -= 1
      if (index < 0) return undefined
    } else {
      void loadSleepFrame(index + 1)
    }
    const src = sleepFrames[index]
    return src === undefined ? undefined : { mode: `sleep-${index}`, src }
  }

  /**
   * What the agent is doing right now: streaming an answer, reasoning about the request,
   * or neither. A running block decides it; a streaming answer outranks reasoning.
   *
   * The running tool's name comes back alongside the phase rather than being folded into it,
   * because the phase alone cannot tell a fetch from any other call: two tools in a row are both
   * `tooling`, and a face that only watches the phase would never notice the swap.
   */
  function agentPhase() {
    let thinking = false
    let tooling = false
    let tool = ''
    // A block marked running is believed only while the transcript is still moving. The host settles a tool call
    // by matching its result on an id, and settles every open block when a turn ends — and when neither happens
    // the flag stays up forever, which is what leaves the ball frozen on a tool face with no way back. A model
    // that is actually working is never silent for `STALE_BLOCK_MS`: tokens arrive either side of a call, and the
    // call's own status changes while it runs. So silence is the signal that the flag is abandoned rather than
    // true, and the ball goes back to resting on its own.
    const stale = Date.now() - transcriptAt > STALE_BLOCK_MS
    for (const block of blockData.values()) {
      if (block.running !== true) continue
      if (stale) continue
      if (block.kind === 'assistant') return { state: 'replying', tool: '' }
      if (block.kind === 'tool') {
        tooling = true
        // `blockData` iterates in the order the calls arrived, so letting the name be overwritten
        // leaves the most recently started call still running — the one the agent is waiting on.
        tool = block.text
      }
      if (block.kind === 'reasoning') thinking = true
    }
    if (tooling) return { state: 'tooling', tool }
    return { state: thinking ? 'thinking' : '', tool: '' }
  }

  /** Repaint only when the phase or the running tool flips, not on every token. */
  function syncAgent() {
    // The page tests compile this function on its own, so a helper it calls has to be either inlined or
    // defaulted here — and this one cannot be inlined, because its whole job is to ask the helper process for a
    // file and cache the answer. A no-op default keeps a compiled body running and changes nothing in the page.
    const readNamedTool = typeof loadNamedToolFrame === 'function' ? loadNamedToolFrame : () => {}
    const next = agentPhase()
    if (next.state === agentState && next.tool === agentTool) return
    const wasTooling = agentState === 'tooling'
    agentState = next.state
    // The name before the face that depends on it: the tool branches read `agentTool`, so loading first would
    // ask for the previous call's file and leave the new one waiting for the next repaint.
    agentTool = next.tool
    if (next.state === 'tooling') {
      // A call that names a tool the pack draws apart has to ask for that file, and the first call of a session
      // routinely starts before the frame sweep has made its round. Asking for a name the pack has already
      // answered for is a no-op inside — the cache holds both a picture and a "nothing special" — so this costs
      // nothing on the second call of a turn.
      void readNamedTool(next.tool)
    }
    syncGif()
  }

  /**
   * The composer fired an input event. Show the typing frame now and drop back to the
   * resting state when the last keystroke is {@link TYPING_HOLD_MS} old.
   */
  function noteTyping() {
    typingAt = Date.now()
    clearTimeout(typingTimer)
    typingTimer = setTimeout(() => { syncGif() }, TYPING_HOLD_MS + 50)
    syncGif()
  }

  /** The ball collapsed: the typing frame stops at once instead of waiting out its hold. */
  function clearTyping() {
    typingAt = 0
    clearTimeout(typingTimer)
    typingTimer = undefined
  }

  /** The pointer arrived: play the peek intro once, then the loop takes over. */
  function startHoverIntro() {
    if (hoverIntroSrc === undefined) return
    // A wave is short next to a hover that can last seconds, and the hand-off is what the user
    // sees, so the 30 ms of slack that keeps the decoder from painting the switch is worth
    // keeping — but only while the file stops on its own. One that loops has to be handed over
    // before its restart instead, which costs it the tail of the wave.
    const hold = hoverIntroLoops
      ? transitionHoldMs(hoverIntroMs, true)
      : hoverIntroMs + 30
    introUntil = Date.now() + hold
    clearTimeout(introTimer)
    introTimer = setTimeout(() => { syncGif() }, hold)
  }

  function stopHoverIntro() {
    introUntil = 0
    clearTimeout(introTimer)
    introTimer = undefined
  }

  /**
   * The ball was picked up: play the lift once, then the hang loop takes over for the rest
   * of the carry. Deliberately not tied to the drop — a carry that ends early just cuts the
   * pickup short, which is what actually happened.
   *
   * This is a transition, not a cue: the lift ends by handing the ball to the hang loop, so it
   * is given its own length and no more. The shipped pickup plays once and stops on its last
   * frame, which is the lifted pose the hang loop opens on, so the two meet without a jump.
   * Were the file to loop instead, the hand-off would land on the frame it restarts from and
   * one frame of the lift's opening pose would show before the hang loop took over — the
   * pickup appeared to stutter. {@link transitionHoldMs} cuts such a file short to avoid it.
   */
  function startDragIntro() {
    if (dragIntroSrc === undefined) return
    dragIntroHold = transitionHoldMs(dragIntroMs, dragIntroLoops)
    dragIntroUntil = Date.now() + dragIntroHold
    clearTimeout(dragIntroTimer)
    dragIntroTimer = setTimeout(() => { syncGif() }, dragIntroHold)
  }

  function stopDragIntro() {
    dragIntroUntil = 0
    clearTimeout(dragIntroTimer)
    dragIntroTimer = undefined
  }

  /**
   * A burst only runs while the ball rests: every state that already animates the
   * avatar (expanded, running, asking, a TCC gate, an attached selection) wins, and a
   * docked ball is hidden anyway.
   */
  function memeIdle() {
    return !expanded && !running && !asking() && !tccGateVisible && attachedSelection === ''
      && !document.body.classList.contains('docked') && !pageClosed()
  }

  function pickIn(range) {
    const low = Number(range[0])
    const high = Number(range[1])
    if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) return MEME_POLL_MS
    return Math.round(low + Math.random() * (high - low))
  }

  /** One of `list`, chosen at random. Callers guarantee a non-empty list. */
  function pickOne(list) {
    return list[Math.floor(Math.random() * list.length)]
  }

  function wait(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms) })
  }

  /** Play a handful of random images, then hand the ball back to its avatar. */
  async function playMemeBurst() {
    if (memePlaying || memeInfo === undefined || memeInfo.enabled !== true) return
    memePlaying = true
    const gif = document.querySelector('#ball-gif')
    try {
      const frames = pickIn(memeInfo.frames)
      for (let index = 0; index < frames; index += 1) {
        if (!memeIdle()) break
        const src = await api.memeFrame()
        if (typeof src !== 'string' || src === '' || !memeIdle()) break
        gif.dataset.mode = 'meme'
        gif.src = src
        await wait(pickIn(memeInfo.holdMs))
      }
    } catch {
      // A missing folder or a broken image simply ends this burst.
    } finally {
      memePlaying = false
      if (gif.dataset.mode === 'meme') {
        delete gif.dataset.mode
        syncGif()
      }
    }
  }

  /**
   * The frame a plan item carries as its identity — a single clip itself, a run its first clip.
   *
   * A run is remembered by where it starts, because that is what the ball shows while it plays: the
   * rotation in {@link rotateSkit} is about not beginning the same gag twice in a row.
   */
  function skitLead(item) {
    return item.kind === 'sequence' ? item.frames[0] : item.frame
  }

  /**
   * The item this skit plays: one of the plan's pool, drawn here rather than by the helper.
   *
   * The helper hands the plan over once, when the page loads, and this runs every few minutes for as
   * long as the ball is on screen — so the page is the only half that knows what it played last, and
   * that is exactly the item left out of the draw. A pool of one is all repeats by definition, so it
   * is handed over as it is.
   */
  function rotateSkit(pool) {
    const candidates = pool.length > 1 ? pool.filter((item) => skitLead(item).src !== skitLastSrc) : pool
    const item = candidates.length > 0 ? pickOne(candidates) : pool[0]
    skitLastSrc = skitLead(item).src
    return item
  }

  /**
   * One skit's frames, in order: a run played once through, or a repeated clip with an interjection.
   *
   * Which of the two is the item's own kind. A *run* is a scripted sequence — the pack drew a gag with
   * a setup and a punchline — so it plays each of its clips once, in the order the config wrote them,
   * and stops there: no repeats and no interjection, because the last clip is what ends it. A *single*
   * clip is the loop this slot has always been, repeated a few times with the interjection dropped in
   * the middle; only the number of repeats is random there.
   */
  function skitSequence(info) {
    const pool = Array.isArray(info.files) && info.files.length > 0 ? info.files : [info.item]
    // A plan the page cannot read is a plan that plays nothing, rather than one that throws on the
    // resting loop's timer — the same reading every other cue in this file takes of a missing file.
    const known = pool.filter((item) => item !== null && typeof item === 'object'
      && (item.kind === 'sequence' ? Array.isArray(item.frames) && item.frames.length > 0 : item.frame !== undefined))
    if (known.length === 0) return []
    const item = rotateSkit(known)
    if (item.kind === 'sequence') return [...item.frames]
    const file = item.frame
    const count = pickIn(info.times)
    const frames = []
    const middle = Math.floor(count / 2)
    for (let index = 0; index < count; index += 1) {
      // An interjection that is the clip being interrupted is not an interruption: the sequence
      // drops it, which is how every other cue in this file keeps one clip from being handed to the
      // ball twice in a row.
      if (index === middle && info.interject !== null && info.interject.src !== file.src) {
        frames.push(info.interject)
      }
      frames.push(file)
    }
    return frames
  }

  /** Play one skit while the ball rests, then hand it back to the resting loop. */
  async function playSkit() {
    if (skitPlaying || skitInfo === undefined || skitInfo === null) return
    if (!restingNow() || napShown !== undefined) return
    skitPlaying = true
    try {
      let step = 0
      for (const frame of skitSequence(skitInfo)) {
        if (!skitPlaying || !restingNow() || napShown !== undefined) break
        skitFrame = { src: frame.src, step }
        step += 1
        syncGif()
        await wait(frame.ms)
      }
    } finally {
      skitPlaying = false
      skitFrame = undefined
      syncGif()
    }
  }

  /** Arm the next skit. A skit that lands while the ball is in use is skipped, not queued. */
  function scheduleSkit() {
    clearTimeout(skitTimer)
    skitTimer = undefined
    if (skitInfo === undefined || skitInfo === null) return
    skitTimer = setTimeout(() => { void playSkit().then(scheduleSkit) }, pickIn(skitInfo.gapMs))
  }

  function scheduleMemeBurst() {
    clearTimeout(memeTimer)
    const on = memeInfo !== undefined && memeInfo.enabled === true
    memeTimer = setTimeout(() => {
      void refreshFrames().then(refreshMemes).then(() => {
        if (memeInfo !== undefined && memeInfo.enabled === true) return playMemeBurst()
        return undefined
      }).then(scheduleMemeBurst)
    }, on ? pickIn(memeInfo.gapMs) : MEME_POLL_MS)
  }

  /**
   * Fetch the named frames the helper hands over, once each. Until they arrive the ball
   * keeps its frozen avatar, so a config that names none of them costs nothing.
   */
  async function refreshFrames() {
    // The resting face, warmed before anything else. This is the `<img>`'s own `src` in the markup —
    // `deepseek-avatar-square.gif`, 7.7MB — so the browser is already fetching and decoding it from the
    // moment the page loads, whether or not a single slot is configured. It is also the face the ball
    // is wearing whenever nothing else applies, which is exactly the state a docked hover starts from.
    //
    // Warming it here is what keeps a hover from showing a broken-image placeholder: the hover swaps
    // `src` to one of the small clips, and if that giant is still mid-decode the browser is running two
    // decodes at once and paints its "not ready" box — the little icon with a white edge — instead of
    // either picture. Asking for it up front means it is finished long before a pointer can arrive.
    warmFrame(avatarSrc)
    if (idleSrc === undefined) {
      const src = await fetchFrame(() => api.memeIdle())
      if (src !== undefined) {
        idleSrc = src
        syncGif()
      }
    }
    if (poorSrc === undefined) await loadPoorFrame()
    if (typingSrc === undefined) {
      const src = await fetchFrame(() => api.memeTyping())
      if (src !== undefined) typingSrc = src
    }
    if (replySrc === undefined) {
      const src = await fetchFrame(() => api.memeReply())
      if (src !== undefined) {
        replySrc = src
        syncGif()
      }
    }
    if (thinkingSrc === undefined) {
      const src = await fetchFrame(() => api.memeThinking())
      if (src !== undefined) {
        thinkingSrc = src
        syncGif()
      }
    }
    if (toolSrc === undefined) {
      const src = await fetchFrame(() => api.memeTool())
      if (src !== undefined) {
        toolSrc = src
        syncGif()
      }
    }
    if (sleepInfo === undefined || sleepInfo === null) {
      const plan = await fetchSleep()
      if (plan !== null) {
        sleepInfo = plan
        void loadSleepFrame(0)
        syncGif()
      }
    }
    if (skitInfo === undefined || skitInfo === null) {
      const plan = await fetchSkit()
      if (plan !== null) {
        skitInfo = plan
        scheduleSkit()
        syncGif()
      }
    }
    if (clickFrame === undefined || clickFrame === null) {
      const frame = await fetchClick()
      if (frame !== null) clickFrame = frame
    }
    if (nodFrame === undefined || nodFrame === null) {
      const frame = await fetchNod()
      if (frame !== null) nodFrame = frame
    }
    if (doneFrame === undefined || doneFrame === null) {
      const frame = await fetchDone()
      if (frame !== null) doneFrame = frame
    }
    // Read in the sweep with the other turn-end faces. The on-demand read in `playFailFrame` is the
    // safety net for a failure that beats the sweep; this is what makes the common case instant.
    if (failFrame === undefined || failFrame === null) {
      const frame = await fetchFail()
      if (frame !== null) failFrame = frame
    }
    if (wakeFrame === undefined || wakeFrame === null) {
      const frame = await fetchWake()
      if (frame !== null) wakeFrame = frame
    }
    if (askFrame === undefined || askFrame === null) {
      const frame = await fetchAsk()
      if (frame !== null) askFrame = frame
    }
    if (dropFrame === undefined || dropFrame === null) {
      const frame = await fetchDrop()
      if (frame !== null) dropFrame = frame
    }
    // Read in the sweep like the other named faces. This is the one that matters most: the clip is
    // only ever played by a hover, and a hover can arrive seconds after the page does. Marked read
    // whether or not a file resolved, so an empty slot is asked about once rather than every turn.
    if (!dockArriveRead) {
      dockArriveRead = true
      const frame = await fetchDockArrive()
      dockArriveFrame = frame === null ? null : frame
      // Warmed the moment the edges are in hand, so the hover that arrives later is not the first thing
      // to ask the decoder for these frames. This is the difference between a box on the ball and a fish,
      // and it costs nothing until a hover asks for it. Both edges, because the clip the *other* edge
      // would play is the one the next drag out and back in will ask for.
      warmDockArriveFrame(dockArriveFrame?.left)
      warmDockArriveFrame(dockArriveFrame?.right)
    }
    if (voiceSrc === undefined) await loadVoiceFrame()
    if (speakSrc === undefined) await loadSpeakFrame()
    if (dragSrc === undefined) {
      const frames = await fetchDrag()
      if (frames !== null) {
        dragSrc = frames.src
        if (frames.intro !== null) {
          dragIntroSrc = frames.intro.src
          dragIntroMs = frames.intro.ms
          dragIntroLoops = frames.intro.loops
        }
      }
    }
    if (hoverSrc === undefined) {
      const frames = await fetchHover()
      if (frames !== null) {
        hoverSrc = frames.src
        if (frames.intro !== null) {
          hoverIntroSrc = frames.intro.src
          hoverIntroMs = frames.intro.ms
          hoverIntroLoops = frames.intro.loops
        }
        if (hovering) startHoverIntro()
        syncGif()
      }
    }
  }

  /** The nap plan: `{ afterMs, stepMs, count }`, or `null` while it is off or unreadable. */
  /**
   * The yawn the helper scheduled, or `null` while it resolved none.
   *
   * `fetchSleep` rebuilds the plan field by field rather than passing it through, so every
   * field the helper adds has to be named here as well. Dropping one is silent: the nap just
   * runs without it.
   */
  function readYawnPlan(value) {
    if (value === null || typeof value !== 'object') return null
    if (!Number.isFinite(value.ms) || value.ms <= 0) return null
    if (!Number.isInteger(value.times) || value.times <= 0) return null
    return { ms: value.ms, times: value.times }
  }

  async function fetchSleep() {
    if (typeof api.memeSleep !== 'function') return null
    let plan
    try {
      plan = await api.memeSleep()
    } catch {
      return null
    }
    if (plan === null || typeof plan !== 'object') return null
    if (!Number.isFinite(plan.afterMs) || !Number.isFinite(plan.stepMs)) return null
    if (!Number.isInteger(plan.count) || plan.count <= 0) return null
    return {
      afterMs: plan.afterMs,
      stepMs: plan.stepMs,
      count: plan.count,
      yawn: readYawnPlan(plan.yawn),
    }
  }

  /** The click reaction frame, or `null` while it is off or unreadable. */
  async function fetchClick() {
    if (typeof api.memeClick !== 'function') return null
    let frame
    try {
      frame = await api.memeClick()
    } catch {
      return null
    }
    return timedFrameOf(frame)
  }

  /**
   * The carry state: the hang loop plus the optional one-pass pickup, or `null` while it
   * is off or unreadable. Reads the same shape the helper's `drag()` answers with, which
   * is why this is `fetchHover` with a different endpoint.
   */
  async function fetchDrag() {
    if (typeof api.memeDrag !== 'function') return null
    let frames
    try {
      frames = await api.memeDrag()
    } catch {
      return null
    }
    if (frames === null || typeof frames !== 'object') return null
    if (typeof frames.src !== 'string' || frames.src === '') return null
    const intro = frames.intro
    const usable = typeof intro === 'object' && intro !== null
      && typeof intro.src === 'string' && intro.src !== ''
      && typeof intro.ms === 'number' && Number.isFinite(intro.ms) && intro.ms > 0
    return {
      src: frames.src,
      intro: usable ? { src: intro.src, ms: intro.ms, loops: loopsForever(intro.src) } : null,
    }
  }

  /** The release frame, or `null` while it is off or unreadable. */
  async function fetchDrop() {
    if (typeof api.memeDrop !== 'function') return null
    let frame
    try {
      frame = await api.memeDrop()
    } catch {
      return null
    }
    return timedFrameOf(frame)
  }

  /**
   * Play the release frame once, the moment the pointer lets go of a carried ball.
   *
   * The frame is normally already in hand: `refreshFrames()` asks for it at startup. But the
   * first drag after a restart can beat the burst cycle to it, and the drop is the one reaction
   * the user is guaranteed to be looking at — they just let go — so a frame that is not cached
   * yet is fetched here on demand rather than skipped. That is the same choice `playWakeFrame`
   * makes, for the same reason.
   *
   * It carries a step like every other one-shot: a new mode is what makes the image element
   * reload the GIF from its first frame instead of holding the last one it stopped on. Without
   * it, a second drag in the same session would replay nothing at all.
   */
  function playDropFrame() {
    if (dropFrame === undefined || dropFrame === null) {
      void fetchDrop().then((frame) => {
        if (frame === null) return
        dropFrame = frame
        playDropFrame()
      })
      return
    }
    dropStep += 1
    dropShown = { src: dropFrame.src, step: dropStep }
    clearTimeout(dropTimer)
    dropTimer = setTimeout(() => {
      dropShown = undefined
      syncGif()
    }, oneShotHoldMs(dropFrame.ms, dropFrame.loops))
    syncGif()
  }

  /**
   * Play the click reaction once. Every click restarts it, which is why the frame carries a
   * step: a new mode is what makes the image element reload the GIF from its first frame.
   */
  function playClickFrame() {
    if (clickFrame === undefined || clickFrame === null) return
    clickStep += 1
    clickShown = { src: clickFrame.src, step: clickStep }
    const hold = clickHoldMs(clickFrame)
    clearTimeout(clickTimer)
    clickTimer = setTimeout(() => {
      clickShown = undefined
      syncGif()
    }, hold)
    syncGif()
  }

  /** The arrival frames, in the order the pack names them, or `null` while it is off. */
  async function fetchArrive() {
    if (typeof api.memeArrive !== 'function') return null
    let frames
    try {
      frames = await api.memeArrive()
    } catch {
      return null
    }
    if (!Array.isArray(frames)) return null
    const usable = frames.map((frame) => timedFrameOf(frame)).filter((frame) => frame !== null)
    return usable.length === 0 ? null : usable
  }

  /**
   * Hide the ball's picture while it has no picture, and show it the moment it has one.
   *
   * An `<img>` waiting on a source paints a box of its own: a small broken-image glyph in the top-left
   * corner, inside a white-edged rectangle. Docked, the clip's square corners let that box read for
   * exactly what it is — the user saw a flash of an empty frame, with an icon in it, on every hover.
   *
   * Decoding ahead of time does not prevent it, and it is worth being clear about why, because it was
   * tried first and did not work: a swap starts a fresh decode every time, and the box is what an
   * `<img>` paints *during* one. A warmed cache shortens that window; it cannot close it.
   *
   * So the element is hidden for exactly the interval in which it has a source it cannot yet draw, and
   * the only way to know that interval is to watch the assignment that starts it. `src` is therefore
   * shadowed on this one element: the setter marks the picture as not drawn *before* handing the value
   * on, and the element's own `load` — the only party that knows a decode has finished — marks it drawn
   * again. The getter is untouched, so every reader in the page (`syncGif`'s comparisons, the tests'
   * `shown()`) sees the same string it always did.
   *
   * Nothing here waits on anything and nothing here is awaited: a caller of `syncGif` gets its `src`
   * assignment done synchronously as before, which is what keeps the swap free of races. Only the
   * drawing of the element is gated, and an element that is merely invisible still has its box, so
   * `pointerOnUi`'s `getBoundingClientRect()` — and the strip's hover with it — is unaffected.
   *
   * Two ways to change the picture, and both have to go through the gate. Assigning `src` is the one
   * every face in `syncGif` uses; *removing* the attribute is the one the docked peek uses to strip the
   * idle loop off a ball coming out of the dock, and it is not a `src` assignment at all — so shadowing
   * the property alone left it ungated. Measured in Chromium, that is the flash: `removeAttribute('src')`
   * leaves `complete` true and `naturalWidth` 0, and it fires **no** event. Nothing puts `ball-drawn` back
   * to false, the rule below never hides the element, and the engine paints the broken-image box — the
   * white rectangle with the little picture glyph in its top-left corner — for the whole 120 ms
   * `DOCK_ARRIVE_DWELL_MS` between the peek appearing and the entrance landing. `src` is therefore only
   * one of the two attributes watched, and the pair is the whole of "this element has no picture".
   *
   * A source that fails takes the `error` path and leaves the ball undrawn, which is the honest answer:
   * there is nothing to show, and a box saying so is worse than an absence.
   */
  function armBallPicture() {
    const ball = document.querySelector('#ball-gif')
    if (ball === null || typeof ball.addEventListener !== 'function') return
    const setDrawn = (drawn) => {
      if (drawn) document.body.classList.add('ball-drawn')
      else document.body.classList.remove('ball-drawn')
    }
    setDrawn(ball.complete === true && ball.naturalWidth > 0)
    ball.addEventListener('load', () => setDrawn(true))
    ball.addEventListener('error', () => setDrawn(false))
    // `HTMLImageElement.prototype.src` is where the real accessor lives, so the shadow delegates to it
    // rather than reimplementing the URL resolution — a relative path has to keep resolving against the
    // document, which is not this function's business to know.
    const proto = Object.getPrototypeOf(ball)
    const real = Object.getOwnPropertyDescriptor(proto, 'src')
    if (real === undefined || real.set === undefined) return
    // The other half of the same gate, for the other way the picture is taken away. `removeAttribute`
    // is shadowed on this one element only, and it marks the picture undrawn *before* the attribute
    // goes: the box exists from the moment the source does, and a hide queued behind the removal would
    // be a hide one frame too late. Nothing else about the call changes — it delegates to the real
    // method, so `hasAttribute('src')` still answers false afterwards and every reader sees the
    // element it always did.
    const realRemove = ball.removeAttribute
    ball.removeAttribute = function removeAttribute(name) {
      if (name === 'src') setDrawn(false)
      return realRemove.call(this, name)
    }
    Object.defineProperty(ball, 'src', {
      configurable: true,
      enumerable: true,
      get() {
        return real.get.call(ball)
      },
      set(value) {
        // Before the assignment, not after: the placeholder exists from the moment the source changes,
        // and a hide queued behind it would be a hide one frame too late.
        setDrawn(false)
        real.set.call(ball, value)
      },
    })
  }

  /**
   * Hand a source to a decoder now, so whatever puts it on screen later has nothing to wait for.
   *
   * This does not stop the flash on its own and is not the fix for it — see {@link armBallPicture} for
   * what is. It is kept because it is what makes the hidden window *short*: a frame already decoded
   * answers from cache instead of decoding again, so the ball is undrawn for a repaint rather than for
   * a whole clip.
   *
   * The ball is one `<img>` that changes its whole picture constantly, and a `data:` clip is already
   * downloaded by the time anything asks for it, so what is left is Chromium's decode. Warming decodes
   * into the same cache the real element reads from, off-screen, at the moment the source is *known*
   * rather than at the moment the pointer arrives. There is no way to make the swap itself wait without
   * leaving the ball wearing the previous face and racing every later state against the wait.
   *
   * Off-screen and invisible on purpose. A warmer that flashed on the ball would trade a box for a fish,
   * and one that sat in the layout would make the page measure a second ball. `decode()` is asked for
   * rather than `onload` because it resolves only once the frames are actually paintable. A source that
   * fails to decode is dropped from the set and warmed again next time: a clip that cannot decode now
   * will not decode later either, and one more attempt on a slot the user has not fixed costs nothing.
   */
  function warmFrame(src) {
    if (typeof src !== 'string' || src === '' || warmedFrames.has(src)) return
    warmedFrames.add(src)
    const warm = new Image()
    warm.decoding = 'sync'
    warm.src = src
    void warm.decode().catch(() => {
      warmedFrames.delete(src)
    })
  }

  /** Warm one edge's clips: the entrance, and the loop it hands over to. */
  function warmDockArriveFrame(frame) {
    if (frame === undefined || frame === null) return
    warmFrame(frame.file.src)
    warmFrame(frame.loop)
  }

  /**
   * The docked arrival clips, or `null` while the pack names none, names one that is not on disk, or
   * is an older build with no such channel.
   *
   * Every one of those answers is the same answer, and that is the whole of the fallback: a profile
   * whose `dockArrive` slot is missing or misspelled leaves the strip exactly as it was — no clip,
   * no error, and the drag out of the dock is untouched because it never went through here. The one
   * deliberate exception is a read that fails while the page is up: that is reported once, because
   * a slot that is configured and silently never plays is the one thing here worth a log line.
   *
   * Both edges arrive in one answer and this page keeps the pair, rather than asking again when the
   * ball docks to the other edge: the ball is drawn flush against the edge and looking *into* the
   * screen, so the two edges want mirrored pictures, and the read that has to be free is the one a
   * hover waits on. The left edge falls back to the right's clip when the pack named none for it,
   * which is every profile written before the `left` key existed.
   */
  async function fetchDockArrive() {
    if (typeof api.memeDockArrive !== 'function') return null
    let frames
    try {
      frames = await api.memeDockArrive()
    } catch (error) {
      console.warn('dockArrive: the meme channel failed', error)
      return null
    }
    // The channel answers `{ left, right }` now, each half `{ file, loop }`. Two older shapes are accepted
    // too: a bare `{ file, loop }`, which is the same clip on both edges, and a bare `{ src, ms }`, which
    // the page used to play as the whole of the arrival. Each is the exact behaviour of the build that
    // sent it, so an older helper keeps the strip it always had.
    if (frames === null || typeof frames !== 'object') return null
    const entranceOf = (value) => {
      if (value === null || typeof value !== 'object') return null
      if ('file' in value) {
        const file = timedFrameOf(value.file)
        if (file === null) return null
        const loop = typeof value.loop === 'string' && value.loop !== '' ? value.loop : null
        return { file, loop }
      }
      const file = timedFrameOf(value)
      return file === null ? null : { file, loop: null }
    }
    if ('right' in frames || 'left' in frames) {
      const right = entranceOf(frames.right)
      if (right === null) return null
      const left = frames.left === undefined || frames.left === null ? right : entranceOf(frames.left)
      return { left: left ?? right, right }
    }
    const both = entranceOf(frames)
    return both === null ? null : { left: both, right: both }
  }

  /** The clip for the edge the ball is docked to, falling back to the shared one. */
  function dockArriveFor(side) {
    if (dockArriveFrame === undefined || dockArriveFrame === null) return null
    return side === 'left' ? dockArriveFrame.left : dockArriveFrame.right
  }

  /**
   * The docked arrival: the pointer rested on the strip, so the entrance plays once and the loop
   * the ball rests on after it — if the pack named one — takes over.
   *
   * The frame is normally already in hand — `refreshFrames()` asks for it at startup — and the
   * on-demand read below is for the first hover after a restart, which can beat that sweep. A hover
   * that arrives while the read is in flight joins it rather than starting a second one, because
   * the frame is a whole GIF and two hovers inside one read are one clip.
   *
   * The hand-over is timed by the clip's *own* measured length, which the frame carries as `ms`
   * (`gifDurationMs` in `memes.ts` reads the frame delays out of the bytes). It used to be a constant
   * on this page, measured once against `冒泡 1登场水平翻转.gif` when that file was 30 frames of 40 ms, and
   * the file was then cut down to 22 — the constant stayed at 1280 ms, and the extra 400 ms was enough
   * for the entrance to start its second pass before the loop replaced it. What the eye saw was "it
   * played once and then played the beginning again". Nothing here has to know how long a clip is: the
   * read that hands the frame over measures it, so a clip of any length, re-cut at any time, hands over
   * on its own last frame.
   *
   * It is the clip's *whole* length and not the `oneShotHoldMs` share of it: the lead that rule takes
   * exists to dodge a restart, and there is nothing to dodge — what follows the arrival is the loop the
   * ball rests in rather than a pose held on the end of it. The loop has no hold of its own: it is the
   * resting face, and it stays until the pointer leaves or the dock goes, both of which run through
   * {@link clearDockArrive}.
   */
  function playDockArrive() {
    if (dockArriveFrame === undefined) {
      if (dockArrivePending) return
      dockArrivePending = true
      void fetchDockArrive().then((frames) => {
        dockArrivePending = false
        if (frames === null) return
        dockArriveFrame = frames
        // Same reasoning as the sweep above, on the path a hover beats the sweep to. The read is why
        // the first hover after a restart is the one that flashes, so this is the read that matters
        // most — warming it here is what makes that first hover quiet too. Both edges are warmed: the
        // clip the *other* edge would play is the one the next drag out and back in will ask for.
        warmDockArriveFrame(frames.left)
        warmDockArriveFrame(frames.right)
        playDockArrive()
      })
      return
    }
    // The edge the ball is standing on, which is what picks the picture: the two edges want mirrored
    // clips because the ball looks into the screen from either one.
    const arrival = dockArriveFor(docked)
    // No clip for this edge — the pack names none, or named one that is not on disk. Silent, and the
    // strip still drags the ball out.
    if (arrival === null) return
    const entrance = arrival.file
    stopDockArriveTimer()
    // A new step every hover, so the image element reloads the clip instead of holding the pose the
    // last hover stopped on. Hovering again restarts it from the first frame, which is the point.
    dockArriveStep += 1
    dockArriveShown = { src: entrance.src, step: dockArriveStep }
    dockArriveTimer = setTimeout(() => {
      dockArriveTimer = undefined
      // The entrance is done. With a loop the ball rests on it — the same `dock-arrive-N` face, only
      // now drawing the loop's own frames — and without one it goes back to the docked idle, which is
      // exactly what a hover did before the loop existed.
      dockArriveShown = arrival.loop === null
        ? undefined
        : { src: arrival.loop, step: dockArriveStep }
      syncGif()
    }, entrance.ms)
    syncGif()
  }

  /**
   * Show the ball half way out of the edge it is docked to, as the strip's hint.
   *
   * One step, and the order inside it is the only thing here worth stating: the class goes on
   * *after* the helper has grown the window. The ball is drawn at `--ball-column` inside it, which
   * a 34px tab rect has no room for, so showing it first would paint a slice of ball clipped by the
   * edge of a strip for as long as the round trip takes.
   *
   * The pointer is re-checked after the await, because the round trip is long enough for it to have
   * left the strip or for the user to have started pulling the ball out. Either of those closes the
   * peek; this only has to notice, rather than paint over the top of it.
   */
  async function openDockPeek() {
    // The other half of the retired hover gesture. Checked here as well as in `beginDockArrive` because this is
    // the only function that asks the helper to slide the ball out, and a caller that reaches it another way must
    // not be able to bring the frame back. See {@link DOCK_HOVER_ENABLED}.
    if (!DOCK_HOVER_ENABLED) return
    if (docked === undefined || dockPeeked) return
    // An older helper has no peek to ask for, and the channel is the whole mechanism: without it
    // there is nowhere to show the ball, so the strip behaves exactly as it did before this existed
    // rather than playing a clip on an element that is off the screen.
    if (typeof api.peekDock !== 'function') return
    const side = docked
    // Claimed before the await, so a second hover during the round trip joins this one instead of
    // starting a second peek on the same strip.
    dockPeeked = true
    // Stripped, not repainted, and *before* the round trip rather than after it.
    //
    // The ball is on screen now carrying whatever it wore before the dock — the idle loop — and
    // `#ball-gif` has no background of its own, so taking the source off leaves the half ball blank
    // until the dwell puts the arrival on it. That is the whole of the docked contract between the
    // peek appearing and the entrance starting: nothing to look at, and nothing from the state the
    // ball was in before the strip took it.
    //
    // A repaint here would be worse than useless. Docked, `syncGif` leaves the element alone (see the
    // note above the idle branch), and the only thing below it would do is `freezeGif` — which
    // repaints the element from a canvas and puts that back as its source, so the avatar would flash
    // over the arrival at the end of every hover.
    //
    // Where the line sits is the other half of that contract, and it is not cosmetic. `beginDockArrive`
    // does not await this function: it arms `DOCK_ARRIVE_DWELL_MS` in the same breath, so the dwell and
    // this round trip are a race. Stripped *after* the await, a round trip slower than the dwell lands
    // the arrival on the ball first and this line then takes that arrival off again — and nothing puts
    // it back, because `syncGif`'s `dock-arrive-N` branch finds the mode and the source already equal to
    // what it was about to assign and skips the swap. The ball would be left with no picture for the
    // rest of the hover, which is the empty frame this slot keeps growing back. Stripped *before* it,
    // there is nothing left for the order of the two halves to decide: the element is empty from the
    // first frame of the peek, whatever the helper takes to answer.
    const gif = document.querySelector('#ball-gif')
    if (gif !== null) gif.removeAttribute('src')
    // Re-checked after the await, because the round trip is long enough for the pointer to have left
    // the strip or started pulling the ball out. Either of those closes the peek; this only has to
    // notice, rather than paint over the top of it.
    await api.peekDock()
    if (!dockPeeked || docked !== side) return
    document.body.classList.add('docked-peek')
    // The ball is on screen now, so the rects the window has to capture over have changed — and it
    // is reported *after* the window has grown, or the rect would describe where the ball was.
    syncHitTest()
  }

  /**
   * Put the ball back behind its strip.
   *
   * The reverse order, for the same reason: the ball comes off the screen before the window shrinks
   * under it. `applyDocked` does the page's half by itself when the dock goes, so this is only for
   * a peek that ends with the dock still standing — the pointer leaving the strip.
   */
  async function closeDockPeek() {
    if (!dockPeeked) return
    dockPeeked = false
    document.body.classList.remove('docked-peek')
    syncHitTest()
    if (typeof api.unpeekDock !== 'function') return
    await api.unpeekDock()
  }

  /** Put the arrival away, timer and all. The ball keeps whatever face the rest of `syncGif` says. */
  function clearDockArrive() {
    stopDockArriveTimer()
    if (dockArriveShown === undefined) return
    dockArriveShown = undefined
    syncGif()
  }

  function stopDockArriveTimer() {
    if (dockArriveTimer === undefined) return
    clearTimeout(dockArriveTimer)
    dockArriveTimer = undefined
  }

  /**
   * Resolve once this page is on screen, or at once if it already is.
   *
   * The helper builds its window with `show: false` and shows it on `ready-to-show`, so this page
   * runs for a while with nobody able to see it: it connects, is handed its frames, and paints them
   * behind a hidden window. A greeting started there is spent before the ball appears — measured on
   * this machine, the window came up a little over a second after the page had loaded, by which
   * point the arrival's own animation was already past its halfway mark and the user got the last
   * frames of it and no more. Waiting for visibility is what makes the greeting the thing the user
   * sees first, which is the whole of what this slot promises.
   */
  function whenVisible() {
    if (document.visibilityState === 'visible') return Promise.resolve()
    return new Promise((resolve) => {
      // Not `{ once: true }`: a change that reports the page still hidden would use up the only
      // listener there is, and the greeting would then never play at all.
      const check = () => {
        if (document.visibilityState !== 'visible') return
        document.removeEventListener('visibilitychange', check)
        resolve()
      }
      document.addEventListener('visibilitychange', check)
    })
  }

  /**
   * Wear the greeting once, as this page opens: every clip the pack names, in order, one pass each.
   *
   * Every other cue in this file answers something: a click, a wake word, a turn that ended. This
   * one answers nothing — it is the ball announcing itself, first by turning up and then by saying
   * hello, which is why the slot is a list rather than a file. It is due in the page's first seconds
   * on screen, before the pointer has been anywhere near it. The helper starts this page when the
   * orb is switched on, and shows the ball as soon as that page is ready, so a launch of DSH opens
   * with the greeting exactly like a later enable does.
   *
   * It is read here rather than in the `refreshFrames()` sweep for the same reason: that sweep walks
   * a dozen files one after another, and the greeting would arrive behind the resting loop that the
   * user is not waiting for. It is played at most once per page load — the sweep keeps running for
   * the life of the page, and a greeting that replays every poll is a resting loop wearing a
   * greeting's file — and a pack that names no arrival keeps the silent startup it had before this
   * slot existed. Each clip carries a new step, like the click reaction: a new mode is what makes
   * the image element reload the GIF from its first frame.
   */
  async function wearArriveFrame() {
    if (arrivePlayed) return
    arrivePlayed = true
    // Both at once: the read starts while the page is still hidden, so the frames are already in
    // hand when the window appears, and the greeting starts at that same moment rather than at page
    // load. The wait between two clips is the same hold a one-shot cue gets, so a file that restarts
    // on its own hands over just before it would have, and one that ends on its own last frame is
    // held there for as long as it earned.
    const [frames] = await Promise.all([fetchArrive(), whenVisible()])
    if (frames === null) return
    for (const frame of frames) {
      arriveStep += 1
      arriveShown = { src: frame.src, step: arriveStep }
      syncGif()
      await wait(oneShotHoldMs(frame.ms, frame.loops))
    }
    arriveShown = undefined
    syncGif()
  }

  /** The wake reaction frame, or `null` while it is off or unreadable. */
  async function fetchWake() {
    if (typeof api.memeWake !== 'function') return null
    let frame
    try {
      frame = await api.memeWake()
    } catch {
      return null
    }
    return timedFrameOf(frame)
  }

  /**
   * Play the wake reaction once, the moment the keyword fires.
   *
   * The frame is normally already in hand: `refreshFrames()` asks for it at startup. But the
   * first wake after a restart can beat the burst cycle to it, and being told to wait for a
   * poll timer before the ball will acknowledge its own name is not acceptable, so a frame
   * that is not cached yet is fetched here on demand instead of being skipped.
   *
   * Like the click reaction it carries a step: a new mode is what makes the image element
   * reload the GIF from its first frame rather than hold the last frame it stopped on.
   */
  function playWakeFrame() {
    if (wakeFrame === undefined || wakeFrame === null) {
      void fetchWake().then((frame) => {
        if (frame === null) return
        wakeFrame = frame
        playWakeFrame()
      })
      return
    }
    wakeStep += 1
    wakeShown = { src: wakeFrame.src, step: wakeStep }
    clearTimeout(wakeTimer)
    wakeTimer = setTimeout(() => {
      wakeShown = undefined
      syncGif()
    }, oneShotHoldMs(wakeFrame.ms, wakeFrame.loops))
    syncGif()
  }

  /** The acknowledgement frame, or `null` while it is off or unreadable. */
  async function fetchNod() {
    if (typeof api.memeNod !== 'function') return null
    let frame
    try {
      frame = await api.memeNod()
    } catch {
      return null
    }
    return timedFrameOf(frame)
  }

  /**
   * Show the acknowledgement once.
   *
   * Called when the user has just handed the agent something to do — from this panel's composer, or from another
   * window if the host reports it. Nothing is shown when the pack names no file, so a pack without this slot
   * behaves exactly as it did. The hold is the clip's own length, cut before its loop point by
   * {@link oneShotHoldMs}: this is a nod, not a loop.
   */
  function playNodFrame() {
    if (nodFrame === undefined || nodFrame === null) {
      if (nodPending) return
      nodPending = true
      void fetchNod().then((frame) => {
        nodPending = false
        if (frame === null) return
        nodFrame = frame
        playNodFrame()
      })
      return
    }
    nodStep += 1
    nodShown = { src: nodFrame.src, step: nodStep }
    clearTimeout(nodTimer)
    nodTimer = setTimeout(() => {
      nodShown = undefined
      syncGif()
    }, oneShotHoldMs(nodFrame.ms, nodFrame.loops))
    syncGif()
  }

  /**
   * The endings that arrive from the host rather than from this page's own transcript.
   *
   * `turn/end` carries the reason a turn stopped, and the reason is what tells these four apart — the assistant
   * stream's own `end` frame only says a stream stopped. So the host classifies it and sends
   * `{ type: 'turn-ended', category }`; this plays whatever the pack drew for that category.
   *
   * One entry per face, and each is a one-shot: it is shown for the length of its own clip and then handed back.
   * A category the pack names no file for resolves to `null` and nothing is shown, which is what lets a config
   * turn any of the four off without a code change.
   */
  const TURN_END_READERS = {
    done: () => api.memeDone(),
    fail: () => api.memeFail(),
    interrupted: () => api.memeInterrupted(),
    approval: () => api.memeApproval(),
    maxtokens: () => api.memeMaxtokens(),
    // The sixth. Its face was missing from this table while the other five were listed, so a question asked in
    // the DSH window played nothing at all — and the ball's *own* questions hid it, because those arrive as a
    // block in its transcript and go through `playAskFrame` instead of here.
    ask: () => api.memeAsk(),
  }
  /** The frame in hand per category, `null` once the helper has said there is none. */
  const turnEndFrames = new Map()
  const turnEndPending = new Set()
  const turnEndTimers = new Map()
  let turnEndStep = 0
  let turnEndShown

  /**
   * Show the face for one turn ending, once.
   *
   * The frame is read on demand: the first ending of a session routinely beats the startup sweep, and a face that
   * arrives after the clip is over is a face nobody sees. `turnEndPending` keeps two endings inside that one read
   * from racing over the same GIF, which is a whole file.
   */
  async function playTurnEndFrame(category) {
    const read = TURN_END_READERS[category]
    if (read === undefined) return
    if (!turnEndFrames.has(category)) {
      if (turnEndPending.has(category)) return
      turnEndPending.add(category)
      let frame = null
      try {
        frame = timedFrameOf(await read())
      } catch {
        // A read that failed is not an answer: it stays uncached, so the next ending asks again.
      } finally {
        turnEndPending.delete(category)
      }
      if (frame === null) return
      turnEndFrames.set(category, frame)
    }
    const frame = turnEndFrames.get(category)
    if (frame === null) return
    turnEndStep += 1
    turnEndShown = { src: frame.src, step: turnEndStep }
    clearTimeout(turnEndTimers.get(category))
    turnEndTimers.set(category, setTimeout(() => {
      turnEndTimers.delete(category)
      // Only if nothing newer has taken the ball: a second ending inside the first one's hold outranks it.
      if (turnEndShown?.step === turnEndStep) turnEndShown = undefined
      syncGif()
      // A floor, not a length: the clip keeps its own timing and this only stops a sub-second clip from being a
      // flash. See {@link TURN_END_MIN_HOLD_MS}.
    }, Math.max(oneShotHoldMs(frame.ms, frame.loops), TURN_END_MIN_HOLD_MS)))
    syncGif()
  }

  /** The finished-task frame, or `null` while it is off or unreadable. */
  async function fetchDone() {
    if (typeof api.memeDone !== 'function') return null
    let frame
    try {
      frame = await api.memeDone()
    } catch {
      return null
    }
    return timedFrameOf(frame)
  }

  /**
   * Play the finished-task frame once.
   *
   * It carries a step for the same reason the click reaction does: a new mode is what makes
   * the image element reload the GIF from its first frame instead of holding its last one.
   */
  function playDoneFrame() {
    if (doneFrame === undefined || doneFrame === null) return
    doneStep += 1
    doneShown = { src: doneFrame.src, step: doneStep }
    clearTimeout(doneTimer)
    doneTimer = setTimeout(() => {
      doneShown = undefined
      syncGif()
    }, oneShotHoldMs(doneFrame.ms, doneFrame.loops))
    syncGif()
  }

  /** The failure frame, or `null` while it is off or unreadable. */
  async function fetchFail() {
    if (typeof api.memeFail !== 'function') return null
    let frame
    try {
      frame = await api.memeFail()
    } catch {
      return null
    }
    return timedFrameOf(frame)
  }

  /**
   * Play the failure face once.
   *
   * The other half of the same edge `playDoneFrame` answers: a turn that ran to its own end rings, a
   * turn that threw wears this. It is called from {@link setRunning} rather than from a cue of its own,
   * because the host says which of the two it was in the same message — `{ type: 'turn', running: false,
   * failed: true, failure: { code, message } }` — and a failed run is not something to celebrate.
   *
   * A frame that is not in hand is read on demand: the first failure after a page load can beat the
   * frame sweep, and being told to wait for a poll before the ball will admit something broke is not
   * acceptable. A pack that names no failure face resolves to `null` and the ball keeps the face it
   * had, which is the whole of the fallback.
   */
  function playFailFrame() {
    if (failFrame === undefined || failFrame === null) {
      if (failPending) return
      failPending = true
      void fetchFail().then((frame) => {
        failPending = false
        if (frame === null) return
        failFrame = frame
        playFailFrame()
      })
      return
    }
    failStep += 1
    failShown = { src: failFrame.src, step: failStep }
    clearTimeout(failTimer)
    failTimer = setTimeout(() => {
      failShown = undefined
      syncGif()
    }, oneShotHoldMs(failFrame.ms, failFrame.loops))
    syncGif()
  }

  /**
   * Whether a tool name is one of the ways a subagent is run.
   *
   * Kept for the one thing left to build: a subagent that *stopped working* is only visible in the child
   * session's own log — `turn/end: { reason: { kind: 'error' } }` — which the helper can read and this
   * page cannot, and this is the name the host will have to match to say which call it belonged to.
   *
   * A predicate that read the parent's side was written and measured away. `upsertBlock` sees the
   * subagent's call settle, so `detail.isError` looked like the signal; against two real subagents whose
   * insides failed — a `read` of a missing file, and a shell syntax error — the parent's `tool/result` was
   * `isError: false` for both, because a subagent that can still answer ends its own turn `completed`. The
   * flag this page can read is not the flag that means "stopped working", so it is not read.
   */
  function isSubagentTool(name) {
    return name === 'subagent' || (typeof name === 'string' && name.startsWith('subagent_'))
  }

  /** The question face, or `null` while the pack names none or its file cannot be read. */
  async function fetchAsk() {
    if (typeof api.memeAsk !== 'function') return null
    let frame
    try {
      frame = await api.memeAsk()
    } catch {
      return null
    }
    return timedFrameOf(frame)
  }

  /**
   * Wear the question face for {@link ASK_HOLD_MS}, starting now.
   *
   * Called from the question card itself, so what it answers is exactly what the card answers: the
   * agent has asked, and the turn is parked until the user says something. A frame that is not in
   * hand yet is read on demand — the first question after a page load can beat the frame sweep —
   * and `askPending` keeps two questions that arrive inside that one read from racing over the same
   * GIF. A pack that names no question file, or names one that is not there, resolves to `null`
   * here and the ball simply keeps the face it had.
   *
   * There is one `#ball-gif` and one timer for this slot, which is the whole of "no stacking": a
   * second question takes a new step, which is what makes the image element reload the clip from
   * its first frame instead of holding the last one, and clears the timer, which is what restarts
   * the six seconds from the second question rather than leaving the first one's clock running.
   */
  function playAskFrame() {
    if (askFrame === undefined || askFrame === null) {
      if (askPending) return
      askPending = true
      void fetchAsk().then((frame) => {
        askPending = false
        if (frame === null) return
        askFrame = frame
        playAskFrame()
      })
      return
    }
    askStep += 1
    askShown = { src: askFrame.src, step: askStep }
    clearTimeout(askTimer)
    askTimer = setTimeout(() => {
      askShown = undefined
      syncGif()
    }, ASK_HOLD_MS)
    syncGif()
  }

  /**
   * One item of the plan's pool, or `null` when it is malformed.
   *
   * A single clip is `{ kind: 'single', frame: { src, ms } }` and a scripted run is
   * `{ kind: 'sequence', frames: [...] }`. A bare frame — what a helper written before runs existed
   * hands over — is read as the single clip it is, so the two shapes agree here rather than in every
   * caller: the pool is the one thing `skitSequence` reads.
   */
  function skitItemOf(value) {
    if (value === null || typeof value !== 'object') return skitSingleOf(value)
    if (value.kind === 'sequence') {
      if (!Array.isArray(value.frames)) return null
      // Walked once per frame rather than per filter: `timedFrameOf` reads the whole base64.
      const frames = value.frames.map(timedFrameOf).filter((frame) => frame !== null)
      return frames.length === 0 ? null : { kind: 'sequence', frames }
    }
    return skitSingleOf(value.frame === undefined ? value : value.frame)
  }

  /** A single clip as a pool item, whatever shape it arrived in. */
  function skitSingleOf(value) {
    const frame = timedFrameOf(value)
    return frame === null ? null : { kind: 'single', frame }
  }

  /**
   * The skit plan: `{ gapMs, files, item, times, interject }`, or `null` while it is off or unreadable.
   *
   * The pool is read as a list and kept as one: `skitSequence` draws from it once per skit. A plan
   * that names only one clip — the shape this slot had before it took a list, and before an item
   * could be a run — is a pool of one, so the pool is what a page written now reads while an
   * old-style helper still drives the same ball.
   */
  async function fetchSkit() {
    if (typeof api.memeSkit !== 'function') return null
    let plan
    try {
      plan = await api.memeSkit()
    } catch {
      return null
    }
    if (plan === null || typeof plan !== 'object') return null
    const numbers = (pair) => Array.isArray(pair) && pair.length === 2
      && pair.every((value) => typeof value === 'number' && Number.isFinite(value))
    if (!numbers(plan.gapMs) || !numbers(plan.times)) return null
    // Walked once per item rather than per filter: `timedFrameOf` reads the whole base64.
    const files = Array.isArray(plan.files) ? plan.files.map(skitItemOf).filter((item) => item !== null) : []
    const item = skitItemOf(plan.item === undefined ? plan.file : plan.item)
    if (item !== null && !files.some((known) => skitLead(known).src === skitLead(item).src)) files.unshift(item)
    if (files.length === 0) return null
    return { gapMs: plan.gapMs, times: plan.times, files, item, interject: timedFrameOf(plan.interject) }
  }

  /**
   * A `{ src, ms, loops }` frame from the helper, or `null` when it is missing or malformed.
   *
   * `loops` is read here rather than left to the caller so that every one-shot in the page
   * agrees on it, and so the base64 is walked once per fetch instead of once per hold.
   */
  function timedFrameOf(value) {
    if (value === null || typeof value !== 'object') return null
    if (typeof value.src !== 'string' || value.src === '') return null
    if (typeof value.ms !== 'number' || !Number.isFinite(value.ms) || value.ms <= 0) return null
    // A hold the pack asked for rides beside the length the helper measured, and only when it asked: `0` means
    // "the clip's own", which is what every frame meant before a pack could say otherwise, so the field is
    // left off rather than carried as a zero. Only the click slot can have one — see `clickHoldMs`.
    const hold = typeof value.holdMs === 'number' && Number.isFinite(value.holdMs) && value.holdMs > 0
      ? Math.min(Math.round(value.holdMs), 60_000)
      : 0
    return { src: value.src, ms: value.ms, loops: loopsForever(value.src), ...(hold > 0 ? { holdMs: hold } : {}) }
  }

  /**
   * How long a click reaction stays up: what the pack asked for, or the clip's own length cut before its loop
   * point.
   *
   * The cut is right for a clip whose animation is the message — the pose it ends on is never re-shown — and
   * wrong for a short clip the user asked for with their own hand: `摸头.gif` is 640 ms, so the cut held it
   * for 544, which reads as a flicker rather than as the ball answering a pat.
   */
  function clickHoldMs(frame) {
    const asked = frame?.holdMs
    if (typeof asked === 'number' && asked > 0) return asked
    return oneShotHoldMs(frame.ms, frame.loops)
  }

  /** The peek frames: `{ src, intro }` where the intro is optional, or `null` when unnamed. */
  /**
   * Fetch the dictation pose once, then repaint.
   *
   * `refreshFrames()` asks for it with the other named frames, but the first wake after a restart
   * can beat that timer, and a pose that shows up late on the one occasion the user is watching
   * for it is a pose they never see. `voicePending` keeps the two callers from racing each other
   * over a frame that is a whole GIF.
   */
  async function loadVoiceFrame() {
    if (voiceSrc !== undefined || voicePending) return
    voicePending = true
    try {
      const src = await fetchFrame(() => api.memeVoice())
      if (src !== undefined) {
        voiceSrc = src
        syncGif()
      }
    } finally {
      voicePending = false
    }
  }

  /**
   * Fetch the speaking pose once, then repaint.
   *
   * `refreshFrames()` asks for it with the other named frames, but the first reply of a session
   * can beat that timer, and a pose that turns up late on the one occasion the user is listening
   * for it is a pose they never see. `speakPending` keeps the two callers from racing over a frame
   * that is a whole GIF.
   */
  async function loadSpeakFrame() {
    if (speakSrc !== undefined || speakPending) return
    speakPending = true
    try {
      const src = await fetchFrame(() => api.memeSpeak())
      if (src !== undefined) {
        speakSrc = src
        syncGif()
      }
    } finally {
      speakPending = false
    }
  }

  /**
   * Fetch the face for one named tool, once, and remember it — including remembering that there is none.
   *
   * The name comes from the transcript's own tool cards, which is the only thing the page knows a call by, and
   * a pack answers with a file only for the tools it wants drawn apart. Everything else gets `null`, and the
   * `null` is cached as deliberately as a picture: most tools fall back to the shared face, and asking again
   * on every token of a call that runs for a minute would be a round trip per keystroke for an answer that
   * cannot change. It is keyed by name, so a turn that runs three tools fetches three faces and no more, and
   * it survives the call ending — so an edited `memes.json` lands on the next call rather than on a restart.
   */
  async function loadNamedToolFrame(name) {
    if (name === '' || toolFrames.has(name) || toolFramePending.has(name)) return
    toolFramePending.add(name)
    try {
      // Not `fetchFrame`: that one folds "no picture" and "the call failed" into the same `undefined`, and
      // here they are different answers — one is worth remembering, the other is worth retrying.
      const src = await api.memeToolNamed(name)
      if (typeof src === 'string' && src !== '') toolFrames.set(name, src)
      else if (src === null) toolFrames.set(name, null)
      // The frame arrived: restart the window it is needed in.
      //
      // This is the whole reason a fast tool's face used to be invisible. The page asks for the picture the moment
      // it hears the tool's name, but the helper has to read a file of one or two megabytes, base64 it and send it
      // back over IPC — and a tool like `grep` or `todo_write` is over in a few milliseconds. So by the time the
      // frame was in hand the window had closed and the branch below declined: the face was fetched and never
      // worn. Measured, that was the whole difference between `pwsh` (which the user could see) and the other
      // five (which they could not) — `pwsh`'s frame was already cached from an earlier call, so it painted on the
      // first repaint.
      //
      // Only for a frame that is actually needed: a name nobody is waiting for must not reopen a window and put a
      // tool face on a ball that has moved on.
      if (src === undefined) return
      const own = agentState === 'tooling' && agentTool === name
      const other = otherTool === name
      if (own || other) {
        // `otherStreamAt` is the module-level map `syncGif` reads through its own local name.
        if (other) otherStreamAt.set('tool', Date.now())
        syncGif()
      }
    } catch {
      // A read that failed is not an answer: it stays uncached, so the next call asks again.
    } finally {
      toolFramePending.delete(name)
    }
    syncGif()
  }

  /**
   * The poor frame and its line, or `null` while it is off, unreadable, or carries no line.
   *
   * A missing or unusable `below` is refused rather than defaulted here: the helper has already
   * turned a broken amount into zero, and zero means "no balance is ever below this", so the frame
   * is simply not worn. Refusing it also keeps the sweep asking, which is what makes an edited
   * `memes.json` show up without a restart.
   */
  async function fetchPoor() {
    if (typeof api.memePoor !== 'function') return null
    let plan
    try {
      plan = await api.memePoor()
    } catch {
      return null
    }
    if (plan === null || typeof plan !== 'object') return null
    if (typeof plan.src !== 'string' || plan.src === '') return null
    if (typeof plan.below !== 'number' || !Number.isFinite(plan.below) || plan.below <= 0) return null
    return { src: plan.src, below: plan.below }
  }

  /**
   * Fetch the poor frame once, then repaint.
   *
   * Read in the sweep with the other named loops rather than on a cue, because it *is* the resting
   * loop under a condition: it is wanted the moment the ball has nothing else to do. The frame and
   * its line are kept together, so the pair cannot disagree about which account is a poor one.
   */
  async function loadPoorFrame() {
    if (poorSrc !== undefined || poorPending) return
    poorPending = true
    try {
      const plan = await fetchPoor()
      if (plan !== null) {
        poorSrc = plan.src
        poorBelow = plan.below
        syncGif()
      }
    } finally {
      poorPending = false
    }
  }

  /**
   * The account's spendable balance in CNY as the host last read it, or `null` for "not known".
   *
   * Anything the host did not send as a non-negative finite number is "not known", including a
   * message with no `cny` at all: the number here decides a face, and only a reading the account
   * actually produced may do that.
   */
  function readBalance(payload) {
    if (payload === null || typeof payload !== 'object') return null
    const cny = payload.cny
    if (typeof cny !== 'number' || !Number.isFinite(cny) || cny < 0) return null
    return cny
  }

  async function fetchHover() {
    if (typeof api.memeHover !== 'function') return null
    let frames
    try {
      frames = await api.memeHover()
    } catch {
      return null
    }
    if (frames === null || typeof frames !== 'object') return null
    if (typeof frames.src !== 'string' || frames.src === '') return null
    const intro = frames.intro
    const usable = typeof intro === 'object' && intro !== null
      && typeof intro.src === 'string' && intro.src !== ''
      && typeof intro.ms === 'number' && Number.isFinite(intro.ms) && intro.ms > 0
    return {
      src: frames.src,
      intro: usable ? { src: intro.src, ms: intro.ms, loops: loopsForever(intro.src) } : null,
    }
  }

  async function fetchFrame(call) {
    if (typeof call !== 'function') return undefined
    let src
    try {
      src = await call()
    } catch {
      return undefined
    }
    return typeof src === 'string' && src !== '' ? src : undefined
  }

  /**
   * Re-read the helper's schedule. Editing `memes.json` therefore applies within one
   * gap, or within the idle poll while bursts are off; nothing here needs a restart.
   */
  async function refreshMemes() {
    if (typeof api.memeSchedule !== 'function') return
    let schedule
    try {
      schedule = await api.memeSchedule()
    } catch {
      schedule = null
    }
    const pairs = schedule !== null && typeof schedule === 'object'
      ? [schedule.gapMs, schedule.holdMs, schedule.frames]
      : []
    const valid = pairs.length === 3 && pairs.every((pair) => Array.isArray(pair) && pair.length === 2)
    // And the switch the helper reports with them: a schedule whose three ranges are intact but which is
    // switched off is an off schedule, not a malformed one. Reading only the ranges here left the two halves
    // disagreeing — `playMemeBurst` asks for `enabled` and would refuse to play — so what an off schedule
    // did was poll the helper every thirty seconds forever instead of once a gap.
    memeInfo = valid && schedule.enabled === true ? schedule : undefined
  }

  /**
   * Start the named frames and the burst timer chain. Nothing configured leaves the ball as it was.
   *
   * The greeting is asked for first and not awaited, so its read is on its way before the sweep
   * below reads a dozen files for the resting poses — see `wearArriveFrame` for why the order is
   * the whole point on the one occasion the user is watching the ball appear.
   */
  async function startMemes() {
    if (typeof api.memeSchedule !== 'function') return
    void wearArriveFrame()
    await refreshFrames()
    await refreshMemes()
    scheduleMemeBurst()
  }

  /**
   * The turn started, ended, or ended badly.
   *
   * `failed` is the host's word for *why* it ended: it reads the `turn/end` reason itself and says
   * `failed: true` only for a run that threw (`reason.kind === 'error'`, which is where the codes and
   * messages — `MALFORMED_RESPONSE`, `DeepSeek Messages stream: tool input is invalid JSON` — are kept,
   * in the host's own log). That flag is the only thing separating the two faces of one edge: a turn
   * that ran to its own end rings the bell, a run that threw wears the failure face, and the user
   * stopping it themselves does neither.
   */
  function setRunning(next, interrupted = false, failed = false) {
    // The transition is what matters, not the value: the host replays `turn` on every page
    // load, so reading `running === false` alone would ring the bell every time the ball starts.
    const wasRunning = running
    running = next
    if (pageClosed()) return
    document.body.classList.toggle('running', running)
    stop.hidden = !expanded || !running
    syncGif()
    if (next) {
      const group = ensureProcess()
      if (!group.live) {
        group.live = true
        group.startedAt = Date.now()
        group.elapsedMs = undefined
        setProcessOpen(group, true)
        refreshProcessLabel(group)
        startProcessClock()
      }
      return
    }
    // A turn ended. Only one that ran to its own end is a finished task: stopping the agent
    // yourself is not something to celebrate, and a run that threw is not a finished task at all —
    // it gets the failure face instead of the bell, whether or not this page saw it start.
    if (failed && !interrupted) playFailFrame()
    else if (wasRunning && !interrupted) playDoneFrame()
    if (interrupted) {
      for (const node of blocks.values()) {
        if (node.dataset.kind === 'tool' && node.dataset.state === 'running') {
          node.dataset.state = 'stopped'
          const summary = node.querySelector('.tool-summary')
          summary?.classList.add('tool-stopped-summary')
        }
      }
    }
    if (processGroup) {
      stopProcessClock()
      freezeProcess(processGroup)
      setProcessOpen(processGroup, false)
      refreshProcessLabel(processGroup)
    }
  }

  /**
   * Wear the corner the ball keeps, which is now the only place it is ever drawn.
   *
   * These classes used to be put on only while the panel was open, and the resting ball was drawn
   * by the base rules at the window's top-left. That worked because the resting window was the
   * ball plus two chrome insets, so the two sets of rules agreed. The window is now the overlay
   * rect in both states — see the note in `setExpanded()` — so the base rules would put the resting
   * ball in the panel's corner, and the classes have to be worn all the time instead.
   *
   * They therefore also cannot be left to the expand path to apply: the ball has to be in the right
   * column on the very first frame, before anything has been asked of the main process. That is
   * what the startup call in `boot()` is for.
   */
  function applyDirection(state) {
    document.body.classList.toggle('expand-left', state.horizontal === 'left')
    document.body.classList.toggle('expand-right', state.horizontal === 'right')
    document.body.classList.toggle('expand-up', state.vertical === 'up')
    document.body.classList.toggle('expand-down', state.vertical === 'down')
  }

  /**
   * Whether a pointer at `point` — a `{ clientX, clientY }`, in the page's own coordinates — is on
   * the strip a docked ball leaves behind.
   *
   * Deliberately not `pointerOnBallOrPanel()`, which asks about the ball and the card and is exactly
   * wrong here: while docked both of those are `visibility: hidden` and drawn at `--ball-column`
   * inside a 34px window, so no pointer can ever be on either of them. The strip is what is on
   * screen, and the main process is holding the window over it (`overCapturedRegion`), so a pointer
   * here is a pointer the page is hearing about at all.
   *
   * The rect is the tab element's own — the same box `syncHitTest` reports, at `DOCK_HIT_WIDTH` —
   * widened by {@link DOCK_ARRIVE_MARGIN_PX} because the helper's capture margin means the window
   * still delivers events a few pixels outside it. That bleed is taken on the inward edge only:
   * vertically the band is the strip exactly, since a clip that fired from 8px above the bar would
   * be answering a pointer that is nowhere near it.
   */
  function pointerInDockBand(point) {
    if (docked === undefined || point === undefined) return false
    if (dockTab.hidden || dockTab.offsetParent === null) return false
    const rect = dockTab.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false
    // The box the page reports, plus the helper's capture margin on the inward edge. On the outward
    // one there is nothing to widen into: that side is the screen edge.
    const from = docked === 'left' ? rect.left : rect.left - DOCK_ARRIVE_MARGIN_PX
    const to = docked === 'left' ? rect.right + DOCK_ARRIVE_MARGIN_PX : rect.right
    return point.clientX >= from && point.clientX <= to
      && point.clientY >= rect.top && point.clientY <= rect.bottom
  }

  function clearDockHoverTimer() {
    if (dockHoverTimer === undefined) return
    clearTimeout(dockHoverTimer)
    dockHoverTimer = undefined
  }

  /**
   * The screen rectangles the window must capture the mouse over: the ball, the open panel, the
   * stop cap and the docked tab.
   *
   * The window is the overlay rect in both states so that it never has to resize, which means at
   * rest it is a 742×544 rectangle whose only content is a 288px ball. Everything else in it is
   * transparent, and a transparent rectangle still eats clicks — so without this the panel would
   * open onto a sheet of dead desktop the size of the panel.
   *
   * This reports *geometry*, not a judgement about where the pointer is, and that is the whole
   * design. The obvious arrangement — the page hit-tests itself and says "the pointer is on me" —
   * cannot work: the window is click-through whenever the pointer is off these rectangles, and a
   * click-through window delivers no `mousemove` to the renderer at all, so the page would never
   * learn the pointer had arrived and the ball would be unclickable forever. That was measured, not
   * assumed. The main process polls the pointer instead, and only needs to be told where things
   * are; that changes when something moves or shows, not when the pointer does.
   *
   * Reported in screen coordinates, which is the space the main process polls in.
   */
  function syncHitTest() {
    if (typeof api.setHitTest !== 'function') return
    const regions = []
    for (const element of [ball, panel, stop, dockTab]) {
      // `offsetParent` is null while the panel is hidden, and a zero-sized rect would otherwise
      // capture a strip of nothing.
      if (element.hidden || element.offsetParent === null) continue
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      regions.push({ x: rect.left + window.screenX, y: rect.top + window.screenY, width: rect.width, height: rect.height })
    }
    // A drag in progress outruns the ball: the pointer is down and moving away, and the ball is
    // following it. Were the window to go click-through at that moment the drag would stop
    // responding exactly when it started, so the ball's rect is held for the duration.
    if (pointer !== undefined || dragging) regions.push({ x: window.screenX, y: window.screenY, width: window.innerWidth, height: window.innerHeight })
    api.setHitTest(regions)
  }

  function applyDocked(side) {
    const next = side === 'left' || side === 'right' ? side : undefined
    const becameDocked = docked === undefined && next !== undefined
    docked = next
    document.body.classList.toggle('docked', next !== undefined)
    document.body.classList.toggle('docked-left', next === 'left')
    document.body.classList.toggle('docked-right', next === 'right')
    // Whatever a peek had put on screen goes with the dock. The page's half is dropped here rather
    // than through `closeDockPeek`, and that is the whole reason it is not a call to it: pulling the
    // ball out reaches here *before* the helper is asked to slide it, and the helper has to still
    // believe the ball is standing at the edge for that slide to be skipped. Telling it to put the
    // window back on its tab first would re-park the ball off the screen and run the slide from
    // there — precisely the jump the peek exists to avoid. Any other caller here has already
    // overridden the window by its own route, so dropping the class is the whole of what is left.
    dockPeeked = false
    document.body.classList.remove('docked-peek')
    clearDockHoverTimer()
    // The arrival belongs to the strip. Undocking takes the strip away, so the clip that was playing
    // on it has nothing left to be about — and a docked *state* frame left up over a free ball would
    // be a ball wearing an arrival that never arrived anywhere.
    clearDockArrive()
    // Every branch below changes what the window should capture over, so every branch reports.
    // Docking is the case that most needs it: the ball is gone and the strip is what is left, and
    // without this the window would still be capturing over where the ball used to be.
    if (next === undefined) {
      dockTab.hidden = true
      syncHitTest()
      return
    }
    // A hover that is already resting on the strip when the ball docks is the one case `enterUi`
    // cannot see: the pointer never crossed anything, so no event is coming. The dwell is armed
    // here instead, and reads the same `dockPointerInside` the crossing would have set. Nothing
    // unsnaps on a timer any more — this is a greeting, and the strip is the only way out.
    if (becameDocked && dockPointerInside) beginDockArrive()
    dockTab.hidden = false
    syncHitTest()
  }

  function applyDockedFrom(result) {
    if (result == null) return
    applyDocked(result.docked)
  }

  async function moveBall(x, y) {
    applyDockedFrom(await api.move(x, y, !(running || asking())))
  }

  async function clampBall() {
    applyDockedFrom(await api.clamp(!(running || asking())))
  }

  async function unsnapDocked() {
    if (docked === undefined) return
    suppressExpand = true
    if (dragging) skipDockCommit = true
    applyDocked(undefined)
    applyDockedFrom(await api.unsnap())
  }

  /**
   * Undock as one leg of a pull that is still going on, so the ball is seen sliding out of the edge.
   *
   * {@link unsnapDocked} puts the ball on its slot in a single frame, which is right for every caller
   * that is *finishing* something — a click on the tab, a programmatic release — because there is no
   * gesture afterwards to watch it travel. The pull is not that: the hand is still down and still
   * moving, and the ball it just grabbed was a moment ago behind the edge, invisible. Snapping it
   * means the whole outward journey the user was shown on the way *in* (250ms of `snap`) has no
   * counterpart on the way out — the ball simply is at the cursor. So this asks the main process to
   * run the same slide the docking did, and that slide is abandoned by the next `moveBall` anyway,
   * which is what keeps it from being a delay the hand has to wait out.
   *
   * Everything else is `unsnapDocked`'s, deliberately: the same `suppressExpand`, the same
   * `skipDockCommit` (the release must not re-dock a ball the user just dragged out), and the same
   * `applyDocked(undefined)` first — the `docked` class has to come off before the slide starts or
   * the ball would be `visibility: hidden` for the whole of it.
   */
  async function unsnapDockedSmooth() {
    if (docked === undefined) return
    suppressExpand = true
    if (dragging) skipDockCommit = true
    applyDocked(undefined)
    applyDockedFrom(await api.unsnapSmooth())
  }

  async function setExpanded(next, force = false) {
    if (pageClosed()) return
    if (collapseTimer !== undefined) {
      clearTimeout(collapseTimer)
      collapseTimer = undefined
    }
    if (collapseFrame !== undefined) {
      clearTimeout(collapseFrame)
      collapseFrame = undefined
    }
    if (next) {
      // Nothing is asked for before the panel opens, and nothing resizes: the window is already
      // the size the panel needs, so opening is a repaint and there is no frame in which the ball
      // could be anywhere but where it already was.
      //
      // This replaces an arrangement that asked for the corner first and wore it before letting
      // the window grow. That was trying to win a race against a resize, and the resize won: a
      // window that has just grown still presents the surface it had while small, laid at its new
      // origin, so for one frame the ball was drawn at that stale surface's own top-left — the
      // panel's corner. Measured on the real machine the page's layout was correct on every one of
      // those frames, which is why no amount of reordering the page's own work could fix it.
      const state = await api.setExpanded(true)
      applyDocked(undefined)
      applyDirection(state)
      panel.hidden = false
      expanded = true
      document.body.classList.add('expanded')
      stop.hidden = !running
      syncGif()
      syncWake()
      syncHitTest()
      return
    }
    if (!force && (pinned || running || asking())) return
    expanded = false
    clearTyping()
    document.body.classList.remove('expanded')
    if (docked !== undefined) dockTab.hidden = false
    stop.hidden = true
    syncGif()
    syncWake()
    if (force) {
      panel.hidden = true
      await api.setExpanded(false)
      syncHitTest()
      return
    }
    collapseFrame = setTimeout(() => {
      collapseFrame = undefined
      panel.hidden = true
      // A collapse armed while the ball was free can come due after it has been docked, and then this is
      // the call that ends a peek behind the page's back — see `scheduleCollapse`. Anything the strip is
      // showing belongs to the strip; a docked ball has no panel for this step to put away anyway.
      if (docked === undefined) void api.setExpanded(false)
      syncHitTest()
    }, ANIMATION_MS)
  }

  function ballGrabOffset(event) {
    const rect = ball.getBoundingClientRect()
    return { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
  }

  function scheduleCollapse() {
    if (pinned || running || asking() || dragging) return
    // A docked ball has no panel to collapse. What this timer would do is `setExpanded(false)`, and the
    // helper's answer to that is `applyTab()` — which ends a *peek* as a side effect (`peeking = false`),
    // silently: nothing tells the page, which keeps `dockPeeked` and the `docked-peek` class. From then
    // on the page draws the strip at the peeked offsets inside the 34px tab window (off its own window,
    // so the strip and the ball both vanish) and measures the exit test against a ball that is no longer
    // on screen, so a hand resting on the strip reads as gone and every twitch replays the arrival. The
    // hand leaving a docked strip is served by `closeDockPeek()`; there is nothing here to arm.
    if (docked !== undefined) return
    if (collapseTimer !== undefined) clearTimeout(collapseTimer)
    collapseTimer = setTimeout(() => {
      collapseTimer = undefined
      void setExpanded(false)
    }, COLLAPSE_MS)
  }

  function draftOverflows() {
    return prompt.scrollHeight > prompt.clientHeight + 1
  }

  function syncComposerHeight() {
    const empty = promptText(prompt).trim() === ''
    prompt.classList.toggle('prompt-empty', empty)
    if (empty) {
      document.body.classList.remove('composer-capped')
      document.body.style.setProperty('--composer-height', 'var(--composer-pill)')
      return
    }
    document.body.classList.remove('composer-capped')
    let height = COMPOSER_MIN_PX
    for (;;) {
      document.body.style.setProperty('--composer-height', `${height}px`)
      if (!draftOverflows() || height >= COMPOSER_MAX_PX) break
      height = Math.min(COMPOSER_MAX_PX, height + COMPOSER_LINE_PX)
    }
    document.body.classList.toggle('composer-capped', draftOverflows())
  }

  function clearPrompt() {
    prompt.textContent = ''
    prompt.classList.add('prompt-empty')
    document.body.classList.remove('composer-capped')
    document.body.style.setProperty('--composer-height', 'var(--composer-pill)')
  }

  function refreshProcessLabel(group) {
    if (!group) return
    const elapsedMs = group.live
      ? group.startedAt === undefined ? undefined : Date.now() - group.startedAt
      : group.elapsedMs
    const title = !group.live && group.tools.size > 0
      ? processTitle([...group.tools], messages === zh)
      : undefined
    group.label.textContent = processLabel({
      zh: messages === zh,
      running: group.live,
      elapsedMs,
      title,
    })
  }

  function setProcessOpen(group, open) {
    if (!group) return
    group.preferredOpen = open
    const foldable = group.bodies.some((body) => body.childElementCount > 0)
    const shown = open && foldable
    group.section.toggleAttribute('data-open', shown)
    group.header.toggleAttribute('data-open', shown)
    group.header.disabled = !foldable
    group.chevron.hidden = !foldable
    if (foldable) group.header.setAttribute('aria-expanded', String(shown))
    else group.header.removeAttribute('aria-expanded')
  }

  function freezeProcess(group) {
    if (!group?.live) return
    group.elapsedMs = group.startedAt === undefined ? undefined : Date.now() - group.startedAt
    group.live = false
  }

  function stopProcessClock() {
    if (processClock === undefined) return
    clearInterval(processClock)
    processClock = undefined
  }

  function startProcessClock() {
    stopProcessClock()
    processClock = setInterval(() => {
      if (processGroup?.live) refreshProcessLabel(processGroup)
    }, 1000)
  }

  function closeProcess() {
    const group = processGroup
    if (!group) return
    stopProcessClock()
    freezeProcess(group)
    refreshProcessLabel(group)
    setProcessOpen(group, false)
    processGroup = undefined
  }

  function ensureProcess() {
    if (processGroup) return processGroup
    const section = document.createElement('section')
    section.className = 'turn'
    const header = document.createElement('button')
    header.type = 'button'
    header.className = 'process'
    const label = document.createElement('span')
    label.className = 'process-label'
    const chevron = icon(CHEVRON_DOWN)
    chevron.classList.add('process-chevron')
    header.append(label, chevron)
    section.append(header)
    const loose = []
    let anchor = null
    for (const child of transcript.children) {
      if (child.dataset?.kind === 'user') {
        loose.length = 0
        anchor = null
        continue
      }
      if (child.dataset?.kind === 'assistant') {
        if (anchor === null) anchor = child
        loose.push(child)
      }
    }
    if (anchor) transcript.insertBefore(section, anchor)
    else transcript.append(section)
    for (const node of loose) section.append(node)
    const live = running
    const group = {
      section, header, label, chevron, bodies: [], current: undefined, live,
      startedAt: live ? Date.now() : undefined,
      elapsedMs: undefined,
      preferredOpen: live,
      tools: new Set(),
    }
    processGroup = group
    header.addEventListener('click', () => {
      if (header.disabled) return
      setProcessOpen(group, !section.hasAttribute('data-open'))
    })
    setProcessOpen(group, live)
    refreshProcessLabel(group)
    if (live) startProcessClock()
    return group
  }

  function syncThinkPreview(node) {
    const summary = node.querySelector('.think-summary-text')?.textContent ?? ''
    node.toggleAttribute('data-preview', !node.hasAttribute('data-expanded') && summary !== '')
  }

  function createThink(node) {
    node.dataset.variant = 'think'
    const status = document.createElement('span')
    status.className = 'visually-hidden'
    const disclosure = document.createElement('div')
    disclosure.className = 'think-disclosure'
    const row = document.createElement('div')
    row.className = 'think-row'
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    row.setAttribute('aria-expanded', 'false')
    const leading = document.createElement('span')
    leading.className = 'think-leading'
    const idle = document.createElement('span')
    idle.className = 'think-icon-idle'
    idle.append(icon(THINK))
    const hover = document.createElement('span')
    hover.className = 'think-chevron-hover'
    hover.append(icon(CHEVRON_DOWN))
    const openChevron = document.createElement('span')
    openChevron.className = 'think-chevron-open'
    openChevron.append(icon(CHEVRON_UP))
    leading.append(idle, hover, openChevron)
    const title = document.createElement('span')
    title.className = 'think-title'
    title.textContent = messages.think
    const separator = document.createElement('span')
    separator.className = 'think-separator'
    separator.setAttribute('aria-hidden', 'true')
    const summary = document.createElement('span')
    summary.className = 'think-summary'
    const summaryText = document.createElement('span')
    summaryText.className = 'think-summary-text'
    summary.append(summaryText)
    row.append(leading, title, separator, summary)
    const body = document.createElement('div')
    body.className = 'think-body'
    disclosure.append(row, body)
    node.append(status, disclosure)
    const toggle = () => {
      const open = !node.hasAttribute('data-expanded')
      node.toggleAttribute('data-expanded', open)
      disclosure.toggleAttribute('data-open', open)
      row.setAttribute('aria-expanded', String(open))
      syncThinkPreview(node)
    }
    row.addEventListener('click', toggle)
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      toggle()
    })
  }

  /**
   * Chronological placement, as in Harness: replies sit between the process
   * runs that produced them. Thinking and tool blocks join the trailing
   * process body; a reply closes that run, so later tools open a new one.
   */
  function placeBlock(node, kind) {
    if (kind === 'user') {
      closeProcess()
      transcript.append(node)
      return
    }
    // With no turn section at all a reply stays loose; the next thinking/tool block scoops it in.
    if (kind === 'assistant' && processGroup === undefined) {
      transcript.append(node)
      return
    }
    const group = ensureProcess()
    if (kind === 'assistant') {
      group.current = undefined
      group.section.append(node)
      return
    }
    let body = group.current
    if (body === undefined) {
      body = document.createElement('div')
      body.className = 'process-body'
      group.section.append(body)
      group.bodies.push(body)
      group.current = body
    }
    body.append(node)
    setProcessOpen(group, group.preferredOpen === true)
  }

  const CHAT_READ_MAX_LINES = 8
  const CHAT_SEARCH_MAX_LINES = 8
  const CHAT_DIFF_MAX_LINES = 9

  function toolIcon(name) {
    if (name === 'web_search') return icon(GLOBE)
    if (name === 'web_fetch' || name === 'read' || name === 'read_image') return icon(BROWSE)
    switch (classifyTool(name)) {
      case 'bash': return icon(API)
      case 'search': return icon(SEARCH)
      case 'write':
      case 'edit': return icon(EDIT)
      case 'code': return icon(CODE)
      default: return icon(SPARKLE)
    }
  }

  async function writeClipboard(text) {
    // Main-process write: renderer clipboard APIs reject while the ball window
    // rests unfocused ("Document is not focused").
    if (typeof api?.copy === 'function') {
      api.copy(text)
      return true
    }
    if (navigator.clipboard?.writeText !== undefined) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    let copied = false
    try {
      copied = document.execCommand('copy')
    } catch {
      copied = false
    }
    area.remove()
    return copied
  }

  function copyToClipboard(text, button) {
    const restore = () => {
      button.textContent = chatLabels.copy
      delete button.dataset.copied
    }
    const done = () => {
      button.textContent = chatLabels.copied
      button.dataset.copied = 'true'
      setTimeout(restore, 1600)
    }
    void writeClipboard(text).then((ok) => {
      if (ok) done()
      else restore()
    })
  }

  /**
   * Icon copy button for message chrome (MessageIconActions): copy glyph,
   * brief check mark once the clipboard write resolves.
   */
  function messageCopyButton(getText) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'msg-copy'
    button.title = chatLabels.copy
    button.append(icon(COPY))
    let revertTimer
    const reset = () => {
      delete button.dataset.copied
      button.title = chatLabels.copy
      button.replaceChildren(icon(COPY))
    }
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      if (button.dataset.copied === 'true') return
      void writeClipboard(getText()).then((ok) => {
        if (!ok) return
        clearTimeout(revertTimer)
        button.dataset.copied = 'true'
        button.title = chatLabels.copied
        button.replaceChildren(icon(CHECK))
        revertTimer = setTimeout(reset, 1200)
      })
    })
    return button
  }

  /**
   * Per-message read-aloud button, sitting next to copy in the assistant's action row.
   *
   * The label is stateful on purpose: while this reply is the one being read the button becomes a
   * stop square, because "play" on the message you are already hearing would be a lie. Only the
   * playing button changes — the other nineteen stay triangles, so the row never looks busy.
   *
   * @param {string} key block identity, so the speaker can tell replies apart
   * @param {() => string} getText raw markdown of the reply
   */
  function messageSpeakButton(key, getText) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'msg-speak'
    button.title = chatLabels.play
    button.append(icon(SPEAKER))
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      if (speaker.isSpeaking(key)) speaker.cancel()
      else speaker.speak(getText(), key)
    })
    speechButtons.set(key, button)
    // A reply restored from history arrives already finished, so the button is correct only after
    // this first paint; without it every pre-existing message would show a triangle while speaking.
    paintSpeakButton(button, key)
    return button
  }

  /** Reflect one button's play/stop state. Safe to call for a button already removed from the DOM. */
  function paintSpeakButton(button, key) {
    const playing = speaker.isSpeaking(key)
    button.dataset.playing = playing ? 'true' : 'false'
    button.title = playing ? chatLabels.playing : chatLabels.play
    button.replaceChildren(icon(playing ? STOP : SPEAKER))
  }

  /**
   * The last read-aloud sentence written to the status line, so it is only ever cleared by us.
   *
   * The line is shared with dictation, and both can be live at once; clearing on a bare "no message
   * right now" would wipe whichever of the two wrote second.
   */
  let speechStatus = ''

  /** Word one read-aloud state for the status line, or '' when there is nothing to report. */
  function speechStatusText(state) {
    if (state.notice === 'starting') return messages.speechStarting
    switch (state.error) {
      case 'offline': return messages.speechOffline
      case 'timeout': return messages.speechTimeout
      case 'autoplay': return messages.speechAutoplay
      case 'playback': return messages.speechPlayback
      case 'server': return messages.speechServer.replace('{why}', state.detail ?? '')
      default: return ''
    }
  }

  /**
   * Speaker state changed: repaint every button, add or drop them all when the feature is off, and
   * report anything that went wrong.
   *
   * Called from the speaker itself, so it covers every path — a button press, an automatic reply, a
   * service that died mid-sentence — without each of them having to remember.
   */
  syncSpeechButtons = function (state) {
    // Read-aloud is a cosmetic state like any other, so both of its edges repaint the ball:
    // starting to speak and finishing the last sentence are separate events, and each has to
    // redraw on its own. The speaker is the only thing that knows either happened, and this
    // callback is the single place every path goes through — a button press, an automatic reply,
    // a service that died mid-sentence — so neither edge can slip through by hooking it here.
    if (state.speaking !== speakActive) {
      speakActive = state.speaking
      // The wake word must not hear the ball. `/speak` plays out of the speakers beside the
      // microphone and the positives were synthesised in exactly these voices, so our own reply
      // is close to a positive sample. This is the only place both edges of that state are
      // visible, which is why the mute lives here rather than in the two call sites that start
      // and stop playback — they do not know about each other, and the automatic path never
      // touches this code at all.
      if (speakActive) wake.mute()
      else wake.unmute()
      // The first reply of a session can start before `refreshFrames` has made its round, so ask
      // for the frame now rather than wearing nothing for the opening sentence.
      if (speakActive && speakSrc === undefined) void loadSpeakFrame()
      syncGif()
    }

    for (const [key, button] of speechButtons) {
      if (state.enabled === false) {
        button.remove()
        speechButtons.delete(key)
        continue
      }
      if (button.isConnected) paintSpeakButton(button, key)
      else speechButtons.delete(key)
    }

    // A failure with nothing said about it is the same to the user as a button that does nothing.
    const text = speechStatusText(state)
    if (text !== '') {
      status.textContent = text
      speechStatus = text
    } else if (speechStatus !== '' && status.textContent === speechStatus) {
      status.textContent = ''
      speechStatus = ''
    }
  }

  /**
   * Give every reply already on screen a read-aloud button.
   *
   * Needed because the settings page can turn speech on with the ball open: the buttons belong to
   * the messages rather than to the feature, so they would otherwise wait for the next reply.
   * Inserted before the usage pill, which is the rightmost item in the row.
   */
  function addSpeakButtons() {
    for (const [key, node] of blocks) {
      if (node.dataset?.kind !== 'assistant') continue
      if (speechButtons.has(key)) continue
      const actions = node.querySelector('.am-actions')
      const record = messageCopyText.get(node)
      if (actions === null || record === undefined) continue
      const button = messageSpeakButton(key, () => record.text)
      const usage = actions.querySelector('.am-usage')
      if (usage !== null) actions.insertBefore(button, usage)
      else actions.append(button)
    }
  }

  /** Usage pill text: "12.3K tok", hidden entirely when no usage arrived. */
  function usagePill(node, block) {
    const pill = node.querySelector('.am-usage')
    const total = block.running ? null : tokenUsageTotal(block.usage)
    pill.hidden = total === null
    if (total !== null) {
      pill.textContent = usageText.count(formatTokenCount(total))
      pill.title = usageText.title
    }
  }

  function wireCopyButtons(root) {
    for (const button of root.querySelectorAll('.cb-copy, .term-copy, .search-copy')) {
      if (button.dataset.wired === 'true') continue
      button.dataset.wired = 'true'
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        const block = button.closest('.cb, .term, .search')
        const code = block?.querySelector('pre')?.textContent ?? ''
        copyToClipboard(code, button)
      })
    }
  }

  function renderMarkdownBody(element, text, { compact = false, live = false } = {}) {
    element.innerHTML = renderMarkdown(text, { compact, copyLabel: chatLabels.copy })
    wireCopyButtons(element)
    // Shiki runs on settled content only; re-highlighting every delta is too costly while streaming.
    if (!live) void upgradeCodeBlocks(element)
  }

  function shimmer(element, active) {
    if (active) element.setAttribute('data-text-shimmer', '')
    else element.removeAttribute('data-text-shimmer')
  }

  /** Bounded row list with the primitives' ghost "… N more" expander. */
  function cappedRows(target, rows, cap) {
    target.replaceChildren()
    const show = rows.slice(0, cap)
    for (const row of show) target.append(row)
    if (rows.length <= cap) return
    const expand = document.createElement('button')
    expand.type = 'button'
    expand.className = 'card-expand'
    expand.textContent = `… ${rows.length - show.length}`
    let open = false
    expand.addEventListener('click', (event) => {
      event.stopPropagation()
      open = !open
      for (const row of rows.slice(show.length)) {
        if (open) target.append(row)
        else row.remove()
      }
      expand.remove()
      if (!open) {
        for (const row of rows.slice(cap)) row.remove()
        target.append(expand)
      }
      expand.textContent = open ? chatLabels.collapse : `… ${rows.length - show.length}`
      if (!open) return
    })
    target.append(expand)
  }

  function buildTerminalCard(model) {
    const card = document.createElement('div')
    card.className = 'term'
    card.setAttribute('data-body', 'true')
    const header = document.createElement('div')
    header.className = 'term-header'
    const prompt = document.createElement('div')
    prompt.className = 'term-prompt'
    const line = document.createElement('div')
    line.className = 'term-prompt-line'
    const command = document.createElement('span')
    command.className = 'term-command'
    command.textContent = model.command
    line.append(command)
    const failed = terminalFailed(model)
    const status = document.createElement('span')
    status.className = 'term-status'
    if (model.signal !== undefined) status.textContent = chatLabels.signal(model.signal)
    else if (model.exitCode === undefined || model.exitCode === null) status.textContent = chatLabels.noExitCode
    else {
      status.textContent = chatLabels.exitCode(model.exitCode)
      if (model.exitCode === 0 && !failed) status.setAttribute('data-ok', 'true')
    }
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'term-copy'
    copy.textContent = chatLabels.copy
    prompt.append(line)
    header.append(prompt, status, copy)
    card.append(header)
    const output = document.createElement('div')
    output.className = 'term-output'
    const text = model.output ?? ''
    if (text === '') {
      const empty = document.createElement('div')
      empty.className = 'term-empty'
      empty.textContent = chatLabels.noOutput
      card.append(empty)
    } else {
      for (const row of text.split('\n')) {
        const lineEl = document.createElement('div')
        lineEl.className = 'term-line'
        lineEl.textContent = row
        output.append(lineEl)
      }
      card.append(output)
    }
    return card
  }

  function buildDiffCard(model) {
    const card = document.createElement('div')
    card.className = 'diff'
    const body = document.createElement('div')
    body.className = 'diff-body'
    const rows = []
    for (const hunk of model.diffs) {
      const path = document.createElement('div')
      path.className = 'diff-line diff-path'
      path.textContent = hunk.path
      rows.push(path)
      for (const line of diffLines(hunk)) {
        const row = document.createElement('div')
        row.className = `diff-line diff-${line.kind}`
        row.textContent = line.text
        rows.push(row)
      }
    }
    cappedRows(body, rows, CHAT_DIFF_MAX_LINES)
    card.append(body)
    return card
  }

  function buildReadCard(model) {
    const card = document.createElement('div')
    card.className = 'cb'
    card.setAttribute('data-code-lang', model.lang ?? '')
    const bannerWrap = document.createElement('div')
    bannerWrap.className = 'cb-banner-wrap'
    const banner = document.createElement('div')
    banner.className = 'cb-banner'
    banner.setAttribute('data-code-block-banner', '')
    const info = document.createElement('div')
    info.className = 'cb-infostring'
    info.textContent = `${model.label} · ${chatLabels.readWindow(Math.min(model.lines.length, CHAT_READ_MAX_LINES), model.totalLines)}`
    const action = document.createElement('div')
    action.className = 'cb-action'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'cb-copy'
    copy.textContent = chatLabels.copy
    action.append(copy)
    banner.append(info, action)
    bannerWrap.append(banner)
    card.append(bannerWrap)
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    const rows = model.lines.map((line) => {
      const row = document.createElement('div')
      row.className = 'read-line'
      const gutter = document.createElement('span')
      gutter.className = 'read-gutter'
      gutter.textContent = String(line.number)
      const content = document.createElement('span')
      content.className = 'read-content'
      content.textContent = line.text
      row.append(gutter, content)
      return row
    })
    const gutterWidth = `${String(model.totalLines).length + 1}ch`
    card.style.setProperty('--dsl-read-gutter', gutterWidth)
    cappedRows(code, rows, CHAT_READ_MAX_LINES)
    pre.append(code)
    card.append(pre)
    return card
  }

  function buildSearchCard(cardModel) {
    const card = document.createElement('div')
    card.className = 'search'
    const header = document.createElement('div')
    header.className = 'search-header'
    const summary = document.createElement('div')
    summary.className = 'search-summary'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'search-copy'
    copy.textContent = chatLabels.copy
    header.append(summary, copy)
    card.append(header)
    const body = document.createElement('div')
    body.className = 'search-body'
    const rows = []
    if (cardModel.kind === 'matches') {
      const shown = cardModel.files.reduce((total, file) => total + file.matches.length, 0)
      summary.textContent = chatLabels.matchesSummary(shown, cardModel.total, cardModel.files.length, cardModel.truncated)
      for (const file of cardModel.files) {
        const group = document.createElement('div')
        group.className = 'search-file-header'
        const path = document.createElement('span')
        path.className = 'search-file-path'
        path.textContent = file.path
        const count = document.createElement('span')
        count.className = 'search-file-count'
        count.textContent = String(file.matches.length)
        group.append(path, count)
        rows.push(group)
        for (const match of file.matches) {
          const line = document.createElement('div')
          line.className = 'search-line'
          const number = document.createElement('span')
          number.className = 'search-line-number'
          number.textContent = `${match.lineNumber}  `
          line.append(number)
          line.append(document.createTextNode(match.line))
          rows.push(line)
        }
      }
    } else {
      summary.textContent = chatLabels.pathsSummary(cardModel.paths.length, cardModel.total, cardModel.truncated)
      for (const path of cardModel.paths) {
        const line = document.createElement('div')
        line.className = 'search-line'
        line.textContent = path
        rows.push(line)
      }
    }
    if (rows.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'search-empty'
      empty.textContent = chatLabels.noResults
      card.append(empty)
      return card
    }
    cappedRows(body, rows, CHAT_SEARCH_MAX_LINES)
    card.append(body)
    return card
  }

  function linkOrText(className, url, label) {
    if (!/^https?:\/\//i.test(url)) return document.createTextNode(label)
    const link = document.createElement('a')
    link.className = className
    link.href = url
    link.textContent = label
    return link
  }

  function buildWebCard(model) {
    const card = document.createElement('div')
    card.className = 'web'
    if (model.kind === 'fetch') {
      const fetch = document.createElement('div')
      fetch.className = 'web-fetch'
      fetch.append(linkOrText('web-fetch-url', model.url, model.url))
      const meta = document.createElement('div')
      meta.className = 'web-fetch-meta'
      const status = document.createElement('span')
      status.className = 'web-status'
      status.textContent = `HTTP ${model.statusCode}`
      meta.append(status)
      if (model.truncated) {
        const truncated = document.createElement('span')
        truncated.className = 'web-truncated'
        truncated.textContent = chatLabels.contentTruncated
        meta.append(truncated)
      }
      fetch.append(url, meta)
      card.append(fetch)
      return card
    }
    if (model.answer) {
      const answer = document.createElement('div')
      answer.className = 'web-answer'
      renderMarkdownBody(answer, model.answer)
      card.append(answer)
    }
    if (model.sources.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'web-empty'
      empty.textContent = chatLabels.webNoResults
      card.append(empty)
      return card
    }
    const sources = document.createElement('ol')
    sources.className = 'web-sources'
    for (const source of model.sources) {
      const item = document.createElement('li')
      item.className = 'web-source'
      item.append(linkOrText('web-source-link', source.url, source.title !== undefined && source.title !== '' ? source.title : source.url))
      if (source.snippet !== undefined && source.snippet !== '') {
        const snippet = document.createElement('div')
        snippet.className = 'web-snippet'
        snippet.textContent = source.snippet
        item.append(snippet)
      }
      if (source.publishedAt !== undefined && source.publishedAt !== '') {
        const published = document.createElement('div')
        published.className = 'web-published'
        published.textContent = source.publishedAt
        item.append(published)
      }
      sources.append(item)
    }
    card.append(sources)
    if (model.truncated) {
      const truncated = document.createElement('div')
      truncated.className = 'web-truncated'
      truncated.textContent = chatLabels.sourcesTruncated
      card.append(truncated)
    }
    return card
  }

  function buildIoCard(inputText, outputText, isError) {
    const card = document.createElement('div')
    card.className = 'tool-io-card'
    if (inputText !== null) {
      const section = document.createElement('div')
      section.className = 'tool-io-section'
      const label = document.createElement('span')
      label.className = 'tool-io-label'
      label.textContent = chatLabels.input
      const text = document.createElement('span')
      text.className = 'tool-io-text'
      text.textContent = inputText
      section.append(label, text)
      card.append(section)
    }
    if (inputText !== null && outputText !== null) {
      const divider = document.createElement('span')
      divider.className = 'tool-io-divider'
      card.append(divider)
    }
    if (outputText !== null) {
      const section = document.createElement('div')
      section.className = 'tool-io-section'
      const label = document.createElement('span')
      label.className = 'tool-io-label'
      label.textContent = chatLabels.output
      const text = document.createElement('span')
      text.className = 'tool-io-text'
      text.textContent = outputText
      if (isError) text.setAttribute('data-error', 'true')
      section.append(label, text)
      card.append(section)
    }
    return card
  }

  function updateToolNode(node, block) {
    const detail = block.detail
    const name = block.text
    const root = node.querySelector('.tool')
    const variant = classifyTool(name)
    const state = block.running === true
      ? detail?.args ? 'running' : 'preparing'
      : detail?.isError === true ? 'error' : node.dataset.state === 'stopped' ? 'stopped' : 'ok'
    root.dataset.tool = name
    root.dataset.variant = variant
    root.dataset.state = state
    node.dataset.state = state

    node.querySelector('.visually-hidden').textContent = state === 'error' ? messages.failed
      : state === 'stopped' ? messages.stopped
        : state === 'running' || state === 'preparing' ? messages.running
          : ''

    const title = node.querySelector('.tool-title')
    title.textContent = toolTitle(name, messages === zh)
    shimmer(title, state === 'running' || state === 'preparing')

    const meta = parseMeta(detail?.meta)
    const terminal = terminalCardModel(name, detail?.args ?? '', detail?.result ? [{ type: 'text', text: detail.result }] : [])
    const read = terminal === null ? readCardModel(meta, detail?.result ? [{ type: 'text', text: detail.result }] : []) : null
    const search = read === null && terminal === null ? searchCardModel(meta) : null
    const web = search === null && read === null && terminal === null ? webCardModel(meta) : null
    const diff = terminal === null && read === null && search === null && web === null
      ? diffCardModel(name, detail?.args ?? '', detail?.isError === true, meta)
      : null

    const expandable = state !== 'preparing'
      && (Boolean(detail?.args) || Boolean(detail?.result) || terminal !== null || read !== null || search !== null || web !== null || diff !== null)
    const row = node.querySelector('.tool-row')
    root.toggleAttribute('data-expandable', expandable)
    row.toggleAttribute('data-expandable', expandable)
    if (!expandable) {
      root.removeAttribute('data-open')
      row.setAttribute('aria-expanded', 'false')
    }

    let summaryText
    if (state === 'error') {
      const first = firstLineOf(detail?.result ?? '')
      summaryText = first !== '' ? first : summaryFor(name, detail?.args ?? '')
    } else if (state === 'stopped') {
      summaryText = summaryFor(name, detail?.args ?? '')
    } else {
      summaryText = summaryFor(name, detail?.args ?? '')
    }
    const sep = node.querySelector('.tool-sep')
    const summary = node.querySelector('.tool-summary')
    const fileLink = node.querySelector('.tool-file-link')
    const suffix = node.querySelector('.tool-summary-suffix')
    const showCollapsed = summaryText !== '' && state !== 'preparing'
    sep.hidden = !showCollapsed
    summary.hidden = !showCollapsed
    summary.textContent = summaryText
    fileLink.hidden = true
    shimmer(summary, state === 'running')

    if (diff !== null && state !== 'error' && state !== 'stopped') {
      const totals = diffTotals(diff.diffs)
      suffix.hidden = false
      suffix.textContent = `+${totals.added} -${totals.removed}`
      suffix.className = 'tool-summary-suffix tool-diff-stat'
    } else {
      suffix.hidden = true
      suffix.textContent = ''
      suffix.className = 'tool-summary-suffix'
    }

    const bodyWrap = node.querySelector('.tool-body')
    bodyWrap.replaceChildren()
    if (terminal !== null) {
      bodyWrap.className = 'tool-body tool-terminal-body'
      bodyWrap.append(buildTerminalCard(terminal))
    } else if (diff !== null) {
      bodyWrap.className = 'tool-body tool-diff-body'
      bodyWrap.append(buildDiffCard(diff))
    } else if (read !== null) {
      bodyWrap.className = 'tool-body tool-read-body'
      bodyWrap.append(buildReadCard(read))
    } else if (search !== null) {
      bodyWrap.className = 'tool-body tool-search-body'
      bodyWrap.append(buildSearchCard(search.card))
      if (search.recovery !== undefined) {
        const recovery = document.createElement('div')
        recovery.className = 'tool-search-recovery'
        recovery.textContent = search.recovery
        bodyWrap.append(recovery)
      }
    } else if (web !== null) {
      bodyWrap.className = 'tool-body tool-web-body'
      bodyWrap.append(buildWebCard(web))
    } else {
      bodyWrap.className = 'tool-body'
      const input = formatToolBody(variant, detail?.args ?? '')
      const output = detail?.result ? detail.result : null
      if (input !== null || output !== null) {
        bodyWrap.append(buildIoCard(input, output, detail?.isError === true))
      }
    }
    if (processGroup !== undefined) processGroup.tools.add(name)
    refreshProcessLabel(processGroup)
  }

  function parseMeta(text) {
    if (typeof text !== 'string' || text === '') return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  function firstLineOf(text) {
    const newline = text.indexOf('\n')
    return newline === -1 ? text : text.slice(0, newline)
  }

  function summaryFor(name, argsRaw) {
    const variant = classifyTool(name)
    const base = deriveSummary(variant, argsRaw)
    if (variant !== 'others') return base
    return base === '' ? name : `${name} · ${base}`
  }

  function createToolNode(block) {
    const node = document.createElement('article')
    node.className = 'block'
    node.dataset.kind = 'tool'
    const root = document.createElement('div')
    root.className = 'tool'
    const status = document.createElement('span')
    status.className = 'visually-hidden'
    const row = document.createElement('div')
    row.className = 'tool-row'
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    row.setAttribute('aria-expanded', 'false')
    const leading = document.createElement('span')
    leading.className = 'tool-leading'
    const idle = document.createElement('span')
    idle.className = 'tool-icon-idle'
    idle.append(toolIcon(block.text))
    const hover = document.createElement('span')
    hover.className = 'tool-chevron-hover'
    hover.append(icon(CHEVRON_DOWN))
    const open = document.createElement('span')
    open.className = 'tool-chevron-open'
    open.append(icon(CHEVRON_UP))
    leading.append(idle, hover, open)
    const title = document.createElement('span')
    title.className = 'tool-title'
    const sep = document.createElement('span')
    sep.className = 'tool-sep'
    sep.setAttribute('aria-hidden', 'true')
    const summary = document.createElement('span')
    summary.className = 'tool-summary'
    const suffix = document.createElement('span')
    suffix.className = 'tool-summary-suffix'
    suffix.hidden = true
    const fileLink = document.createElement('span')
    fileLink.className = 'tool-file-link'
    fileLink.hidden = true
    row.append(leading, title, sep, summary, suffix, fileLink)
    const body = document.createElement('div')
    body.className = 'tool-body'
    root.append(status, row, body)
    node.append(root)
    const toggle = () => {
      if (root.hasAttribute('data-expandable') === false) return
      const isOpen = !root.hasAttribute('data-open')
      root.toggleAttribute('data-open', isOpen)
      row.setAttribute('aria-expanded', String(isOpen))
    }
    row.addEventListener('click', toggle)
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      toggle()
    })
    return node
  }

  /** Per-node raw text the message copy button writes (raw markdown, as Harness). */
  const messageCopyText = new WeakMap()

  function updateAssistantNode(node, block) {
    const body = node.querySelector('.am-body')
    renderMarkdownBody(body, block.text, { live: block.running === true })
    const record = messageCopyText.get(node)
    if (record) record.text = block.text
    const actions = node.querySelector('.am-actions')
    if (actions) actions.hidden = block.running === true
    usagePill(node, block)
    const existing = node.querySelector('.am-stopped')
    if (block.interrupted === true) {
      const chip = existing ?? document.createElement('span')
      chip.className = 'am-stopped'
      chip.textContent = messages.stopped
      if (existing === null) body.append(chip)
    } else {
      existing?.remove()
    }
  }

  /**
   * Speak a finished assistant reply, once.
   *
   * `running` flipping from true to false is the only reliable "this reply is complete" signal: the
   * text arrives token by token before that, so anything earlier would read a truncated sentence and
   * anything later never arrives. The previous value is remembered per block key because a reply can
   * be re-sent unchanged (usage updates, history reloads) and speaking it again would be wrong.
   */
  const speechRunningBefore = new Map()
  function speakWhenFinished(block) {
    if (block?.kind !== 'assistant') return
    const was = speechRunningBefore.get(block.key)
    speechRunningBefore.set(block.key, block.running === true)
    // Only the true→false edge counts, and only for a key seen running first — otherwise a block
    // that arrives already finished (a page reload) would be read out on every reload.
    if (was !== true) return
    // `autoPlay` off means the button is the only way in; the speaker's own `enabled` check is the
    // backstop, so a settings change mid-reply cannot slip a sentence past the switch.
    if (!speaker.autoPlay) return
    speaker.speak(block.text, block.key)
  }

  function upsertBlock(block) {
    if (typeof block?.key !== 'string' || typeof block.text !== 'string') return
    blockData.set(block.key, block)
    let node = blocks.get(block.key)
    if (node === undefined) {
      if (block.kind === 'user') {
        node = document.createElement('div')
        node.className = 'user-row'
        node.dataset.kind = 'user'
        const bubble = document.createElement('div')
        bubble.className = 'user-bubble'
        const actions = document.createElement('div')
        actions.className = 'user-actions'
        actions.append(messageCopyButton(() => bubble.textContent ?? ''))
        node.append(bubble, actions)
      } else if (block.kind === 'assistant') {
        node = document.createElement('article')
        node.className = 'block'
        node.dataset.kind = 'assistant'
        const root = document.createElement('div')
        root.className = 'am'
        const body = document.createElement('div')
        body.className = 'am-body'
        const actions = document.createElement('div')
        actions.className = 'am-actions'
        actions.hidden = true
        const copyText = { text: '' }
        messageCopyText.set(node, copyText)
        actions.append(messageCopyButton(() => copyText.text))
        // Only while the feature is on: a button that cannot work is worse than no button, and the
        // settings page can turn speech on without a reload.
        if (speaker.enabled) actions.append(messageSpeakButton(block.key, () => copyText.text))
        const usage = document.createElement('span')
        usage.className = 'am-usage'
        usage.hidden = true
        actions.append(usage)
        root.append(body, actions)
        node.append(root)
      } else if (block.kind === 'tool') {
        node = createToolNode(block)
      } else {
        node = document.createElement('article')
        node.className = 'block'
        node.dataset.kind = 'reasoning'
        createThink(node)
      }
      blocks.set(block.key, node)
      placeBlock(node, block.kind)
    }
    if (block.kind !== 'tool') node.dataset.state = block.running ? 'running' : 'ok'
    // A folded turn keeps only the final answer visible (Harness turn-process fold).
    node.toggleAttribute('data-response', block.response === true)
    if (block.kind === 'user') {
      node.querySelector('.user-bubble').textContent = block.text
    } else if (block.kind === 'reasoning') {
      const summary = reasoningSummary(block.text, block.running === true)
      node.querySelector('.think-summary-text').textContent = summary
      const preview = node.querySelector('.think-summary')
      if (block.running) preview.setAttribute('data-streaming', 'true')
      else preview.removeAttribute('data-streaming')
      node.querySelector('.visually-hidden').textContent = block.running ? messages.running : ''
      renderMarkdownBody(node.querySelector('.think-body'), block.text, { compact: true, live: block.running === true })
      syncThinkPreview(node)
    } else if (block.kind === 'tool') {
      updateToolNode(node, block)
      // A subagent that stopped working is watched in its *own* session and reported from there: the flag
      // this block carries is false even when the subagent failed. See `isSubagentTool`.
    } else {
      updateAssistantNode(node, block)
    }
    speakWhenFinished(block)
  }

  /**
   * Transcript events apply in arrival order on one animation frame, so a turn
   * marker never lands before the blocks queued ahead of it, and the view only
   * scrolls when the reader is already at the bottom.
   */
  const staged = []
  let stagedFrame
  function stage(message) {
    staged.push(message)
    stagedFrame ??= requestAnimationFrame(() => {
      stagedFrame = undefined
      const list = staged.splice(0)
      const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120
      // The transcript moved, so any block's claim to be running is fresh again. See `agentPhase`.
      if (list.length > 0) transcriptAt = Date.now()
      for (const item of list) {
        if (item.type === 'block') upsertBlock(item)
        else if (item.type === 'block-drop') removeBlock(item.key)
        else if (item.type === 'turn') setRunning(item.running === true, item.interrupted === true, item.failed === true)
        else if (item.type === 'reset') clearTranscript()
      }
      syncAgent()
      // A stale block produces no further messages — that is what stale means — so the repaint that takes the
      // face off has to be scheduled rather than waited for. Clearing the timer on every message keeps this to
      // one pending check at a time, which is also why it is not a repeating interval.
      clearTimeout(staleAgentTimer)
      staleAgentTimer = setTimeout(syncAgent, STALE_BLOCK_MS + 250)
      if (nearBottom) transcript.scrollTop = transcript.scrollHeight
    })
  }

  function removeBlock(key) {
    const node = blocks.get(key)
    if (node === undefined) return
    blocks.delete(key)
    blockData.delete(key)
    // The button map is strong, so a dropped reply would keep its entry — and its node — alive for
    // as long as the session lasts.
    speechButtons.delete(key)
    node.remove()
  }

  function renderHistory() {
    historyList.replaceChildren()
    if (historyItems.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'history-empty'
      empty.textContent = messages.historyEmpty
      historyList.append(empty)
      return
    }
    for (const item of historyItems) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = item.sessionId === sessionId ? 'history-row current' : 'history-row'
      button.setAttribute('role', 'option')
      button.setAttribute('aria-selected', String(item.sessionId === sessionId))
      button.textContent = typeof item.title === 'string' && item.title !== '' ? item.title : messages.untitled
      button.addEventListener('click', () => {
        setHistoryOpen(false)
        if (item.sessionId !== sessionId) api.openSession(item.sessionId)
      })
      historyList.append(button)
    }
  }

  function clearTranscript() {
    stopProcessClock()
    processGroup = undefined
    blocks.clear()
    blockData.clear()
    transcript.replaceChildren()
    pending = undefined
    syncQuestion()
  }

  function setHistoryOpen(next) {
    historyOpen = next
    historyList.hidden = !historyOpen
    historyButton.setAttribute('aria-pressed', String(historyOpen))
    if (historyOpen) {
      renderHistory()
      api.requestHistory()
      setPermissionOpen(false)
    }
    syncQuestion()
  }

  function setPermissionOpen(next) {
    permissionOpen = next
    permissionMenu.hidden = !permissionOpen
    permissionButton.setAttribute('aria-expanded', String(permissionOpen))
  }

  function renderPermission() {
    permissionLabel.textContent = permissionText(permission)
    for (const option of permissionMenu.querySelectorAll('button')) {
      option.setAttribute('aria-selected', String(option.dataset.preset === permission))
    }
  }

  function syncContinue() {
    const draft = pending.drafts[pending.index]
    questionContinue.textContent = pending.index === pending.questions.length - 1
      ? messages.submit
      : messages.next
    questionContinue.disabled = pending.busy || !draftAnswered(draft)
    questionSkip.disabled = pending.busy
    questionCancel.disabled = pending.busy
    questionPrev.disabled = pending.busy || pending.index === 0
    questionNextNav.disabled = pending.busy || pending.index === pending.questions.length - 1
    questionCustom.disabled = pending.busy
    questionCustom.hidden = false
    questionCustom.placeholder = messages.custom
    if (document.activeElement !== questionCustom) questionCustom.value = draft.custom
  }

  function renderQuestion() {
    const item = pending.questions[pending.index]
    const draft = pending.drafts[pending.index]
    const hasHeader = typeof item.header === 'string' && item.header !== ''
    questionEyebrow.hidden = !hasHeader
    questionEyebrow.textContent = hasHeader ? item.header : ''
    questionTitle.textContent = item.question
    const hasDetail = typeof item.detail === 'string' && item.detail !== ''
    questionDetail.hidden = !hasDetail
    questionDetail.textContent = hasDetail ? item.detail : ''
    questionOptions.replaceChildren()
    const options = item.options ?? []
    questionOptions.setAttribute('role', item.multiSelect === true ? 'group' : 'radiogroup')
    for (const [optionIndex, option] of options.entries()) {
      const selected = draft.selected.includes(option.label)
      const display = parseRecommendedLabel(option.label)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = selected ? 'question-option selected' : 'question-option'
      button.setAttribute('role', item.multiSelect === true ? 'checkbox' : 'radio')
      button.setAttribute('aria-checked', String(selected))
      button.disabled = pending.busy
      const mark = document.createElement('span')
      mark.className = 'question-option-mark'
      mark.textContent = item.multiSelect === true ? (selected ? '\u2713' : '') : String(optionIndex + 1)
      const copy = document.createElement('span')
      copy.className = 'question-option-copy'
      const label = document.createElement('span')
      label.className = 'question-option-label'
      label.textContent = display.label
      copy.append(label)
      if (display.recommended) {
        const badge = document.createElement('span')
        badge.className = 'question-recommended'
        badge.textContent = messages.recommended
        copy.append(badge)
      }
      if (typeof option.description === 'string' && option.description !== '') {
        const description = document.createElement('span')
        description.className = 'question-option-description'
        description.textContent = option.description
        copy.append(description)
      }
      button.append(mark, copy)
      button.addEventListener('click', () => { chooseOption(option.label) })
      questionOptions.append(button)
    }
    questionPager.hidden = pending.questions.length <= 1
    questionProgress.textContent = `${String(pending.index + 1)} / ${String(pending.questions.length)}`
    const hasError = typeof pending.error === 'string' && pending.error !== ''
    questionError.hidden = !hasError
    questionError.textContent = hasError ? pending.error : ''
    syncContinue()
  }

  function syncQuestion() {
    const showCard = pending !== undefined && !historyOpen
    document.body.classList.toggle('asking', pending !== undefined)
    questionRoot.hidden = !showCard
    transcript.hidden = historyOpen
    if (showCard) renderQuestion()
    syncGif()
  }

  function chooseOption(label) {
    if (pending === undefined || pending.busy) return
    const item = pending.questions[pending.index]
    const draft = pending.drafts[pending.index]
    if (item.multiSelect === true) {
      draft.selected = draft.selected.includes(label)
        ? draft.selected.filter((entry) => entry !== label)
        : [...draft.selected, label]
    } else {
      draft.selected = [label]
      draft.custom = ''
      if (pending.index < pending.questions.length - 1) pending.index += 1
    }
    draft.skipped = false
    pending.error = undefined
    renderQuestion()
  }

  function submitPending() {
    const missing = pending.drafts.findIndex((draft) => !draftCompleted(draft))
    if (missing >= 0) {
      pending.index = missing
      pending.error = messages.incomplete
      renderQuestion()
      return
    }
    pending.busy = true
    pending.error = undefined
    renderQuestion()
    api.answerQuestion(pending.id, buildAnswer(pending.questions, pending.drafts).answers)
  }

  function continueFlow() {
    if (pending === undefined || pending.busy) return
    const draft = pending.drafts[pending.index]
    if (!draftAnswered(draft)) {
      pending.error = messages.unanswered
      renderQuestion()
      return
    }
    if (pending.index < pending.questions.length - 1) {
      pending.index += 1
      pending.error = undefined
      renderQuestion()
      return
    }
    submitPending()
  }

  function skipQuestion() {
    if (pending === undefined || pending.busy) return
    pending.drafts[pending.index] = { selected: [], custom: '', skipped: true }
    pending.error = undefined
    if (pending.index < pending.questions.length - 1) {
      pending.index += 1
      renderQuestion()
      return
    }
    submitPending()
  }

  function cancelQuestion() {
    if (pending === undefined || pending.busy) return
    pending.busy = true
    pending.error = undefined
    renderQuestion()
    api.cancelQuestion(pending.id)
  }

  function showQuestion(payload) {
    if (!payload || typeof payload.id !== 'string' || !Array.isArray(payload.questions) || payload.questions.length === 0) return
    // The face is played before the card is built, and on the repeat path as well: a payload for the
    // question already on screen is still the agent asking, and what a repeat restarts is the six
    // seconds — never a second instance, because this slot owns a single image and a single timer.
    playAskFrame()
    if (pending?.id === payload.id) {
      syncQuestion()
      return
    }
    pending = { id: payload.id, questions: payload.questions, drafts: emptyDrafts(payload.questions), index: 0, busy: false }
    setHistoryOpen(false)
    syncQuestion()
    void setExpanded(true)
  }

  function clearQuestion(id) {
    if (pending === undefined || pending.id !== id) return
    pending = undefined
    syncQuestion()
  }

  function isPrimaryButton(event) {
    return event.button === 0
  }

  function primaryButtonHeld(event) {
    return (event.buttons & 1) === 1
  }

  // Hovering means "the pointer is on the ball or the open panel", not "the pointer is inside the
  // window". Those were the same thing when the resting window was the ball and its two insets;
  // now that the window is the overlay rect in both states, `pointerenter` on the body would fire
  // from anywhere in a 742×544 rectangle and open the panel when the pointer was nowhere near it.
  //
  // So the same rectangles the main process captures over are asked directly: a point inside the
  // ball or the panel is on ours, and a point in the empty part of the window is not. The ball is
  // a circle, and its bounding box is the only honest test a rectangle-based check can do — the
  // corners of that box are transparent and always were, so nothing is lost by saying so.
  //
  // The panel counts as hovered so that crossing the 10px gap between ball and panel does not
  // collapse it: `COLLAPSE_MS` would usually cover the crossing anyway, but "usually" is not a
  // reason to let a slow pointer fall through a gap the page drew.
  function pointerOnBallOrPanel() {
    const at = pointerAt
    if (at === undefined) return false
    if (inside(ball.getBoundingClientRect(), at)) return true
    if (!expanded) return false
    return inside(panel.getBoundingClientRect(), at)
  }

  function inside(rect, at) {
    return rect.width > 0 && rect.height > 0
      && at.clientX >= rect.left && at.clientX <= rect.right
      && at.clientY >= rect.top && at.clientY <= rect.bottom
  }

  function applyHover(next) {
    if (next === hovering) return
    hovering = next
    if (next) startHoverIntro()
    else stopHoverIntro()
    syncGif()
  }

  /**
   * The pointer arrived on the ball (or the open panel).
   *
   * `pointerenter` works again now that the main process polls the pointer and keeps the window
   * capturing whenever it is over one of our rectangles: an earlier version of this arrangement
   * had the page decide, and a click-through window receives no enter event at all, so the panel
   * could not open. Deciding in the main process is what makes this handler reachable.
   *
   * Nothing is counted here for the docked case, and that is deliberate rather than an oversight. The
   * docked branch below never sets `hovering`, so the `pointermove` de-duplication
   * (`if (on === hovering) return`) cannot fire for a hand on the strip: every pixel that hand moves
   * arrives here, and the main process's own 30Hz pointer feed arrives here too, from the other side.
   * All of those are the *same* hover, and `beginDockArrive` is what tells them apart — it refuses to
   * re-arm the dwell while a peek, a wait, or a clip is already standing, which is what stops a
   * resting hand from replaying the entrance. A leave clears all three, so a hand that comes back is
   * greeted again every time. Counting entries here instead would have to swallow that second greeting
   * to work at all, and the second greeting is the strip's whole purpose.
   */
  function enterUi() {
    dockPointerInside = true
    if (docked !== undefined) {
      // Docked, the pointer can only be on the strip, and the strip does one thing: it brings the
      // ball half way out of the edge as a hint that there is something behind it, and after a short
      // rest it plays the arrival clip on it. Coming back out is a drag on the strip (`dockTab`'s own
      // listeners) and nothing else — a hover that unsnapped would make the ball jump out from under
      // a pointer that was only passing by.
      //
      // `applyHover(true)` is deliberately *not* called here. The hover intro it starts is a face
      // the visible ball wears, and the ball is hidden behind the strip while docked — a docked
      // hover playing it would be a "greeting" that answers a hand resting on a strip, played on a
      // ball nobody can see, and then thrown over by the arrival clip the strip is actually for.
      // The strip's own greeting is `beginDockArrive()` alone.
      beginDockArrive()
      return
    }
    applyHover(true)
    if (dragging || collapsing) return
    if (suppressExpand) return
    void setExpanded(true)
  }

  /** And this is the pointer leaving, which is what collapses the panel again. */
  function leaveUi() {
    dockPointerInside = false
    // A hand crossing the strip is not a hover, and the clip is a whole gesture: anything still
    // waiting to start is dropped here — the dwell included, which is the half that makes "crossed"
    // different from "rested" — and the clip already playing is taken down rather than left running
    // on a strip the pointer has abandoned. The peek goes with it: the ball was only ever out
    // because the pointer was here.
    clearDockHoverTimer()
    clearDockArrive()
    void closeDockPeek()
    applyHover(false)
    suppressExpand = false
    if (dragging || collapsing) return
    scheduleCollapse()
  }

  /**
   * Arm the arrival clip for a pointer that has just come to rest on the strip, and bring the ball
   * half way out of the edge on the way.
   *
   * The dwell is a timer rather than a test of how long the pointer took to arrive, because the
   * question is whether it is *still* here {@link DOCK_ARRIVE_DWELL_MS} later, and only the timer can
   * answer that. Every entry arms a fresh one — the clip plays on every hover, which is what the
   * strip is for — and each is dropped on its own terms: `leaveUi` clears it on the way out, and the
   * callback re-checks that the pointer is still inside and the ball still docked before it fires.
   *
   * The two are ordered on purpose: the ball *shows* first and the clip follows it, which is the
   * order the hover reads in — the strip has something behind it, and then that something greets
   * you. It is also why the peek is not on a timer of its own; being able to see what you are
   * hovering is the affordance, not the greeting.
   *
   * The press that drags the ball out does not go through here and does not wait for it.
   */
  function beginDockArrive() {
    // The hover pull-out is being retired, and this is the whole of it: the peek that slides the ball out and the
    // arrival clip that greets it are two halves of one gesture, so pausing either alone would leave the other
    // showing. Off here means a hover on the strip does nothing at all — the ball stays where it is, wearing what
    // it was wearing. Set {@link DOCK_HOVER_ENABLED} back to `true` to bring the whole gesture back.
    if (!DOCK_HOVER_ENABLED) return
    // A peek that is already open has had its entrance armed and is playing it. The helper's own
    // pointer feed calls `enterUi` again the moment the grown window starts reporting the ball's own
    // rect — which is right after the peek reported its new hit-test regions — and without this the
    // whole arrival restarts on that crossing: a second step a couple of hundred ms after the first,
    // which reads as a stutter rather than a greeting. So a hover that is already being served only
    // makes sure the ball is out.
    //
    // The flag in `enterUi` is what normally gets there. This is the belt to that braces, for the one
    // window the flag cannot cover: between a leave and the next entry the strip can report "on it"
    // twice, and both must be one hover. `dockArriveShown` is also checked so that a clip already up —
    // with the slot's `loop` clip it stays up for the rest of the hover — is never restarted.
    if (dockPeeked || dockHoverTimer !== undefined || dockArriveShown !== undefined) {
      void openDockPeek()
      return
    }
    void openDockPeek()
    clearDockHoverTimer()
    dockHoverTimer = setTimeout(() => {
      dockHoverTimer = undefined
      if (!dockPointerInside || docked === undefined) return
      playDockArrive()
    }, DOCK_ARRIVE_DWELL_MS)
  }

  // While the ball is docked these two ask about the strip instead. That is the only thing on screen
  // then, and `pointerOnBallOrPanel()` cannot see it: the ball and the card are hidden and drawn at
  // `--ball-column` inside a 34px window, so every point of that window answers "no" and the page
  // would never learn that a hand had arrived on the one control it has left.
  //
  // A peeked ball is an exception of its own, and it needs naming for the opposite reason to the
  // strip: the ball is back on screen while the peek is up, so the ordinary test *would* find it —
  // but `docked` is still set, so the strip branch answers "no" for it, and the peek would dismiss
  // itself the moment the hand moved from the strip toward the ball it had just revealed. So while
  // the ball is showing, it counts too.
  //
  // It counts with slack, and the slack is the point. The ball sits flush against the screen's inner
  // edge, so its boundary is the last column of pixels a hand can occupy before it is off the ball —
  // and leaving is what dismisses the peek. One pixel of tremor there flips the answer, the ball goes
  // back behind the strip, the strip is then the only thing under the hand, and the next pixel brings
  // it out again: the flicker, from a hand that never left. So the exit test is the ball's rect grown
  // by `DOCK_PEEK_RELEASE_PX`, while the strip's own band is untouched — entering still takes the
  // strip, and only leaving takes the wider box. Between the two bars nothing changes, which is what
  // makes a resting hand stable.
  function pointerOnUi(point) {
    if (docked === undefined) return pointerOnBallOrPanel()
    if (dockPeeked && point !== undefined) {
      const rect = ball.getBoundingClientRect()
      const slack = DOCK_PEEK_RELEASE_PX
      if (rect.width > 0 && rect.height > 0
        && point.clientX >= rect.left - slack && point.clientX <= rect.right + slack
        && point.clientY >= rect.top - slack && point.clientY <= rect.bottom + slack) return true
    }
    return pointerInDockBand(point)
  }

  document.body.addEventListener('pointerenter', (event) => {
    pointerAt = event
    if (!pointerOnUi(event)) return
    enterUi()
  })
  document.body.addEventListener('pointermove', (event) => {
    pointerAt = event
    const on = pointerOnUi(event)
    if (on === hovering) return
    if (on) enterUi()
    else leaveUi()
  })
  document.body.addEventListener('pointerleave', () => {
    pointerAt = undefined
    leaveUi()
  })

  // The main process's own account of the pointer, sent when the window starts and stops capturing.
  // The handlers above are the normal path — a hand crossing the boundary generates the event. This
  // is the path for a pointer that does not: it crossed and stopped, so no further event is coming,
  // and without this the panel would be left open with the pointer gone, or shut with the pointer
  // resting on the ball. It reuses the same `pointerOnBallOrPanel()` test, so there is one answer to
  // "is the pointer on us" rather than two that can disagree.
  if (typeof api.onPointer === 'function') {
    api.onPointer((point) => {
      pointerAt = point ?? undefined
      if (point === null) {
        leaveUi()
        return
      }
      if (pointerOnUi(point)) enterUi()
      else leaveUi()
    })
  }

  ball.addEventListener('pointerdown', (event) => {
    if (!isPrimaryButton(event)) return
    dragging = false
    // A press on the ball is the drag that *does* wear the carry face, so whatever the last carry
    // was, this one starts as a ball press. Cleared here rather than on release so that a gesture
    // which never released cleanly — a lost capture, a page reload mid-drag — cannot leave the next
    // ball drag faceless.
    carriedFromDock = false
    // And the ball's press is the other kind of drag, so the undock's "the hand does not carry it" is
    // cleared with it. The two flags are set together by the pull and must be unset together, or a
    // pull that ended badly would leave the next ball drag ignoring the hand.
    undocking = false
    collapsing = false
    skipClick = false
    lastOrigin = undefined
    pointer = { ...ballGrabOffset(event), startX: event.screenX, startY: event.screenY }
    ball.setPointerCapture(event.pointerId)
    // The window has to hold the pointer for the whole drag, and the main process only knows the
    // regions this reports — so the regions have to be widened before the pointer can outrun them.
    syncHitTest()
  })
  ball.addEventListener('pointermove', (event) => {
    if (pointer === undefined) return
    if (!primaryButtonHeld(event)) {
      void finishPointer(event)
      return
    }
    lastOrigin = { x: event.screenX - pointer.dx, y: event.screenY - pointer.dy }
    if (!dragging) {
      if (Math.hypot(event.screenX - pointer.startX, event.screenY - pointer.startY) <= 4) return
      dragging = true
      // The lift plays once, then the hang loop takes over for the rest of the carry.
      // Started here rather than on pointerdown because a press that never moves is a click,
      // not a pickup — the ball is not carried and must not wear the carry face.
      startDragIntro()
      // The drag face is state, not a one-shot: it leaves when the pointer does.
      syncGif()
      if (running || asking()) {
        void moveBall(lastOrigin.x, lastOrigin.y)
        return
      }
      collapsing = true
      pinned = false
      document.body.classList.remove('pinned')
      void setExpanded(false, true).then(() => {
        collapsing = false
        if (dragging && lastOrigin !== undefined) void moveBall(lastOrigin.x, lastOrigin.y)
      })
      return
    }
    if (!collapsing) void moveBall(lastOrigin.x, lastOrigin.y)
  })
  async function finishPointer(event) {
    if (dragging) {
      skipClick = true
      dragging = false
      collapsing = false
      // The carry is over, so the pickup must not outlive it: a release partway through the
      // lift would otherwise leave its timer running and re-sync the page while the ball rests.
      stopDragIntro()
      const origin = pointer === undefined
        ? lastOrigin
        : { x: event.screenX - pointer.dx, y: event.screenY - pointer.dy }
      pointer = undefined
      lastOrigin = undefined
      dockSide = undefined
      undocking = false
      const skipDock = skipDockCommit
      skipDockCommit = false
      // The release position is asked for before the face changes: the ball has to end up
      // where the pointer let it go even when loading the next GIF costs this page a frame.
      const landed = skipDock || origin === undefined ? undefined : moveBall(origin.x, origin.y)
      syncGif()
      // The other half of the carry. It is played after the redraw above rather than instead of
      // it, so a drop frame that is not cached yet leaves the ball repainting to its resting pose
      // immediately instead of freezing on the drag face until the read comes back.
      playDropFrame()
      // The drag is over, so the window goes back to capturing over the elements alone. Reported
      // after the move and the clamp, both of which can dock and change the answer.
      if (landed !== undefined) {
        await landed
        await clampBall()
      }
      syncHitTest()
      return true
    }
    pointer = undefined
    lastOrigin = undefined
    dockSide = undefined
    undocking = false
    syncHitTest()
    return false
  }
  ball.addEventListener('pointerup', async (event) => {
    if (!isPrimaryButton(event)) {
      void finishPointer(event)
      return
    }
    const dragged = await finishPointer(event)
    if (dragged || skipClick) {
      skipClick = false
      return
    }
    // A real click (never a drag): pat the ball. Pinning still behaves as before.
    playClickFrame()
    pinned = !pinned
    document.body.classList.toggle('pinned', pinned)
    if (pinned) await setExpanded(true)
  })
  ball.addEventListener('pointercancel', (event) => { void finishPointer(event) })
  ball.addEventListener('lostpointercapture', (event) => { void finishPointer(event) })

  dockTab.addEventListener('pointerdown', (event) => {
    if (!isPrimaryButton(event)) return
    dragging = false
    // This press may or may not become a pull — a nudge along the strip never crosses the threshold
    // and never hands over — so the flag is cleared here and set only by the hand-off itself.
    carriedFromDock = false
    // Likewise the hand's own two states: a press on the strip starts with the ball not in the hand
    // and not being slid, and it is the threshold that decides which of the two it becomes.
    undocking = false
    collapsing = false
    skipClick = true
    lastOrigin = undefined
    // The side this pull is anchored on, captured here and kept for the whole gesture. `docked` is
    // the live state and the hand-off clears it, so the direction of the pull cannot be read off it
    // once the ball is out — and the direction is what tells a pull away from the edge apart from a
    // nudge along it.
    dockSide = docked
    lastScreenX = event.screenX
    lastScreenY = event.screenY
    lastClientX = event.clientX
    lastClientY = event.clientY
    pointer = { dx: 0, dy: 0, startX: event.screenX, startY: event.screenY }
    dockTab.setPointerCapture(event.pointerId)
    // Before the drag can outrun it, exactly as the ball's own press does: the window is only
    // capturing over the rects this reports, and the pull that takes the ball back out immediately
    // leaves the 34px strip. Reported late, those moves are never delivered and the gesture dies at
    // the edge it started on.
    syncHitTest()
  })
  dockTab.addEventListener('pointermove', (event) => {
    // A live gesture is `pointer` *and* either a dock to pull away from or a ball already in the
    // hand. `docked` alone will not do: the hand-off below un-docks the ball on the move that
    // crosses the threshold, so from the very next event there is no dock left to measure `inward`
    // from — and a guard that asked for one would drop every move after the first, leaving the ball
    // sitting at the hand-off point while the hand carried on without it. That is the whole of what
    // "the ball does not follow me out of the dock" was.
    if (pointer === undefined || (docked === undefined && !dragging)) return
    if (!primaryButtonHeld(event)) {
      void finishPointer(event)
      return
    }
    // The side the gesture started on, held for the whole pull. It cannot be read off `docked`,
    // which is gone by the second move, and a direction that flips halfway through the gesture is a
    // threshold measured against the wrong edge — on a right dock it would read every move outwards.
    const fromRight = dockSide === 'right'
    const inward = dragging
      ? 0
      : fromRight ? pointer.startX - event.screenX : event.screenX - pointer.startX
    // Where the pointer was before this move, which is where the pull crossed the threshold if it
    // crossed it here — a coalesced jump has to leave the ball under the hand, not behind it.
    const wasScreenX = lastScreenX
    const wasScreenY = lastScreenY
    const wasClientX = lastClientX
    const wasClientY = lastClientY
    lastScreenX = event.screenX
    lastScreenY = event.screenY
    lastClientX = event.clientX
    lastClientY = event.clientY
    // The pull is not over when the threshold is crossed — it has only just been recognised. And on
    // this gesture it is over as far as the ball's *position* goes: the undock below is the whole of
    // the motion, and the hand does not take the ball afterwards. See {@link undocking}.
    if (inward > DOCK_DRAG_OFF_PX && !dragging) {
      handDockDragToBall({ screenX: wasScreenX, screenY: wasScreenY, clientX: wasClientX, clientY: wasClientY })
      return
    }
    if (!dragging || collapsing) return
    // A pull out of the dock stops here: the ball is travelling in under the helper's slide, and the
    // pointer has no say in where it goes. Both halves matter — the move that crossed the threshold
    // is not applied either, for the same reason. A `moveBall` at any point of the slide overwrites
    // `this.origin` and bumps the animation generation, so the ball is teleported to the pointer and
    // the travel the user is watching is cut off at whatever frame it had reached.
    //
    // Nothing is lost by ignoring the moves. They are not what brings the ball in — the slide is, and
    // it lands on the ball's docked slot under its own easing. Were the follow wanted back, this is
    // the guard to drop: the hand-off's own centre grab is still taken below, and the next move would
    // take the ball over mid-slide from wherever the slide had reached.
    if (undocking) return
    // Carried by the pointer rather than by a `lastOrigin` of the tab's own: while undocked the ball
    // is on the desktop with the hand, and this is the same `screen - offset` the ball's own move
    // handler computes, so the two gestures cannot disagree about where it is.
    void moveBall(event.screenX - pointer.dx, event.screenY - pointer.dy)
  })
  dockTab.addEventListener('pointerup', (event) => { void finishPointer(event) })
  dockTab.addEventListener('pointercancel', (event) => { void finishPointer(event) })
  dockTab.addEventListener('lostpointercapture', (event) => { void finishPointer(event) })

  /**
   * Take the ball out of its dock, at the moment the pull crosses `DOCK_DRAG_OFF_PX`: it undocks and
   * slides back on screen, and the drop plays across the whole of that travel.
   *
   * Pointer capture stays on the strip and the strip keeps the listeners: it is the element the
   * press started on, so it is the element that keeps receiving moves. All this has to do is stop
   * being docked and hand the motion to the helper — `dragging` is the ball's own flag, and the block
   * at the top of `syncGif` reads it, which is what makes the ball visible again the moment the
   * `docked` class comes off.
   *
   * Where the ball *goes* is the helper's, not the hand's: `unsnapDockedSmooth` slides it in from
   * behind the edge, and the moves that arrive after this are ignored. See {@link undocking} for the
   * feel that pairing is for; the short version is that a pull out of the dock is an undock and not a
   * carry, so the ball travels inward under its own easing instead of tracking the pointer.
   *
   * The face it comes out wearing is the drop, and it is the only face a pull out of the dock ever
   * shows: there is no pickup (拎起) because there is no pose to lift out of, and no hang loop (悬空)
   * because the ball was never handed to the hand — it fell out of the strip. See the note in the
   * body, and {@link carriedFromDock} for why that is a flag of its own rather than a change to
   * `dragging`. The release that may follow plays the drop again, so the whole gesture is 下落 either
   * side of the pointerup, and the resting loop in between.
   *
   * The landing point below is the ball's *docked slot*, computed from the bar the same way the helper
   * computed it, with no nudge. Computing it rather than reusing the bar is the point: the bar is a
   * 6px sliver against an edge and the ball is parked a ball's width in from that edge on the right,
   * so the two are only ever close on the left. The slot is also clear of the `DOCK_OVERLAP` re-dock
   * line by construction, which is what a release needs — a ball put down on the bar itself would be
   * a ball at the edge, and `clampBall` docks anything overlapping the edge by that much.
   *
   * The slot is what the helper's slide is aimed at, so `lastOrigin` and the slide agree on where the
   * pull ends. The offset it leaves in `pointer` is the ball's *centre*, and it is the one thing here
   * that is parked rather than used: see {@link undocking} — with the moves ignored there is nothing
   * to subtract it from, and it is kept because it is exactly what would make the ball follow the
   * hand again.
   */
  function handDockDragToBall() {
    const side = docked
    // The bar's own box, which is also the ball's: the strip is the docked ball's slot against the
    // edge, and both sit `DOCK_GLOW` in from the window's edge — the CSS `top` on the tab mirrors
    // `dockedTabBounds` in `geometry.ts`. Read from the element rather than restated here, because
    // the page has no copy of either number, and all the grab has to be is right relative to the bar.
    const bar = dockTab.getBoundingClientRect()
    // Page coordinates to the screen coordinates `orb:move` is expressed in. `getBoundingClientRect`
    // measures in the viewport, while a drag's position is `screenY` — and the two differ by the
    // window's own origin, which is the pointer's `screen - client` exactly.
    const toScreenX = lastScreenX - lastClientX
    const toScreenY = lastScreenY - lastClientY
    // The ball's docked slot, on the screen. `insideBallOrigin` in `geometry.ts` is what this has to
    // reproduce, and it is a constant in from the *display* edge: `DOCK_IN_PAD` for a left dock,
    // `DOCK_IN_PAD + BALL_SIZE` for a right one. The bar is the only thing here that knows where the
    // display edge is, and it knows it from a fixed side for each dock: the strip's box is flush with
    // the edge, so the edge is the box's `left` on a left dock and its `right` on a right one — the
    // box is `DOCK_HIT_WIDTH` wide and its bar is drawn in the edge-most 6px, but the bar's own box
    // is not the ball's, and taking the wrong edge is a whole ball's width of error.
    //
    // That wrong edge is the bug this replaces. It anchored on the box's `right` for *both* sides,
    // which on a right dock is the display edge itself, and then set the ball a width back from it —
    // so a right-docked ball was handed over at `display.right - BALL_SIZE` instead of
    // `display.right - BALL_SIZE - DOCK_IN_PAD`: `DOCK_IN_PAD` out, on the far side of the whole
    // `DOCK_OVERLAP` line, so a release re-docked the ball and the grab offset inherited the error
    // for every move of the drag. On the left the same anchor happened to be close, which is why the
    // left dock never showed it.
    //
    // `DOCK_HANDOFF_MARGIN_PX` gave the ball a nudge in from the slot and is gone: it existed to keep
    // the ball clear of the `DOCK_OVERLAP` re-dock line, and with the grab on the centre the ball is
    // at the pointer's own x from the next move on, which is well inside that line wherever a hand
    // pulls from. See the note on the constant.
    const edge = (side === 'left' ? bar.left : bar.right) + toScreenX
    const x = side === 'left'
      ? edge + DOCK_IN_PAD
      : edge - DOCK_IN_PAD - ball.getBoundingClientRect().width
    // `bar.top + toScreenY` is the ball's row already, with nothing to subtract: the strip's own box
    // is drawn `DOCK_TAB_INSET` down from the window's top edge, and `dockedTabBounds` puts the
    // window `DOCK_GLOW` above the ball's row — two equal constants that cancel. It used to subtract
    // `DOCK_TAB_INSET` as well, which left the ball 8px high on every pull out of the dock: half of
    // the same mistake as the x, in the axis nobody was looking at.
    const y = bar.top + toScreenY
    // The grab is taken on the ball's *centre*, and that is the whole of the feel this hand-off has.
    //
    // `dx`/`dy` are what every later move subtracts from the pointer to get the ball's top-left, so
    // writing them as `half` — the pointer-to-centre offset of a `BALL_SIZE` square — puts the centre
    // on the pointer and keeps it there: `screen - half` is the top-left that centres the ball, on
    // every move of the drag. The other reading, `dx` measured to the ball's own corner, is the ball's
    // *top-left* tracking the hand, which is what made a pull read as the whole ball sliding out from
    // under the edge and then trailing the cursor by a half-width.
    //
    // It is the same grab the ball's own press takes (see `ballGrabOffset`): you drag a thing by the
    // point you are holding. The strip is 34px against the screen edge, so the point actually held is
    // not the centre — but the ball is hidden while docked and has no drawn point to take hold of, and
    // the centre is the handle a hand reaching for a ball is aiming at. A pull that crossed the
    // threshold by `DOCK_DRAG_OFF_PX` therefore comes out with the ball already under the hand, and
    // the half-width of overhang that leaves past the edge is the next move's business, not this one's.
    //
    // The ball's *placement* and its *grab* stay two separate answers, and this is the pair of lines
    // that keeps them apart: `lastOrigin` is where the ball is put — the helper's docked slot, so the
    // release that may follow cannot re-dock it on the far side of `DOCK_OVERLAP` — while `pointer` is
    // how it follows.
    //
    // `lastOrigin` is only read by `finishPointer` when `pointer` is `undefined`, which cannot happen
    // while this drag is live — so what it really records is where the ball is *meant* to end up if
    // the slide out is never interrupted. The slide is aimed at the same slot from the helper's side
    // (`insideBallOrigin`), which is the agreement that matters: the ball arrives under the hand
    // whether the hand moved or not.
    const half = ball.getBoundingClientRect().width / 2
    lastOrigin = { x, y }
    pointer = { dx: half, dy: half, startX: pointer.startX, startY: pointer.startY }
    dragging = true
    dockPointerInside = false
    // Undocking is the page's own state change and the helper's: `applyDocked(undefined)` takes the
    // `docked` class off — which is what makes the ball visible again — and asks the helper to slide
    // it back on screen from behind the edge, over `DOCK_SLIDE_OUT_MS` and with the same easing the
    // docking-in used. That slide is the whole of the ball's motion on this gesture; see
    // {@link undocking} for why the hand does not take it over.
    //
    // It is called here, *after* `dragging`, for the one thing that ordering decides: `unsnapDocked`
    // sets `skipDockCommit` only when a drag is already in progress, and that flag is what stops the
    // release from moving the ball. Called before `dragging`, the pull-out would end with the ball
    // put under the cursor — the follow arriving by the back door, on the release rather than on a
    // move, which is the harder of the two to notice.
    void unsnapDockedSmooth()
    // This pull is not a carry: the ball undocks and travels, and the hand does not drag it.
    undocking = true
    // This carry wears no face of its own, and the drop is the one that belongs to it.
    //
    // There is nothing to lift out of: the ball was hidden behind the strip a moment ago, and what
    // this gesture is about is the ball coming back on screen — not being held. So the pickup (拎起)
    // is not played, and neither is the hang loop (悬空) that the pickup normally leads into: a ball
    // hanging from a hand that is not carrying it reads as a pose with no cause. What the hand
    // actually did was pull the ball off the edge, and the clip for that is the drop (下落).
    //
    // The drop and the slide are one motion rather than two. `unsnapDockedSmooth` above is bringing
    // the ball inward, and this clip plays across the whole of it, which is the feel this pairing
    // exists for: 下落 while it comes back on screen.
    //
    // It is the same clip the release plays, and playing it twice in one gesture is the point rather
    // than a stutter: coming out of the dock is the fall from the strip, letting go is the fall to
    // wherever it lands, and both are the ball dropping. `playDropFrame` restarts its own one-shot on
    // every call, so the second one is a fresh pass rather than the tail of the first.
    carriedFromDock = true
    playDropFrame()
    // `syncGif` is still called: the drop is only half of what this has to report, and the ball's
    // own visibility comes from the `docked` class coming off rather than from the frame.
    syncGif()
  }

  const selectionChip = document.querySelector('#selection-chip')
  const selectionChipText = document.querySelector('#selection-chip-text')
  const selectionChipDismiss = document.querySelector('#selection-chip-dismiss')
  selectionChipDismiss.textContent = '\u00d7'
  const tccGate = document.querySelector('#tcc-gate')
  const tccDismiss = document.querySelector('#tcc-dismiss')
  const tccTitle = document.querySelector('#tcc-title')
  const tccApp = document.querySelector('#tcc-app')
  const tccScreenStatus = document.querySelector('#tcc-screen-status')
  const tccScreenOpen = document.querySelector('#tcc-screen-open')
  const tccAccessibilityStatus = document.querySelector('#tcc-accessibility-status')
  const tccAccessibilityOpen = document.querySelector('#tcc-accessibility-open')
  const tccFooter = document.querySelector('#tcc-footer')
  const tccLater = document.querySelector('#tcc-later')
  tccDismiss.textContent = '\u00d7'
  document.querySelector('#tcc-relaunch').hidden = true

  function setAttachedSelection(text) {
    attachedSelection = text
    const show = text !== ''
    selectionChip.hidden = !show
    document.body.classList.toggle('has-selection-chip', show)
    selectionChipText.textContent = text
    syncGif()
  }

  function tccReady(tccStatus) {
    return tccStatus == null || tccStatus.applicable === false
      || (tccStatus.screen === 'granted' && tccStatus.accessibility === 'granted')
  }

  function tccStatusLabel(state) {
    if (state === 'granted') return messages.tccStatusGranted
    if (state === 'needsRelaunch') return messages.tccStatusNeedsRelaunch
    return messages.tccStatusMissing
  }

  function hideTccGate() {
    tccGateVisible = false
    tccGate.hidden = true
    document.body.classList.remove('tcc-gating')
    syncGif()
  }

  function showTccGate(tccStatus) {
    tccGateVisible = true
    lastTccStatus = tccStatus
    const name = typeof tccStatus.appName === 'string' ? tccStatus.appName : ''
    tccApp.textContent = messages.tccAppHint.replaceAll('{name}', name)
    tccFooter.textContent = messages.tccFooter.replaceAll('{name}', name)
    tccScreenStatus.textContent = tccStatusLabel(tccStatus.screen)
    tccAccessibilityStatus.textContent = tccStatusLabel(tccStatus.accessibility)
    tccScreenOpen.hidden = tccStatus.screen === 'granted'
    tccAccessibilityOpen.hidden = tccStatus.accessibility === 'granted'
    tccGate.hidden = false
    document.body.classList.add('tcc-gating')
    syncGif()
  }

  async function refreshTccGate(options = {}) {
    if (typeof api.tccStatus !== 'function') return true
    let tccStatus
    try {
      tccStatus = await api.tccStatus()
    } catch {
      return true
    }
    if (tccReady(tccStatus)) {
      hideTccGate()
      return true
    }
    if (options.forceShow || tccGateVisible) showTccGate(tccStatus)
    return false
  }

  async function openTccRight(right) {
    if (typeof api.openTcc !== 'function') return
    let tccStatus
    try {
      tccStatus = await api.openTcc(right)
    } catch {
      return
    }
    if (tccReady(tccStatus)) hideTccGate()
    else showTccGate(tccStatus)
  }

  composer.addEventListener('submit', (event) => {
    event.preventDefault()
    void submitComposer()
  })
  async function submitComposer() {
    const text = promptText(prompt).trim()
    if (text === '') return
    if (text.length > PROMPT_LIMIT) {
      status.textContent = messages.tooLong
      return
    }
    const ready = await refreshTccGate({ forceShow: true })
    if (!ready) {
      await setExpanded(true)
      return
    }
    // Acknowledged before the send, not after: the point of the nod is that it answers the hand-over, and
    // waiting for a round trip to a session that may be busy would make it an answer to the reply instead.
    playNodFrame()
    const payload = composeSend(text, attachedSelection)
    clearPrompt()
    setAttachedSelection('')
    setHistoryOpen(false)
    setPermissionOpen(false)
    api.send(payload)
  }
  prompt.addEventListener('input', syncComposerHeight)
  // Typing in the ball's own composer shows the typing frame for a few seconds.
  prompt.addEventListener('input', noteTyping)
  prompt.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || isComposing(event)) return
    event.preventDefault()
    if (typeof composer.requestSubmit === 'function') composer.requestSubmit()
    else composer.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  prompt.addEventListener('paste', (event) => {
    event.preventDefault()
    insertPlainText(prompt, event.clipboardData?.getData('text/plain') ?? '')
    syncComposerHeight()
  })
  composer.addEventListener('click', (event) => {
    if (event.target === composer) prompt.focus()
  })

  for (const preset of PERMISSION_PRESETS) {
    const item = document.createElement('li')
    const option = document.createElement('button')
    option.type = 'button'
    option.dataset.preset = preset
    option.setAttribute('role', 'option')
    option.textContent = permissionText(preset)
    option.addEventListener('click', () => {
      permission = preset
      setPermissionOpen(false)
      renderPermission()
      api.setPermission(preset)
    })
    item.append(option)
    permissionMenu.append(item)
  }
  renderPermission()
  permissionButton.addEventListener('click', (event) => {
    event.stopPropagation()
    setHistoryOpen(false)
    setPermissionOpen(!permissionOpen)
  })
  document.addEventListener('pointerdown', (event) => {
    if (permissionRoot.contains(event.target)) return
    setPermissionOpen(false)
  })
  historyButton.addEventListener('click', () => { setHistoryOpen(!historyOpen) })
  newConversation.addEventListener('click', () => {
    setHistoryOpen(false)
    setPermissionOpen(false)
    api.newSession()
    prompt.focus()
  })
  stop.addEventListener('click', () => { api.stop() })
  questionCancel.addEventListener('click', cancelQuestion)
  questionSkip.addEventListener('click', skipQuestion)
  questionContinue.addEventListener('click', continueFlow)
  questionPrev.addEventListener('click', () => {
    if (pending === undefined || pending.busy || pending.index === 0) return
    pending.index -= 1
    pending.error = undefined
    renderQuestion()
  })
  questionNextNav.addEventListener('click', () => {
    if (pending === undefined || pending.busy || pending.index === pending.questions.length - 1) return
    pending.index += 1
    pending.error = undefined
    renderQuestion()
  })
  questionCustom.addEventListener('input', () => {
    if (pending === undefined || pending.busy) return
    const item = pending.questions[pending.index]
    const draft = pending.drafts[pending.index]
    draft.custom = questionCustom.value
    draft.skipped = false
    if (item.multiSelect !== true) draft.selected = []
    pending.error = undefined
    questionError.hidden = true
    syncContinue()
  })
  questionCustom.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || isComposing(event)) return
    event.preventDefault()
    continueFlow()
  })

  api.onBlock((block) => { stage(block) })
  api.onBlockDrop((key) => { stage({ type: 'block-drop', key }) })
  api.onTurn((turn) => { stage({ type: 'turn', ...(turn ?? {}) }) })
  // News about a turn in a conversation this ball is not in. It is deliberately *not* fed into `stage`: that
  // would move this page's own turn state — and with it the process clock, the tool cards and the bell — for
  // a turn that happened somewhere else. What it does is open a window; `syncGif` decides what to wear for it.
  if (typeof api.onSessionTurn === 'function') {
    api.onSessionTurn((payload) => {
      const outcome = typeof payload?.outcome === 'string' ? payload.outcome : ''
      // `streamed` is the host saying the attempt that was writing has ended, which is the one thing these
      // windows cannot work out for themselves: they count nothing, so without it a face stays up for its whole
      // grace period after the last word. Closing them here is what makes the ball stop typing when the answer
      // does, rather than a couple of seconds later.
      if (outcome === 'streamed') {
        otherStreamAt.clear()
        otherTool = ''
        syncGif()
        return
      }
      // The user handed the agent something to do, in a window that is not this one. Not a window and not a
      // kind: it is an event, so it plays once and returns — the same cue the ball's own composer fires.
      //
      // The typing face deliberately does not ride along. It was tried and taken back out: the DSH window
      // broadcasts nothing while its composer is being typed into — no draft, no keystroke, nothing this plugin
      // can subscribe to — so the only moment available is the send, and a typing face that starts *after* the
      // message has gone says something untrue about what the ball can see. The nod says the true thing: the
      // message arrived.
      if (outcome === 'user') {
        playNodFrame()
        return
      }
      // A turn ended somewhere else, with a reason. Four of the six endings arrive this way; the two that are not
      // turn endings — the question and the approval — ride the same message, because to the ball they are all
      // "something happened over there worth a face".
      if (outcome === 'ended') {
        void playTurnEndFrame(typeof payload?.category === 'string' ? payload.category : '')
        return
      }
      // One kind at a time, and each keeps its own window: the model reasons, writes, then calls a tool, and
      // the page has to be able to tell those apart to know which face — if any — is due.
      if (outcome !== 'typing' && outcome !== 'thinking' && outcome !== 'tool') return
      // A call over there arrives with the tool's name, which is the only way a pack that draws a face per tool
      // can be obeyed from the window the user types in: the ball's own transcript is not this conversation, so
      // its tool cards never reach this page and the name has to come over the wire. Asking for the frame here
      // rather than when the face is painted matters, because the fetch is asynchronous and a call can be over
      // before it lands — the same reason the page's own tool branch asks the moment a call starts.
      if (outcome === 'tool' && typeof payload?.tool === 'string' && payload.tool !== '') {
        otherTool = payload.tool
        void loadNamedToolFrame(otherTool)
      }
      otherStreamAt.set(outcome, Date.now())
      syncGif()
    })
  }
  api.onSession((id) => { sessionId = typeof id === 'string' ? id : '' })
  api.onHistory((items) => {
    historyItems = Array.isArray(items) ? items : []
    if (historyOpen) renderHistory()
  })
  api.onPermission((preset) => {
    if (typeof preset !== 'string') return
    permission = preset
    renderPermission()
  })
  api.onReset(() => { stage({ type: 'reset' }) })
  api.onAttach((text) => {
    if (typeof text !== 'string' || text === '') return
    void setExpanded(true).then(() => {
      setAttachedSelection(text)
      prompt.focus()
    })
  })
  selectionChipDismiss.addEventListener('click', () => { setAttachedSelection('') })
  tccDismiss.addEventListener('click', () => { hideTccGate() })
  tccLater.addEventListener('click', () => { hideTccGate() })
  tccScreenOpen.addEventListener('click', () => { void openTccRight('screen') })
  tccAccessibilityOpen.addEventListener('click', () => { void openTccRight('accessibility') })
  api.onAvatar((src) => {
    avatarSrc = typeof src === 'string' && src !== '' ? src : 'deepseek-avatar-square.gif'
    // Warmed here as well as in `refreshFrames`, because this callback is the only thing that knows
    // the host has *replaced* the avatar: a different avatar is a different picture and a fresh 7.7MB
    // decode, and the hover that arrives before it finishes is the one that shows the placeholder.
    warmFrame(avatarSrc)
    const gif = document.querySelector('#ball-gif')
    if (!gif) return
    delete gif.dataset.mode
    syncGif()
  })
  api.onStatus((text) => { status.textContent = typeof text === 'string' ? text : '' })
  // The theme arrives as the helper's nativeTheme (the prefers-color-scheme
  // query above follows it); the locale switches the whole page dictionary.
  if (typeof api.onAppearance === 'function') {
    api.onAppearance((appearance) => {
      if (appearance !== null && typeof appearance === 'object') {
        applyLocale(appearance.locale)
        refreshAllText()
      }
    })
  }
  if (typeof api.onBalance === 'function') {
    // The host reads the account on its own slow cadence, so this arrives whenever it does — a
    // balance that falls below the line has to change the face the ball is already wearing, and a
    // top-up has to change it back, both without a reload.
    api.onBalance((payload) => {
      balanceCny = readBalance(payload)
      syncGif()
    })
  }
  if (typeof api.onSpeech === 'function') {
    api.onSpeech((settings) => {
      if (settings === null || typeof settings !== 'object') return
      const wasEnabled = speaker.enabled
      speaker.configure(settings)
      // Turning the feature on has to reach replies that are already on screen; the buttons are
      // created with their message, so existing ones would otherwise stay bare until the next reply.
      if (speaker.enabled && !wasEnabled) addSpeakButtons()
    })
  }
  transcript.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (anchor === null) return
    const href = anchor.getAttribute('href') ?? ''
    if (!/^https?:\/\//i.test(href)) return
    event.preventDefault()
    api.openExternal(href)
  })
  api.onQuestion((payload) => { showQuestion(payload) })
  api.onQuestionClear((id) => { clearQuestion(id) })
  api.onQuestionError((payload) => {
    if (pending === undefined || pending.id !== payload?.id) return
    pending.busy = false
    pending.error = typeof payload.text === 'string' ? payload.text : messages.incomplete
    renderQuestion()
  })
  armBallPicture()
  syncGif()
  void startMemes()
  // The helper's menu owns the switch; these events mirror it into this page.
  if (typeof api.onWake === 'function') {
    api.onWake((payload) => {
      const type = payload !== null && typeof payload === 'object' ? payload.type : ''
      if (type === 'enabled') void startWake()
      else if (type === 'disabled') void wake.disable()
    })
  }
  if (typeof api.onTranscript === 'function') api.onTranscript((payload) => { applyTranscript(payload) })
  // The menu's "speak one sentence" row: no wake word needed, same recorder.
  if (typeof api.onDictate === 'function') {
    api.onDictate(() => {
      void setExpanded(true).then(() => startDictation())
    })
  }
  buildWaveform()
  buildWakeMeter()
  void wake.syncFromHelper()
}

main()
