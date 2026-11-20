/** Right-click menu for the ball. Model rows come from the host catalog. */

import { modelMenuItems, type MenuCatalog, type MenuItem, type MenuSelection } from './model-menu.ts'

export interface ContextMenuState {
  readonly catalog: MenuCatalog
  readonly overlay: MenuSelection
  readonly background: MenuSelection
  readonly millifractionEnabled: boolean
  /** Whether the ball's agent answers under the terse-reply contract. */
  readonly replyEnabled: boolean
  /** The cap the contract enforces, shown in the label so the menu states the number it uses. */
  readonly replyMaxChars: number
  /** Whether the ball speaks the time on the hour. */
  readonly chimeEnabled: boolean
  /** The hours it stays silent, as a wrap-around window: `from ≤ hour < to`, or `from > to` across midnight. */
  readonly chimeQuietFrom: number
  readonly chimeQuietTo: number
  /** Whether a read-aloud service is configured: without one the chime has no voice. */
  readonly speechEnabled: boolean
  /** Whether local wake-word detection is on. */
  readonly wakeEnabled: boolean
  /** False when no `dsh-voice-dialog` asset directory was found, so the row is disabled. */
  readonly wakeAvailable: boolean
  /** The configured wake word as a person says it, so the row names what will actually fire. */
  readonly wakeWord: string
  /** Whether one utterance can be recorded and transcribed right now. */
  readonly dictationReady: boolean
  readonly openMain: boolean
}

export interface ContextMenuActions {
  openMain(): void
  setOverlay(selection: MenuSelection): void
  setBackground(selection: MenuSelection): void
  setMillifraction(enabled: boolean): void
  /** The terse-reply switch. The host persists it and the next answer already obeys it. */
  setReply(enabled: boolean): void
  /** The hourly-chime switch. Turning it on speaks a sample, so the row's effect is audible. */
  setChime(enabled: boolean): void
  /** The wake switch. The engine is what actually starts or stops listening. */
  setWake(enabled: boolean): void
  /** Record and transcribe one utterance now, without waiting for the wake word. */
  dictate(): void
  disable(): void
}

/** Labels and actions for the ball menu. The selection toolbar is disabled (buggy) and has no entry here. */
export function contextMenuTemplate(state: ContextMenuState, zh: boolean, actions: ContextMenuActions): MenuItem[] {
  const labels = {
    empty: zh ? '没有可用的模型。' : 'No models available.',
    defaultEffort: zh ? '默认' : 'Default',
    wake: zh ? `语音唤醒（${state.wakeWord}）` : `Voice wake word (${state.wakeWord})`,
    wakeMissing: zh ? '语音唤醒（未找到本地模型）' : 'Voice wake word (no local models)',
    dictate: zh ? '语音输入（现在说一句）' : 'Voice input (speak one sentence)',
    dictateMissing: zh ? '语音输入（需先开启语音唤醒）' : 'Voice input (turn the wake word on first)',
    // The cap sits in the label: it is the one number of the contract a voice user may want to know
    // without opening the profile file, and a read-only row for it would cost a second click.
    reply: zh ? `极简回复（≤${String(state.replyMaxChars)} 字）` : `Minimal replies (≤${String(state.replyMaxChars)} chars)`,
    chime: zh ? '整点报时' : 'Hourly chime',
    chimeMissing: zh ? '整点报时（需先开启朗读）' : 'Hourly chime (turn read-aloud on first)',
  }
  // The quiet window rides in the label: `quietFrom === quietTo` is no silence at all, and every
  // other pair names the hours the ball will not speak — a number the user cannot see anywhere else.
  const quiet = state.chimeQuietFrom === state.chimeQuietTo
    ? null
    : `${String(state.chimeQuietFrom)}–${String(state.chimeQuietTo)}`
  const chimeLabel = !state.speechEnabled
    ? labels.chimeMissing
    : quiet === null
      ? labels.chime
      : zh
        ? `${labels.chime}（${quiet} 点静音）`
        : `${labels.chime} (quiet ${quiet})`
  return [
    {
      label: zh ? '打开主窗口' : 'Open Main Window',
      enabled: state.openMain,
      click: () => { actions.openMain() },
    },
    {
      label: zh ? '悬浮球 Agent 模型' : 'Floating-ball Agent model',
      submenu: modelMenuItems(state.catalog, state.overlay, actions.setOverlay, labels),
    },
    {
      label: zh ? '后台 Agent 模型' : 'Background Agent model',
      submenu: modelMenuItems(state.catalog, state.background, actions.setBackground, labels),
    },
    {
      label: zh ? '千分比坐标' : 'Millifraction coordinates',
      type: 'checkbox',
      checked: state.millifractionEnabled,
      click: (item) => { actions.setMillifraction(item.checked) },
    },
    {
      // Applies to the ball's own session only, and takes effect on the next answer: the contract is
      // a system-prompt section rendered per turn, not a wrapper around the reply.
      label: labels.reply,
      type: 'checkbox',
      checked: state.replyEnabled,
      click: (item) => { actions.setReply(item.checked) },
    },
    {
      // The ball speaking something nobody asked for, so the switch belongs here rather than on
      // the settings page: it is the same kind of decision as the wake word, and the sample that
      // turning it on plays is the only feedback the user gets before the next hour.
      label: chimeLabel,
      type: 'checkbox',
      checked: state.chimeEnabled,
      enabled: state.speechEnabled,
      click: (item) => { actions.setChime(item.checked) },
    },
    {
      // The host seeds the model directory at launch; without one there is nothing
      // to run, so the row says so instead of failing silently after a click.
      label: state.wakeAvailable ? labels.wake : labels.wakeMissing,
      type: 'checkbox',
      checked: state.wakeEnabled,
      enabled: state.wakeAvailable,
      click: (item) => { actions.setWake(item.checked) },
    },
    {
      // The recorder lives on the wake engine's microphone, so this needs the engine
      // running; it is the path for when the wake word itself will not fire.
      label: state.dictationReady ? labels.dictate : labels.dictateMissing,
      enabled: state.dictationReady,
      click: () => { actions.dictate() },
    },
    { type: 'separator' },
    {
      label: zh ? '停用悬浮球' : 'Disable floating ball',
      click: () => { actions.disable() },
    },
  ]
}
