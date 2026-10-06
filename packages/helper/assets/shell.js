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
const COLLAPSE_MS = 180
const ANIMATION_MS = 300
const DOCK_HOVER_DELAY_MS = 800
/** How often the page re-reads the burst config while bursts are off or unreadable. */
const MEME_POLL_MS = 30000
/** How long the typing frame stays after the last keystroke in the ball's own composer. */
const TYPING_HOLD_MS = 3000
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
 * The one tool call that gets a face of its own.
 *
 * `web_search` is deliberately not on this list: a search returns snippets the agent already has,
 * while `web_fetch` is the call where it is waiting on a page it has not seen yet — that wait is
 * the one the user can see the length of, and the one worth showing something during.
 */
const WEB_FETCH_TOOL = 'web_fetch'
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
  let dockHoverArmed = true
  let dockPointerInside = false
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
  // The fetch face: a `data:` URL worn while a web page is being fetched. Separate from `toolSrc`
  // because a pack that names one has said something specific about that one call, and every other
  // tool still shares `tool`. `undefined` when the pack names no such file, which is what leaves
  // `tool` in charge of a fetch as well.
  let webfetchSrc
  let webfetchPending = false
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
  // The finished-task frame: one pass of a GIF whenever a turn ends by itself.
  let doneFrame
  let doneShown
  let doneTimer
  let doneStep = 0
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
    const gif = document.querySelector('#ball-gif')
    // Being carried around the desktop outranks every pose, including the click reaction.
    if (dragging && dragSrc !== undefined) {
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
    // The task just finished. Like the click reaction this is its own event rather than a
    // state to sit in, so it briefly outranks the resting poses: a turn that ends while the
    // pointer happens to rest on the ball still has to be visible.
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
      const web = agentTool === WEB_FETCH_TOOL && webfetchSrc !== undefined
      const mode = web ? 'webfetch' : 'tool'
      const src = web ? webfetchSrc : toolSrc
      if (src !== undefined) {
        if (gif.dataset.mode !== mode) {
          gif.dataset.mode = mode
          gif.src = src
        }
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
    // An open panel wears the avatar face — but a configured meme loop outranks it. The ball is
    // not doing anything in particular just because the panel happens to be showing, and a pack
    // that names an `idle` has already said what the ball looks like when it is not doing
    // anything. Without a loop to fall back on the avatar still applies, so a profile with no
    // memes behaves exactly as before. The poor face counts as a resting loop here for the obvious
    // reason: it is the same state under a condition, and a pack that names only that one has still
    // said what the ball looks like at rest.
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
   */
  function restingNow() {
    return !pageClosed() && !hovering && !expanded && !running && !asking()
      && !tccGateVisible && attachedSelection === '' && agentState === ''
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
    for (const block of blockData.values()) {
      if (block.running !== true) continue
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
    const next = agentPhase()
    if (next.state === agentState && next.tool === agentTool) return
    const wasTooling = agentState === 'tooling'
    agentState = next.state
    agentTool = next.tool
    // A fetch that starts before the frame sweep has made its round would otherwise wear the
    // generic tool face for the whole call, which is the one call worth having a face for.
    if (next.state === 'tooling' && next.tool === WEB_FETCH_TOOL && webfetchSrc === undefined) {
      void loadWebfetchFrame()
    } else if (wasTooling) {
      // The call that was being fetched has finished, so the frame it was reading is dead weight.
      // Dropping it lets the next fetch ask again, which is what makes editing `memes.json` take
      // effect without a restart.
      webfetchSrc = undefined
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
   * One skit: the repeated frame a few times, with the interjection dropped in the middle.
   * The order is fixed here; only the number of repeats is random.
   */
  function skitSequence(info) {
    const count = pickIn(info.times)
    const frames = []
    const middle = Math.floor(count / 2)
    for (let index = 0; index < count; index += 1) {
      if (index === middle && info.interject !== null) frames.push(info.interject)
      frames.push(info.file)
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
    if (webfetchSrc === undefined) await loadWebfetchFrame()
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
    if (doneFrame === undefined || doneFrame === null) {
      const frame = await fetchDone()
      if (frame !== null) doneFrame = frame
    }
    if (wakeFrame === undefined || wakeFrame === null) {
      const frame = await fetchWake()
      if (frame !== null) wakeFrame = frame
    }
    if (dropFrame === undefined || dropFrame === null) {
      const frame = await fetchDrop()
      if (frame !== null) dropFrame = frame
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
    const hold = oneShotHoldMs(clickFrame.ms, clickFrame.loops)
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

  /** The skit plan: `{ gapMs, file, times, interject }`, or `null` while it is off or unreadable. */
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
    const file = timedFrameOf(plan.file)
    if (file === null) return null
    return { gapMs: plan.gapMs, times: plan.times, file, interject: timedFrameOf(plan.interject) }
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
    return { src: value.src, ms: value.ms, loops: loopsForever(value.src) }
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
   * Fetch the fetch face once, then repaint.
   *
   * Two callers: the startup sweep, and `syncAgent` on the edge where a `web_fetch` starts. The
   * second one matters because the first fetch of a session routinely beats the sweep, and a face
   * that arrives after the call is over is a face nobody ever sees. `webfetchPending` keeps the
   * two from racing over a frame that is a whole GIF.
   *
   * It is safe to call while a fetch is not running: the frame is only worn while one is, and
   * `syncGif` on arrival is a no-op in every other state. So the frame is also dropped again when
   * the call that wanted it ends, which is what lets an edited `memes.json` apply to the next
   * fetch rather than to the next restart.
   */
  async function loadWebfetchFrame() {
    if (webfetchSrc !== undefined || webfetchPending) return
    webfetchPending = true
    try {
      const src = await fetchFrame(() => api.memeWebfetch())
      if (src !== undefined) {
        webfetchSrc = src
        syncGif()
      }
    } finally {
      webfetchPending = false
    }
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
    memeInfo = valid ? schedule : undefined
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

  function setRunning(next, interrupted = false) {
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
    // yourself is not something to celebrate.
    if (wasRunning && !interrupted) playDoneFrame()
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
    clearDockHoverTimer()
    // Every branch below changes what the window should capture over, so every branch reports.
    // Docking is the case that most needs it: the ball is gone and a 6px tab is what is left, and
    // without this the window would still be capturing over where the ball used to be.
    if (next === undefined) {
      dockTab.hidden = true
      dockHoverArmed = true
      syncHitTest()
      return
    }
    if (becameDocked) {
      dockHoverArmed = false
      dockHoverTimer = setTimeout(() => {
        dockHoverTimer = undefined
        dockHoverArmed = true
        if (dockPointerInside) void unsnapDocked()
      }, DOCK_HOVER_DELAY_MS)
    }
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
      void api.setExpanded(false)
      syncHitTest()
    }, ANIMATION_MS)
  }

  function ballGrabOffset(event) {
    const rect = ball.getBoundingClientRect()
    return { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
  }

  function scheduleCollapse() {
    if (pinned || running || asking() || dragging) return
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
      for (const item of list) {
        if (item.type === 'block') upsertBlock(item)
        else if (item.type === 'block-drop') removeBlock(item.key)
        else if (item.type === 'turn') setRunning(item.running === true, item.interrupted === true)
        else if (item.type === 'reset') clearTranscript()
      }
      syncAgent()
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
   */
  function enterUi() {
    dockPointerInside = true
    applyHover(true)
    if (dragging || collapsing) return
    if (docked !== undefined) {
      if (dockHoverArmed) void unsnapDocked()
      return
    }
    if (suppressExpand) return
    void setExpanded(true)
  }

  /** And this is the pointer leaving, which is what collapses the panel again. */
  function leaveUi() {
    dockPointerInside = false
    applyHover(false)
    suppressExpand = false
    if (dragging || collapsing) return
    scheduleCollapse()
  }

  document.body.addEventListener('pointerenter', (event) => {
    pointerAt = event
    if (!pointerOnBallOrPanel()) return
    enterUi()
  })
  document.body.addEventListener('pointermove', (event) => {
    pointerAt = event
    const on = pointerOnBallOrPanel()
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
      if (pointerOnBallOrPanel()) enterUi()
      else leaveUi()
    })
  }

  ball.addEventListener('pointerdown', (event) => {
    if (!isPrimaryButton(event)) return
    dragging = false
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
    collapsing = false
    skipClick = true
    lastOrigin = undefined
    pointer = { dx: 0, dy: 0, startX: event.screenX, startY: event.screenY }
    dockTab.setPointerCapture(event.pointerId)
  })
  dockTab.addEventListener('pointermove', (event) => {
    if (pointer === undefined || docked === undefined) return
    if (!primaryButtonHeld(event)) {
      void finishPointer(event)
      return
    }
    lastOrigin = { x: event.screenX, y: event.screenY }
    const inward = docked === 'right' ? pointer.startX - event.screenX : event.screenX - pointer.startX
    if (inward <= DOCK_DRAG_OFF_PX) return
    dragging = true
    void unsnapDocked()
  })
  dockTab.addEventListener('pointerup', (event) => { void finishPointer(event) })
  dockTab.addEventListener('pointercancel', (event) => { void finishPointer(event) })
  dockTab.addEventListener('lostpointercapture', (event) => { void finishPointer(event) })

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
