/** Right-click menu for the ball. Model rows come from the host catalog. */

import { modelMenuItems, type MenuCatalog, type MenuItem, type MenuSelection } from './model-menu.ts'
import type { WakeEngineId } from './wake-engines.ts'

/** One chooseable wake engine: the id, and whether this helper can run it at all. */
export interface WakeEngineOption {
  readonly engine: WakeEngineId
  /**
   * False when the engine's models are not on disk. A build with the decoder models stripped should
   * show the row greyed out, not offer a choice that cannot be honoured.
   */
  readonly available: boolean
}

/** One chooseable wake word: the file stem, how to say it, and whether its model is on disk. */
export interface WakeKeywordOption {
  readonly keyword: string
  readonly spoken: string
  /**
   * False when `<keyword>.onnx` is not in the asset directory. A row is disabled rather than
   * hidden: a word the user asked to train and has not been trained yet should be visible as
   * missing, not silently absent.
   */
  readonly available: boolean
}

/**
 * One chooseable read-aloud voice.
 *
 * The id is what the service routes on; the two names are what the row says, because a timbre has
 * to be described before it has been heard. Kept local to the menu rather than fetched: there is
 * no route that lists voices, and a menu must render without waiting for the service.
 */
export interface SpeechVoiceOption {
  readonly voice: string
  readonly zh: string
  readonly en: string
}

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
  /** Which voice reads, as the profile records it. Empty means the service's own default. */
  readonly speechVoice?: string
  /** Every voice the menu can offer. Optional so a snapshot from before this row still renders. */
  readonly speechVoices?: readonly SpeechVoiceOption[]
  /** Whether local wake-word detection is on. */
  readonly wakeEnabled: boolean
  /** False when no `dsh-voice-dialog` asset directory was found, so the row is disabled. */
  readonly wakeAvailable: boolean
  /** The configured wake word as a person says it, so the row names what will actually fire. */
  readonly wakeWord: string
  /** The configured keyword itself, which is what the radio rows compare against. */
  readonly wakeKeyword: string
  /** Every wake word the menu can offer, in the order it offers them. */
  readonly wakeKeywords: readonly WakeKeywordOption[]
  /** Which engine is listening, and which ones this build can run. */
  readonly wakeEngine: WakeEngineId
  /** Optional so a state snapshot predating the engine row still renders the rest of the menu. */
  readonly wakeEngines?: readonly WakeEngineOption[]
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
  /**
   * Choose the voice the replies are read in.
   *
   * No relaunch: the service picks its engine from the `voice` field of each request, so this is a
   * settings write and the next sentence already uses it.
   */
  setSpeechVoice(voice: string): void
  /** The wake switch. The engine is what actually starts or stops listening. */
  setWake(enabled: boolean): void
  /**
   * Choose which wake phrase to listen for.
   *
   * The engine loads one ONNX model at launch, so this is the one menu action that costs a relaunch:
   * the host writes the keyword and brings the ball back with the new model loaded.
   */
  setWakeWord(keyword: string): void
  /**
   * Choose which engine listens.
   *
   * Also a relaunch, for the same reason the phrase is: the engine is picked from the launch
   * configuration, and the page is built for exactly one of them.
   */
  setWakeEngine(engine: WakeEngineId): void
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
    wakeSwitch: zh ? '开启语音唤醒' : 'Turn the wake word on',
    dictate: zh ? '语音输入（现在说一句）' : 'Voice input (speak one sentence)',
    dictateMissing: zh ? '语音输入（需先开启语音唤醒）' : 'Voice input (turn the wake word on first)',
    // The cap sits in the label: it is the one number of the contract a voice user may want to know
    // without opening the profile file, and a read-only row for it would cost a second click.
    reply: zh ? `极简回复（≤${String(state.replyMaxChars)} 字）` : `Minimal replies (≤${String(state.replyMaxChars)} chars)`,
    chime: zh ? '整点报时' : 'Hourly chime',
    chimeMissing: zh ? '整点报时（需先开启朗读）' : 'Hourly chime (turn read-aloud on first)',
    voice: zh ? '音色' : 'Voice',
    voiceMissing: zh ? '音色（需先开启朗读）' : 'Voice (turn read-aloud on first)',
    voiceDefault: zh ? '跟随服务默认' : 'service default',
    // The engine names say what kind of thing each one is, because "new" and "old" mean nothing a
    // month from now and the two behave differently on the same phrase.
    engineOpenwake: zh ? '原有引擎（分类器）' : 'Existing engine (classifier)',
    engineSherpa: zh ? '新引擎（关键词检测）' : 'New engine (keyword spotter)',
    engineMissing: zh ? '（模型缺失）' : ' (no models)',
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
  // The current timbre rides in the label for the same reason the quiet window and the reply cap
  // do: it is a setting a voice user wants to know without opening a file or a submenu.
  const currentVoice = state.speechVoice ?? ''
  const voiceOption = (state.speechVoices ?? []).find((option) => option.voice === currentVoice)
  const voiceName = currentVoice === ''
    ? labels.voiceDefault
    : voiceOption === undefined
      ? currentVoice
      : (zh ? voiceOption.zh : voiceOption.en)
  const voiceLabel = !state.speechEnabled
    ? labels.voiceMissing
    // A dot rather than parentheses: most of the names already carry a parenthesis for the timbre,
    // and `音色（晓晓（温柔女声））` reads like a mistake.
    : `${labels.voice} · ${voiceName}`
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
      // Beside the chime because both answer "how does the ball sound", and here rather than on the
      // settings page because the reply being read is what makes a timbre worth choosing — the user
      // is in audio range of it already. No sample: the sentence being read right now is the sample.
      label: voiceLabel,
      enabled: state.speechEnabled && (state.speechVoices ?? []).length > 0,
      submenu: (state.speechVoices ?? []).map((option): MenuItem => ({
        label: zh ? option.zh : option.en,
        type: 'radio',
        // A group with nothing checked reads as "no voice is chosen", so the stored one stays
        // checked even when it is an id this menu does not list.
        checked: option.voice === currentVoice,
        click: () => { actions.setSpeechVoice(option.voice) },
      })),
    },
    {
      // The host seeds the model directory at launch; without one there is nothing
      // to run, so the row says so instead of failing silently after a click.
      //
      // The switch and the phrase share one submenu: they are one decision ("what is the ball
      // listening for, if anything"), and a second top-level row for the phrase would leave the
      // on/off box naming a word the user is about to change.
      label: state.wakeAvailable ? labels.wake : labels.wakeMissing,
      enabled: state.wakeAvailable,
      submenu: [
        {
          label: labels.wakeSwitch,
          type: 'checkbox',
          checked: state.wakeEnabled,
          enabled: state.wakeAvailable,
          click: (item) => { actions.setWake(item.checked) },
        },
        { type: 'separator' },
        // Engine first, phrase second: the list of phrases belongs to the engine above it, and the
        // separator is what says so. Choosing an engine is the same kind of decision as choosing a
        // word — one wake, one engine, one phrase — so it lives inside this one submenu.
        //
        // Only when there is more than one to choose: the classifier is retired and `WAKE_ENGINES`
        // has a single entry, so these rows would be one radio that is always checked with a
        // separator pointing at nothing. The list is optional, so a state snapshot from before this
        // row existed still renders the switch and the phrases instead of throwing.
        ...((state.wakeEngines ?? []).length > 1
          ? [
              ...(state.wakeEngines ?? []).map((option): MenuItem => {
                const base = option.engine === 'sherpa' ? labels.engineSherpa : labels.engineOpenwake
                return {
                  label: option.available ? base : `${base}${labels.engineMissing}`,
                  type: 'radio',
                  checked: option.engine === state.wakeEngine,
                  enabled: option.available,
                  click: () => { actions.setWakeEngine(option.engine) },
                }
              }),
              { type: 'separator' } as MenuItem,
            ]
          : []),
        ...state.wakeKeywords.map((option): MenuItem => ({
          // A radio group with no checked box would read as "nothing is chosen", so the box that is
          // already live stays checked even if its own model went missing after a bad train.
          label: option.available
            ? option.spoken
            : (zh ? `${option.spoken}（模型未训练）` : `${option.spoken} (no model yet)`),
          type: 'radio',
          checked: option.keyword === state.wakeKeyword,
          enabled: option.available && state.wakeAvailable,
          click: () => { actions.setWakeWord(option.keyword) },
        })),
      ],
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
