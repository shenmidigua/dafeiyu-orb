window.__ModuleLoader__.load({
  id: '@dsh-orb/client-ui-settings-orb',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const zh = {
      nav: '悬浮球',
      intro: '更改写入当前配置。',
      linux: '悬浮球在 Linux 上不可用。',
      error: '无法加载悬浮球设置。',
      saveError: '无法保存。',
      helperFailed: '悬浮球多次退出，已经停止重试。关闭后再打开可再试一次。',
      runtimeFailed: '悬浮球运行时没有下载成功。关闭后再打开可再试一次。',
      permissionFallback: '权限设置无法读取，已改为工作区内修改。',
      retry: '重试',
      ball: '启用悬浮球',
      ballDescription: '关闭后插件仍在，Computer Use 仍可在主窗口使用。',
      avatarTitle: '悬浮球头像',
      avatarDescription: '点一张内置动图，或选择自己的图片。上传支持 GIF、PNG、WebP，2 MB 以内。',
      avatarAlt: '悬浮球头像预览',
      avatarBuiltin: '内置动图',
      avatarPresetNames: {
        point: '指点',
        rice: '干饭',
        heart: '比心',
        cheer: '欢呼',
        cheeks: '托腮',
        smile: '微笑',
      },
      chooseImage: '选择图片',
      restoreDefault: '恢复默认',
      tooLarge: '图片超过 2 MB。',
      invalidType: '请选择 GIF、PNG 或 WebP 图片。',
      overlayTitle: '悬浮球 Agent',
      overlayDescription: '悬浮球 Computer Use 会话使用的模型与思考强度。',
      backgroundTitle: '后台 Agent',
      backgroundDescription: '新建后台 code_agent 会话使用的模型与思考强度。',
      emptyCatalog: '暂无可用模型。',
      defaultEffort: '默认',
      millifractionTitle: '千分比坐标',
      millifractionDescription: '新建对话使用截图的 0–1000 比例。关闭后使用已附加图片的像素。更改此项会新建对话。',
      millifractionToggle: '使用千分比坐标',
      millifractionConfirm: '新编码只在新对话中生效。当前对话不变，仍可从历史记录打开。取消不写入、不新建。',
      speechTitle: '朗读回复',
      speechDescription: '用本地的语音合成服务把回复读出来。需要在另一个程序里启动该服务，音频不离开这台机器。',
      speechEnable: '启用朗读',
      speechEnableDescription: '关闭后每条回复下面不再显示播放按钮。',
      speechAutoPlay: '自动朗读',
      speechAutoPlayDescription: '回复一读完就自动播放。关闭后只能用播放按钮手动触发。',
      speechEndpoint: '服务地址',
      speechEndpointDescription: '语音服务的地址。默认 http://127.0.0.1:8765。',
      speechEndpointInvalid: '请填写 http:// 或 https:// 开头的地址。',
      speechSaveEndpoint: '保存地址',
      pitchTitle: '音调',
      pitchDescription: '把声音整体升高或降低，语速不变。0 是服务原本的声音，改完下一句就用新值。',
      pitchLabel: '音调',
      pitchValue: '原声',
      pitchValueShift: '{semitones} 半音',
      pitchHint: '范围 -6 到 +6 半音：负值更低沉，正值更清亮。',
      pitchPreview: '试听',
      pitchPreviewing: '试听中…',
      pitchReset: '复位',
      pitchMissing: '朗读插件没有运行，试听用不了。确认它在插件列表里并已启用。',
      voiceTitle: '语音对话',
      voiceDescription: '语音识别时，说完后停顿多久就算「说完了」。调小收得快，调大不容易被说话中间的停顿打断。',
      voiceSilenceLabel: '说完判定停顿',
      voiceSilenceValue: '{seconds} 秒',
      voiceSilenceHint: '范围 1–10 秒，默认 2.5 秒。拖动后，下一次语音识别就用新值。',
      tccTitle: 'Mac 权限',
      tccDescription: 'Computer Use 需要屏幕录制与辅助功能。点按钮打开系统设置对应页。',
      tccAppHint: '在列表里打开 {name}。',
      tccScreenName: '屏幕录制',
      tccScreenReason: '让 agent 看见当前窗口。',
      tccScreenPath: '系统设置 → 隐私与安全性 → 屏幕录制',
      tccScreenOpen: '打开「屏幕录制」设置',
      tccAccessibilityName: '辅助功能',
      tccAccessibilityReason: '让 agent 点击和输入。',
      tccAccessibilityPath: '系统设置 → 隐私与安全性 → 辅助功能',
      tccAccessibilityOpen: '打开「辅助功能」设置',
      tccMissing: '未开启',
      tccGranted: '已开启',
      tccRelaunch: '已开启，请退出后重开',
      tccFooter: '打开开关后必须完全退出 {name} 再打开。只关主窗口无效。',
      wakeOn: '语音唤醒已开启，点一下关闭',
      wakeOff: '语音唤醒已关闭，点一下开启',
      wakeLabel: '语音唤醒',
      wakeBusy: '正在切换语音唤醒…',
      wakeFailed: '语音唤醒开关没有保存成功。',
      micLabel: '语音输入',
      micIdle: '说一句，停顿一下就自动结束',
      micRecording: '正在录：说完停一下，或者再点一次结束',
      micStop: '结束这次录音',
    }
    const en = {
      nav: 'Floating ball',
      intro: 'Changes are saved in the current profile.',
      linux: 'The floating ball is not available on Linux.',
      error: 'Could not load floating-ball settings.',
      saveError: 'Could not save.',
      helperFailed: 'The floating ball exited too many times and stopped retrying. Turn it off and on to try again.',
      runtimeFailed: 'The floating-ball runtime did not download. Turn it off and on to try again.',
      permissionFallback: 'The permission file could not be read. Access is now Workspace Write.',
      retry: 'Retry',
      ball: 'Enable the floating ball',
      ballDescription: 'Turning this off keeps the plugin loaded. Computer Use stays available in the main window.',
      avatarTitle: 'Ball image',
      avatarDescription: 'Pick a built-in animation, or choose your own image. Uploads accept GIF, PNG, and WebP up to 2 MB.',
      avatarAlt: 'Floating-ball image preview',
      avatarBuiltin: 'Built-in animations',
      avatarPresetNames: {
        point: 'Point',
        rice: 'Rice',
        heart: 'Heart',
        cheer: 'Cheer',
        cheeks: 'Cheeks',
        smile: 'Smile',
      },
      chooseImage: 'Choose image',
      restoreDefault: 'Restore default',
      tooLarge: 'The image is larger than 2 MB.',
      invalidType: 'Choose a GIF, PNG, or WebP image.',
      overlayTitle: 'Floating-ball Agent',
      overlayDescription: 'Model and reasoning effort for the ball\'s Computer Use session.',
      backgroundTitle: 'Background Agent',
      backgroundDescription: 'Model and reasoning effort for new background code_agent sessions.',
      emptyCatalog: 'No models available.',
      defaultEffort: 'Default',
      millifractionTitle: 'Millifraction coordinates',
      millifractionDescription: 'New chats use 0–1000 fractions of the screenshot. Turn off to use pixels of the attached image. Changing this creates a new conversation.',
      millifractionToggle: 'Use millifraction coordinates',
      millifractionConfirm: 'The new encoding takes effect in a new conversation. The current conversation stays unchanged and remains in History. Cancel leaves the default and this chat as they are.',
      speechTitle: 'Read replies aloud',
      speechDescription: 'Reads replies through a local speech service. Run that service in a separate program; the audio never leaves this machine.',
      speechEnable: 'Enable read aloud',
      speechEnableDescription: 'Turn off and the play button disappears from every reply.',
      speechAutoPlay: 'Automatic playback',
      speechAutoPlayDescription: 'Start reading as soon as a reply finishes. Turn off and the play button is the only way to hear it.',
      speechEndpoint: 'Service address',
      speechEndpointDescription: 'Where the speech service listens. Default http://127.0.0.1:8765.',
      speechEndpointInvalid: 'Enter an address starting with http:// or https://.',
      speechSaveEndpoint: 'Save address',
      pitchTitle: 'Voice pitch',
      pitchDescription: 'Raises or lowers the whole voice without changing how fast it reads. 0 is the voice exactly as the service sends it; the next sentence uses a new value.',
      pitchLabel: 'Pitch',
      pitchValue: 'As sent',
      pitchValueShift: '{semitones} semitones',
      pitchHint: 'From -6 to +6 semitones: lower is deeper, higher is brighter.',
      pitchPreview: 'Play a sample',
      pitchPreviewing: 'Playing…',
      pitchReset: 'Reset',
      pitchMissing: 'The read-aloud plugin is not running, so there is nothing to play the sample. Check that it is installed and enabled.',
      voiceTitle: 'Voice conversation',
      voiceDescription: 'How long a pause after you stop talking ends the recording. Smaller closes sooner; larger is less likely to cut you off mid-sentence.',
      voiceSilenceLabel: 'Pause that ends a turn',
      voiceSilenceValue: '{seconds} s',
      voiceSilenceHint: 'From 1 to 10 seconds, 2.5 by default. The next voice turn uses the new value.',
      tccTitle: 'Mac permissions',
      tccDescription: 'Computer Use needs Screen Recording and Accessibility. Each button opens that System Settings pane.',
      tccAppHint: 'In the list, turn on {name}.',
      tccScreenName: 'Screen Recording',
      tccScreenReason: 'Lets the agent see the current window.',
      tccScreenPath: 'System Settings → Privacy & Security → Screen Recording',
      tccScreenOpen: 'Open Screen Recording settings',
      tccAccessibilityName: 'Accessibility',
      tccAccessibilityReason: 'Lets the agent click and type.',
      tccAccessibilityPath: 'System Settings → Privacy & Security → Accessibility',
      tccAccessibilityOpen: 'Open Accessibility settings',
      tccMissing: 'Off',
      tccGranted: 'On',
      tccRelaunch: 'On — quit and reopen',
      tccFooter: 'After you turn the switches on, quit {name} fully, then open it again. Closing the main window does not quit.',
      wakeOn: 'Wake word is on — click to turn it off',
      wakeOff: 'Wake word is off — click to turn it on',
      wakeLabel: 'Wake word',
      wakeBusy: 'Switching the wake word…',
      wakeFailed: 'The wake-word switch was not saved.',
      micLabel: 'Voice input',
      micIdle: 'Say a sentence — a short pause ends it',
      micRecording: 'Recording — pause when done, or press again to end it',
      micStop: 'End this recording',
    }

    // The main window's resolved locale rides <html lang> (dsh-client-locale);
    // a page without it falls back to the browser languages.
    function copy() {
      const lang = `${document.documentElement?.lang || ''}${navigator.language || ''}`
      return lang.toLowerCase().startsWith('zh') ? zh : en
    }

    function h(tag, props, ...children) {
      return React.createElement(tag, props, ...children)
    }

    // How many microphone triggers the page holds. Only the diagnosis beacon reads it, and a page
    // whose DOM stub is not iterable must not throw, so this walks by index and reports -1 when it
    // cannot look at all.
    function countMics() {
      try {
        const nodes = document.querySelectorAll('button[aria-label]')
        if (nodes === null || nodes === undefined) return -1
        let found = 0
        for (let index = 0; index < nodes.length; index += 1) {
          const node = nodes[index]
          const label = node && typeof node.getAttribute === 'function' ? node.getAttribute('aria-label') : ''
          if (label && /录音|语音输入|麦克风|听写|record|dictat|microphone/i.test(label)) found += 1
        }
        return found
      } catch (_error) {
        return -1
      }
    }

    async function request(path, options) {
      const response = await fetch(path, {
        cache: 'no-store',
        ...options,
        headers: {
          accept: 'application/json',
          ...(options && options.headers ? options.headers : {}),
        },
      })
      const text = await response.text()
      let body = null
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          body = { error: text.slice(0, 200) }
        }
      }
      if (!response.ok) {
        const error = new Error(body && body.error ? body.error : 'request failed')
        error.status = response.status
        throw error
      }
      return body
    }

    function findModel(catalog, selection) {
      const groups = catalog && catalog.groups ? catalog.groups : []
      for (const group of groups) {
        if (!selection || group.id !== selection.provider) continue
        for (const model of group.models || []) {
          if (model.id === selection.model) return model
        }
      }
      return undefined
    }

    function Toggle(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: `dsh-orb-set-switch${props.checked ? ' is-on' : ''}`,
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        disabled: props.disabled,
        onClick: () => {
          if (!props.disabled) props.onChange(!props.checked)
        },
      })
    }

    function ModelPicker(props) {
      const text = copy()
      const groups = props.catalog && props.catalog.groups ? props.catalog.groups : []
      const current = props.current || { provider: '', model: '' }
      const value = `${current.provider}\u001f${current.model}`
      const known = findModel(props.catalog, current)
      const options = []
      if (!known && current.provider && current.model) {
        options.push(h('option', { key: value, value }, `${current.provider} / ${current.model}`))
      }
      for (const group of groups) {
        options.push(h('optgroup', { key: group.id, label: group.name },
          ...(group.models || []).map((model) => h('option', {
            key: `${group.id}\u001f${model.id}`,
            value: `${group.id}\u001f${model.id}`,
          }, model.name))))
      }
      const efforts = known && known.reasoning ? known.reasoning.efforts || [] : []
      return h('div', { className: 'dsh-orb-set-pickers' },
        h('select', {
          'aria-label': props.label,
          disabled: props.disabled || (options.length === 0),
          value: options.length === 0 ? '' : value,
          onChange: (event) => {
            const [provider, model] = String(event.target.value).split('\u001f')
            if (!provider || !model) return
            const next = findModel(props.catalog, { provider, model })
            const effort = next && next.reasoning ? next.reasoning.defaultEffort : undefined
            props.onSelect(effort ? { provider, model, reasoningEffort: effort } : { provider, model })
          },
        }, options.length === 0 ? h('option', { value: '' }, text.emptyCatalog) : options),
        efforts.length === 0 ? null : h('select', {
          'aria-label': text.defaultEffort,
          disabled: props.disabled,
          value: current.reasoningEffort || known.reasoning.defaultEffort || efforts[0].id,
          onChange: (event) => {
            props.onSelect({ provider: current.provider, model: current.model, reasoningEffort: event.target.value })
          },
        }, efforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name || effort.id))))
    }

    function statusText(text, state) {
      if (state === 'granted') return text.tccGranted
      if (state === 'needsRelaunch') return text.tccRelaunch
      return text.tccMissing
    }

    /**
     * The "you finished speaking" pause, in milliseconds.
     *
     * One unit boundary in the whole feature: the slider, the copy and the user think in seconds,
     * the recorder and `orb-wake.json` are in milliseconds, and every conversion happens here — the
     * number shown is `ms / 1000`, the number posted is `seconds * 1000`, and a value that never
     * arrived falls back to the shipped 2.5 s rather than to zero.
     */
    const SILENCE_MIN_MS = 1000
    const SILENCE_MAX_MS = 10000
    const SILENCE_STEP_MS = 100
    const SILENCE_DEFAULT_MS = 2500
    /** Writes trail the drag: one save when the hand stops, not ninety while it moves. */
    const SILENCE_SAVE_DELAY_MS = 300
    let silenceSaveTimer

    /** The stored pause, clamped to the slider's own range so the thumb is never off its track. */
    function silenceOf(dictation) {
      const stored = dictation && typeof dictation.silenceMs === 'number' && Number.isFinite(dictation.silenceMs)
        ? Math.round(dictation.silenceMs)
        : SILENCE_DEFAULT_MS
      return Math.min(SILENCE_MAX_MS, Math.max(SILENCE_MIN_MS, stored))
    }

    /** Milliseconds as the seconds the user reads: 2500 -> "2.5". */
    function silenceSeconds(ms) {
      return (ms / 1000).toFixed(1)
    }

    /**
     * The pause slider, with its own draft so dragging is never interrupted by a save landing.
     *
     * The draft resets whenever the stored value changes underneath it (a save that came back with a
     * clamped number, or an edit made in the file), and the drag only posts once the hand has been
     * still for `SILENCE_SAVE_DELAY_MS`.
     */
    function SilenceSlider(props) {
      const [value, setValue] = React.useState(props.value)
      React.useEffect(() => {
        setValue(props.value)
      }, [props.value])

      function schedule(next) {
        clearTimeout(silenceSaveTimer)
        silenceSaveTimer = setTimeout(() => {
          silenceSaveTimer = undefined
          if (next !== props.value) props.onChange(next)
        }, SILENCE_SAVE_DELAY_MS)
      }

      const seconds = props.text.voiceSilenceValue.replace('{seconds}', silenceSeconds(value))
      return h('div', { className: 'dsh-orb-set-silence' },
        h('div', { className: 'dsh-orb-set-silence-head' },
          h('h4', null, props.text.voiceSilenceLabel),
          h('span', { className: 'dsh-orb-set-silence-value', 'aria-live': 'polite' }, seconds)),
        h('input', {
          type: 'range',
          className: 'dsh-orb-set-range',
          'data-role': 'silence',
          min: SILENCE_MIN_MS,
          max: SILENCE_MAX_MS,
          step: SILENCE_STEP_MS,
          value,
          disabled: props.disabled,
          'aria-label': props.text.voiceSilenceLabel,
          'aria-valuetext': seconds,
          onChange: (event) => {
            const next = Number(event.target.value)
            if (!Number.isFinite(next)) return
            // The number on screen moves on every step; the write waits for the hand to stop.
            setValue(next)
            schedule(next)
          },
        }))
    }

    /**
     * The voice's tuning, shared with the read-aloud plugin through `localStorage`.
     *
     * The service cannot move pitch: DeepSeek's TTS takes `{ text, voice_id, format }` and has no
     * speed, pitch or style field, so a lower or brighter voice is the player's own work. The
     * slider therefore writes the number the player reads — the same key, the same range — and
     * the sample is played by that player rather than by this page, which is the only way what is
     * heard here is what a reply sounds like.
     */
    const PITCH_KEY = 'dsh-speak-button.pitch'
    const PITCH_MIN = -6
    const PITCH_MAX = 6
    const PITCH_SAMPLE = '你好，我是这样说话的。现在这个音调，听起来还舒服吗？'

    function readPitch() {
      try {
        const raw = globalThis.localStorage === undefined ? null : globalThis.localStorage.getItem(PITCH_KEY)
        const value = Number(raw)
        if (raw === null || raw === '' || !Number.isFinite(value)) return 0
        return Math.max(PITCH_MIN, Math.min(PITCH_MAX, Math.round(value)))
      } catch {
        return 0
      }
    }

    function writePitch(value) {
      try { globalThis.localStorage.setItem(PITCH_KEY, String(value)) } catch {}
    }

    function PitchCard(props) {
      const text = props.text
      const [value, setValue] = React.useState(readPitch())
      const [busy, setBusy] = React.useState(false)
      const [missing, setMissing] = React.useState(false)
      const alive = React.useRef(true)
      React.useEffect(() => () => { alive.current = false }, [])

      function commit(next) {
        if (!Number.isFinite(next)) return
        const clamped = Math.max(PITCH_MIN, Math.min(PITCH_MAX, Math.round(next)))
        setValue(clamped)
        writePitch(clamped)
      }

      async function preview() {
        const hook = globalThis.__dshSpeakButton
        if (hook === undefined || hook === null || typeof hook.preview !== 'function') {
          setMissing(true)
          return
        }
        setMissing(false)
        setBusy(true)
        try {
          await hook.preview(PITCH_SAMPLE)
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      const shown = value === 0
        ? text.pitchValue
        : text.pitchValueShift.replace('{semitones}', `${value > 0 ? '+' : ''}${value}`)
      return h('section', { className: 'dsh-orb-set-card' },
        h('h3', null, text.pitchTitle),
        h('p', null, text.pitchDescription),
        h('div', { className: 'dsh-orb-set-pitch' },
          h('div', { className: 'dsh-orb-set-pitch-head' },
            h('h4', null, text.pitchLabel),
            h('span', { className: 'dsh-orb-set-pitch-value', 'aria-live': 'polite' }, shown)),
          h('input', {
            type: 'range',
            className: 'dsh-orb-set-range',
            'data-role': 'pitch',
            min: PITCH_MIN,
            max: PITCH_MAX,
            step: 1,
            value,
            'aria-label': text.pitchLabel,
            'aria-valuetext': shown,
            onChange: (event) => { commit(Number(event.target.value)) },
          }),
          h('p', null, text.pitchHint),
          h('div', { className: 'dsh-orb-set-actions' },
            h('button', {
              type: 'button',
              className: 'dsh-orb-set-button',
              disabled: busy,
              onClick: () => { void preview() },
            }, busy ? text.pitchPreviewing : text.pitchPreview),
            h('button', {
              type: 'button',
              className: 'dsh-orb-set-button dsh-orb-set-ghost',
              disabled: busy || value === 0,
              onClick: () => { commit(0) },
            }, text.pitchReset))),
        missing ? h('p', { className: 'dsh-orb-set-error', role: 'alert' }, text.pitchMissing) : null)
    }

    function OrbSettingsSection() {
      const text = copy()
      // Re-render when the app's locale changes (<html lang>), so every copy()
      // call in this section re-evaluates against the new language.
      const [, bumpLocale] = React.useState(0)
      React.useEffect(() => {
        if (typeof MutationObserver !== 'function' || !document.documentElement) return undefined
        const observer = new MutationObserver(() => { bumpLocale((count) => count + 1) })
        observer.observe(document.documentElement, { attributeFilter: ['lang'] })
        return () => { observer.disconnect() }
      }, [])
      const [state, setState] = React.useState({
        status: 'loading',
        error: '',
        snapshot: null,
        catalog: { groups: [] },
        busy: false,
        avatarError: '',
      })

      async function load() {
        setState((prev) => ({ ...prev, status: prev.snapshot ? prev.status : 'loading', error: '', avatarError: '' }))
        try {
          const [snapshot, catalog] = await Promise.all([
            request('/.dsh-orb/settings'),
            request('/.dsh-orb/models'),
          ])
          setState({ status: 'ready', error: '', snapshot, catalog: catalog || { groups: [] }, busy: false, avatarError: '' })
        } catch (error) {
          setState((prev) => ({
            ...prev,
            status: 'error',
            busy: false,
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      }

      React.useEffect(() => {
        void load()
        const onFocus = () => { void load() }
        window.addEventListener?.('focus', onFocus)
        return () => { window.removeEventListener?.('focus', onFocus) }
      }, [])

      async function mutate(path, body, avatarError) {
        setState((prev) => ({ ...prev, busy: true, avatarError: avatarError || '' }))
        try {
          const snapshot = await request(path, {
            method: 'POST',
            headers: body instanceof ArrayBuffer
              ? { 'content-type': 'application/octet-stream' }
              : { 'content-type': 'application/json' },
            body: body instanceof ArrayBuffer ? body : JSON.stringify(body),
          })
          setState((prev) => ({ ...prev, status: 'ready', snapshot, busy: false, avatarError: '' }))
        } catch (error) {
          const code = error instanceof Error ? error.message : ''
          setState((prev) => ({
            ...prev,
            busy: false,
            avatarError: code === 'too-large' || code === 'invalid-type' ? code : prev.avatarError,
            error: code === 'too-large' || code === 'invalid-type' ? '' : code,
            status: code === 'too-large' || code === 'invalid-type' ? prev.status : 'error',
          }))
        }
      }

      if (state.status === 'error' && !state.snapshot) {
        return h('div', { className: 'dsh-orb-set' },
          h('p', { className: 'dsh-orb-set-error', role: 'alert' }, `${text.error} ${state.error}`),
          h('button', { type: 'button', className: 'dsh-orb-set-button', onClick: () => { void load() } }, text.retry))
      }
      if (!state.snapshot) return h('div', { className: 'dsh-orb-set' }, h('p', null, text.nav))

      const snap = state.snapshot
      const disabled = !snap.supported || state.busy
      const avatarMessage = state.avatarError === 'too-large'
        ? text.tooLarge
        : state.avatarError === 'invalid-type'
          ? text.invalidType
          : ''
      return h('div', { className: 'dsh-orb-set' },
        h('h2', { className: 'dsh-orb-set-title' }, text.nav),
        h('p', { className: 'dsh-orb-set-intro' }, text.intro),
        state.status === 'error' && state.error
          ? h('p', { className: 'dsh-orb-set-error', role: 'alert' }, `${text.saveError} ${state.error}`)
          : null,
        snap.supported ? null : h('p', { className: 'dsh-orb-set-banner', role: 'status' }, text.linux),
        helperNotice(text, snap),
        snap.permissionFallback === true
          ? h('p', { className: 'dsh-orb-set-banner', role: 'status' }, text.permissionFallback)
          : null,
        h('fieldset', { className: 'dsh-orb-set-fields', disabled },
          card(text.ball, text.ballDescription, h(Toggle, {
            checked: snap.ballEnabled === true,
            label: text.ball,
            disabled,
            onChange: (enabled) => { void mutate('/.dsh-orb/ball', { enabled }) },
          })),
          h('section', { className: 'dsh-orb-set-card' },
            h('h3', null, text.avatarTitle),
            h('p', null, text.avatarDescription),
            h('div', { className: 'dsh-orb-set-avatar-row' },
              h('img', { className: 'dsh-orb-set-avatar', src: snap.avatarUrl, alt: text.avatarAlt }),
              h('div', { className: 'dsh-orb-set-actions' },
                h('button', {
                  type: 'button',
                  className: 'dsh-orb-set-button',
                  disabled,
                  onClick: () => {
                    const input = document.createElement('input')
                    input.type = 'file'
                    input.accept = 'image/gif,image/png,image/webp,.gif,.png,.webp'
                    input.onchange = () => {
                      const file = input.files && input.files[0]
                      if (!file) return
                      if (file.size > 2 * 1024 * 1024) {
                        setState((prev) => ({ ...prev, avatarError: 'too-large' }))
                        return
                      }
                      void file.arrayBuffer().then((bytes) => mutate('/.dsh-orb/avatar', bytes))
                    }
                    input.click()
                  },
                }, text.chooseImage),
                h('button', {
                  type: 'button',
                  className: 'dsh-orb-set-button dsh-orb-set-ghost',
                  disabled,
                  onClick: () => { void mutate('/.dsh-orb/avatar/restore', {}) },
                }, text.restoreDefault))),
            avatarMessage ? h('p', { className: 'dsh-orb-set-error', role: 'alert' }, avatarMessage) : null,
            presetGallery(text, snap, disabled, mutate)),
          card(text.overlayTitle, text.overlayDescription, h(ModelPicker, {
            label: text.overlayTitle,
            catalog: state.catalog,
            current: snap.overlay,
            disabled,
            onSelect: (selection) => { void mutate('/.dsh-orb/overlay-model', selection) },
          })),
          card(text.backgroundTitle, text.backgroundDescription, h(ModelPicker, {
            label: text.backgroundTitle,
            catalog: state.catalog,
            current: snap.background,
            disabled,
            onSelect: (selection) => { void mutate('/.dsh-orb/background-model', selection) },
          })),
          card(text.millifractionTitle, text.millifractionDescription, h(Toggle, {
            checked: snap.millifractionEnabled === true,
            label: text.millifractionToggle,
            disabled,
            onChange: (enabled) => {
              if (enabled === snap.millifractionEnabled) return
              if (!window.confirm(text.millifractionConfirm)) return
              void mutate('/.dsh-orb/millifraction', { enabled })
            },
          })),
          speechCard(text, snap, disabled, mutate),
          h(PitchCard, { text }),
          voiceCard(text, snap, disabled, mutate),
          snap.tcc && snap.tcc.applicable ? tccCard(text, snap, disabled, mutate) : null))
    }

    function helperNotice(text, snap) {
      if (snap.helperError === 'helper-exited') {
        return h('p', { className: 'dsh-orb-set-error', role: 'alert' }, text.helperFailed)
      }
      if (snap.helperError === 'runtime-download') {
        return h('p', { className: 'dsh-orb-set-error', role: 'alert' }, text.runtimeFailed)
      }
      return null
    }

    function card(title, description, control) {
      return h('section', { className: 'dsh-orb-set-card dsh-orb-set-row' },
        h('div', null, h('h3', null, title), h('p', null, description)),
        control)
    }

    /**
     * Read-aloud settings: the feature switch, whether replies start themselves, and where the
     * service lives.
     *
     * The endpoint is a free-text field rather than a `<select>` because the service is a separate
     * program the user runs, and its port is whatever they chose. It saves on blur or Enter instead
     * of on every keystroke, so a half-typed address never reaches the profile — and the local draft
     * resets whenever the stored value changes underneath it, which is what makes an external edit
     * (or a rejected save) show up instead of being silently overwritten by the stale draft.
     */
    function speechCard(text, snap, disabled, mutate) {
      const speech = snap.speech || { enabled: false, autoPlay: false, endpoint: '' }
      return h('section', { className: 'dsh-orb-set-card' },
        h('h3', null, text.speechTitle),
        h('p', null, text.speechDescription),
        h('div', { className: 'dsh-orb-set-speech' },
          card(text.speechEnable, text.speechEnableDescription, h(Toggle, {
            checked: speech.enabled === true,
            label: text.speechEnable,
            disabled,
            onChange: (enabled) => { void mutate('/.dsh-orb/speech', { enabled }) },
          })),
          // Automatic playback is meaningless with the feature off, so it is disabled rather than
          // hidden: the row stays put and turns interactive when the switch above comes on.
          card(text.speechAutoPlay, text.speechAutoPlayDescription, h(Toggle, {
            checked: speech.autoPlay === true,
            label: text.speechAutoPlay,
            disabled: disabled || speech.enabled !== true,
            onChange: (autoPlay) => { void mutate('/.dsh-orb/speech', { autoPlay }) },
          })),
          h('div', { className: 'dsh-orb-set-speech-endpoint' },
            h('div', null,
              h('h3', null, text.speechEndpoint),
              h('p', null, text.speechEndpointDescription)),
            h(EndpointField, {
              text,
              value: speech.endpoint,
              disabled,
              onSave: (endpoint) => { void mutate('/.dsh-orb/speech', { endpoint }) },
            }))))
    }

    /** The recorder's tuning: the one number a voice user actually wants to move. */
    function voiceCard(text, snap, disabled, mutate) {
      return h('section', { className: 'dsh-orb-set-card' },
        h('h3', null, text.voiceTitle),
        h('p', null, text.voiceDescription),
        h('div', { className: 'dsh-orb-set-voice' },
          h(SilenceSlider, {
            text,
            value: silenceOf(snap.dictation),
            disabled,
            onChange: (silenceMs) => { void mutate('/.dsh-orb/wake/silence', { silenceMs }) },
          }),
          h('p', null, text.voiceSilenceHint)))
    }

    /** Endpoint text field with its own draft, so typing is never interrupted by a re-render. */
    function EndpointField(props) {
      const [draft, setDraft] = React.useState(props.value)
      const [invalid, setInvalid] = React.useState(false)
      React.useEffect(() => {
        setDraft(props.value)
        setInvalid(false)
      }, [props.value])

      function commit() {
        const next = draft.trim()
        if (next === props.value) return
        if (!/^https?:\/\/[^\s/]+/i.test(next)) {
          setInvalid(true)
          return
        }
        setInvalid(false)
        props.onSave(next)
      }

      return h('div', { className: 'dsh-orb-set-endpoint-row' },
        h('input', {
          type: 'text',
          className: 'dsh-orb-set-input',
          value: draft,
          spellCheck: false,
          disabled: props.disabled,
          'aria-label': props.text.speechEndpoint,
          'aria-invalid': invalid ? 'true' : 'false',
          onChange: (event) => { setDraft(event.target.value) },
          onKeyDown: (event) => { if (event.key === 'Enter') commit() },
          onBlur: commit,
        }),
        h('button', {
          type: 'button',
          className: 'dsh-orb-set-button',
          disabled: props.disabled,
          onClick: commit,
        }, props.text.speechSaveEndpoint),
        invalid ? h('p', { className: 'dsh-orb-set-error', role: 'alert' }, props.text.speechEndpointInvalid) : null)
    }

    /** The shipped GIFs as clickable animated thumbnails; the host owns the list, this page the names. */
    function presetGallery(text, snap, disabled, mutate) {
      const presets = Array.isArray(snap.avatarPresets) ? snap.avatarPresets : []
      if (presets.length === 0) return null
      const names = text.avatarPresetNames || {}
      return h('div', { className: 'dsh-orb-set-presets' },
        h('p', { className: 'dsh-orb-set-presets-title', id: 'dsh-orb-presets-label' }, text.avatarBuiltin),
        h('div', { className: 'dsh-orb-set-presets-row', role: 'group', 'aria-labelledby': 'dsh-orb-presets-label' },
          ...presets.map((preset) => {
            const name = names[preset.id] || preset.id
            const selected = snap.avatarPresetId === preset.id
            return h('button', {
              key: preset.id,
              type: 'button',
              className: `dsh-orb-set-preset${selected ? ' is-selected' : ''}`,
              'aria-pressed': selected ? 'true' : 'false',
              title: name,
              disabled,
              onClick: () => { void mutate('/.dsh-orb/avatar/preset', { preset: preset.id }) },
            },
              h('img', { src: preset.url, alt: '', draggable: false }),
              h('span', null, name))
          })))
    }

    function tccCard(text, snap, disabled, mutate) {
      const name = snap.tcc.appName || ''
      return h('section', { className: 'dsh-orb-set-card' },
        h('h3', null, text.tccTitle),
        h('p', null, text.tccDescription),
        h('p', null, text.tccAppHint.replaceAll('{name}', name)),
        tccRow(text.tccScreenName, text.tccScreenReason, text.tccScreenPath, statusText(text, snap.tcc.screen), text.tccScreenOpen, disabled || snap.tcc.screen === 'granted', () => {
          void mutate('/.dsh-orb/tcc', { right: 'screen' })
        }),
        tccRow(text.tccAccessibilityName, text.tccAccessibilityReason, text.tccAccessibilityPath, statusText(text, snap.tcc.accessibility), text.tccAccessibilityOpen, disabled || snap.tcc.accessibility === 'granted', () => {
          void mutate('/.dsh-orb/tcc', { right: 'accessibility' })
        }),
        h('p', null, text.tccFooter.replaceAll('{name}', name)))
    }

    function tccRow(name, reason, path, status, open, disabled, onClick) {
      return h('div', { className: 'dsh-orb-set-tcc' },
        h('div', null,
          h('h4', null, name),
          h('p', null, reason),
          h('p', null, path),
          h('p', { className: 'dsh-orb-set-status' }, status)),
        h('button', { type: 'button', className: 'dsh-orb-set-button', disabled, onClick }, open))
    }

    const style = `
.dsh-orb-set { display: flex; flex-direction: column; gap: 16px; max-width: 720px; color: inherit; }
.dsh-orb-set-title { margin: 0; font-size: 20px; }
.dsh-orb-set-intro, .dsh-orb-set p { margin: 4px 0 0; color: color-mix(in srgb, currentColor 72%, transparent); font-size: 13px; line-height: 1.45; }
.dsh-orb-set-banner, .dsh-orb-set-error { color: inherit; }
.dsh-orb-set-fields { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.dsh-orb-set-card { border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 12px; padding: 14px 16px; }
.dsh-orb-set-row, .dsh-orb-set-avatar-row, .dsh-orb-set-tcc { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
.dsh-orb-set h3, .dsh-orb-set h4 { margin: 0; font-size: 14px; }
.dsh-orb-set-avatar { width: 72px; height: 72px; border-radius: 50%; object-fit: cover; background: color-mix(in srgb, currentColor 8%, transparent); }
.dsh-orb-set-presets { margin-top: 10px; }
.dsh-orb-set-presets-title { margin: 0; font-size: 12px; }
.dsh-orb-set-presets-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.dsh-orb-set-preset { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 72px; padding: 5px 2px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.dsh-orb-set-preset img { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; background: color-mix(in srgb, currentColor 8%, transparent); }
.dsh-orb-set-preset span { font-size: 11px; line-height: 1.2; }
.dsh-orb-set-preset:hover { border-color: color-mix(in srgb, currentColor 20%, transparent); }
.dsh-orb-set-preset.is-selected { border-color: var(--dsw-alias-button-info-fill, #2f6fed); }
.dsh-orb-set-actions, .dsh-orb-set-pickers { display: flex; gap: 8px; align-items: center; }
.dsh-orb-set-button, .dsh-orb-set select { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); background: transparent; color: inherit; border-radius: 8px; padding: 6px 10px; font: inherit; }
.dsh-orb-set-ghost { border-color: transparent; }
.dsh-orb-set-switch { width: 40px; height: 24px; border-radius: 999px; border: 0; background: color-mix(in srgb, currentColor 18%, transparent); position: relative; flex: none; }
.dsh-orb-set-switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--dsw-static-neutral-bluish-00, white); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); transition: transform 120ms ease; }
.dsh-orb-set-switch.is-on { background: var(--dsw-alias-button-info-fill, #2f6fed); }
.dsh-orb-set-switch.is-on::after { transform: translateX(16px); }
.dsh-orb-set-tcc { margin-top: 12px; }
.dsh-orb-set-status { font-weight: 600; }
.dsh-orb-set-fields:disabled { opacity: 0.55; }
.dsh-orb-set-speech { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
/* Nested rows lose their border: the outer card already frames them, and a border inside a border reads as a box in a box. */
.dsh-orb-set-speech > .dsh-orb-set-card { padding: 0; border: 0; border-radius: 0; }
.dsh-orb-set-speech-endpoint { padding-top: 10px; border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
.dsh-orb-set-endpoint-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
.dsh-orb-set-input { flex: 1 1 220px; min-width: 0; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); background: transparent; color: inherit; border-radius: 8px; padding: 6px 10px; font: inherit; }
.dsh-orb-set-input[aria-invalid='true'] { border-color: var(--dsw-alias-state-danger-primary, #d54941); }
.dsh-orb-set-endpoint-row .dsh-orb-set-error { flex: 1 0 100%; margin: 0; }
.dsh-orb-set-voice { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.dsh-orb-set-silence, .dsh-orb-set-pitch { display: flex; flex-direction: column; gap: 6px; }
.dsh-orb-set-silence-head, .dsh-orb-set-pitch-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.dsh-orb-set-silence-value, .dsh-orb-set-pitch-value { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dsh-orb-set-range { width: 100%; accent-color: var(--dsw-alias-button-info-fill, #2f6fed); }
/* The wake switch in the composer row. It sizes like the composer's own activity button (28px),
   takes its ink from currentColor so both themes work without a second rule, and dims rather
   than recolours when off — a struck-through microphone should read as "not listening", not as a
   different button. */
.dsh-orb-wake-seat { flex: 1 1 0; display: flex; align-items: center; justify-content: center; min-width: 0; }
.dsh-orb-wake-toggle { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 28px; min-width: 28px; padding: 0 7px; border: 0; border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary, currentColor); cursor: pointer; font: inherit; font-size: 12px; line-height: 1; -webkit-app-region: no-drag; }
.dsh-orb-wake-toggle:hover { background: var(--dsw-alias-interactive-bg-hover-solid, color-mix(in srgb, currentColor 10%, transparent)); }
.dsh-orb-wake-toggle:focus-visible { outline: 2px solid var(--dsw-alias-button-info-fill, #2f6fed); outline-offset: 1px; }
.dsh-orb-wake-toggle[aria-pressed='false'] { opacity: 0.55; }
/* Off is a wave that has gone quiet with a line through it: the bars step back so the line
   still reads as "no" at 16px, where both would otherwise smear into one grey blob. */
.dsh-orb-wake-toggle[aria-pressed='false'] .dsh-orb-wake-bar { opacity: 0.4; }
.dsh-orb-wake-toggle[aria-pressed='true'] .dsh-orb-wake-slash { display: none; }
.dsh-orb-wake-toggle[aria-pressed='true'] { color: var(--dsw-alias-label-primary, currentColor); }
.dsh-orb-wake-slash { display: block; stroke-width: 2; }
/* The dictation button beside the switch. It borrows the switch's box — same 28px seat, same ink,
   same hover — because the two are neighbours and a second shape would read as a different family.
   While the microphone is open it goes red and the capsule fills: the one state a person has to be
   able to see without reading anything. */
.dsh-orb-mic-toggle[data-recording='true'] { opacity: 1; color: var(--dsw-alias-state-danger-primary, #d54941); }
.dsh-orb-mic-toggle[data-recording='true'] .dsh-orb-mic-body { fill: currentColor; fill-opacity: 0.25; }
/* The live waveform, while this page's own recorder has the device open. It sits above the
   composer, near the microphone that opened it, and is drawn from the samples the recorder
   measures — the same bars the voice plugin drew, on the same scale. */
.dsh-orb-level {
  position: fixed;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  box-sizing: border-box;
  width: 144px;
  height: 26px;
  padding: 0 6px;
  border-radius: 13px;
  background: var(--dsw-alias-bg-overlay, rgba(24, 24, 26, 0.72));
  color: var(--dsw-alias-state-danger-primary, #d54941);
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.16s ease;
}
.dsh-orb-level[data-on='true'] { opacity: 1; }
.dsh-orb-level-bar {
  display: block;
  width: 2px;
  height: 2px;
  border-radius: 1px;
  background: currentColor;
  transition: height 0.06s linear;
}
`

    // ── main-window voice ───────────────────────────────────────────────────────
    //
    // TODO(main-window-voice): the ball's black chat panel no longer opens on a wake. A wake now
    // hands the turn to the main window, which records it with its own microphone and its own
    // voice-activity detection — the ball's ear, not the voice plugin's. `noSpeechMs`, `silenceMs`
    // and `maxSeconds` are the ball's own values in `orb-wake.json`, sent with the hand-off, and the
    // host still decides whether the transcript is sent (`send`). Restore the panel path in
    // `assets/shell.js` when the panel returns.
    async function mainVoiceBridge() {
      // Without a real page there is no microphone to press and no row to read. The settings test
      // harness loads this file in a bare vm, where a polling loop would only keep the process
      // alive after the last test.
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
      if (window.__dshOrbMainVoice === true) return
      window.__dshOrbMainVoice = true
      const zh = `${document.documentElement?.lang || ''}${navigator.language || ''}`.toLowerCase().startsWith('zh')
      // Only the send button is still read from the page: the microphone is this page's own now,
      // so there is no record row to look for and no hand-insertion step to press.
      const labels = {
        send: zh ? '发送' : 'Send',
      }
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const withLabel = () => [...document.querySelectorAll('button[aria-label]')]
      const byLabel = (want, pattern) => withLabel().find((button) => {
        const label = button.getAttribute('aria-label') || ''
        return label === want || (pattern !== undefined && pattern.test(label))
      })
      // A hand-off step is invisible from outside: "never found the microphone" and "pressed a
      // button that did nothing" look identical on screen. One line per step goes to the host,
      // which appends it to the log beside the ball's own tracing.
      const tell = (note) => {
        try {
          void fetch('/.dsh-orb/client-report', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              at: new Date().toISOString(),
              phase: 'voice',
              note,
              href: typeof location === 'undefined' ? '' : location.pathname,
            }),
          }).catch(() => {})
        } catch (_error) {
          // Diagnosis only.
        }
      }
      const sendButton = () => byLabel(labels.send, /发送|send/i)
      /**
       * The composer's editor root.
       *
       * The composer is not a textarea: it is a Lexical editor, a contenteditable with a document
       * of its own behind it (`data-composer-chip`, `data-composer-command` nodes). Writing to that
       * element's DOM leaves the editor's state empty — the words are on screen, the send button
       * stays disabled, and pressing it sends nothing, which is exactly the failure this locates.
       * The editor is found from the send button outwards, because those two are the composer's own
       * halves and no other contenteditable on the page shares their parent.
       */
      const composerEditor = () => {
        try {
          const button = sendButton()
          if (button !== undefined) {
            let node = button.parentElement
            for (let depth = 0; depth < 10 && node !== null; depth += 1) {
              const found = node.querySelector('[contenteditable="true"], [contenteditable=""]')
              if (found !== null && found.getBoundingClientRect().height > 0) return found
              node = node.parentElement
            }
          }
          // No send button to start from: the composer is the lowest editor on the page.
          let best
          let lowest = -Infinity
          for (const node of document.querySelectorAll('[contenteditable="true"], [contenteditable=""]')) {
            const rect = node.getBoundingClientRect()
            if (rect.height <= 0 || rect.width <= 0) continue
            if (rect.bottom > lowest) {
              lowest = rect.bottom
              best = node
            }
          }
          return best
        } catch {
          return undefined
        }
      }
      const composerText = () => {
        const editor = composerEditor()
        if (editor !== undefined) return editor.textContent || ''
        const area = document.querySelector('textarea')
        if (area !== null) return area.value
        return ''
      }
      // The ball's cues, note for note — same sine pairs, same levels, copied from `wake.js` so a
      // person who learned "up means it listens, down means it stopped" on the ball hears the same
      // language here. Nothing to read while the microphone is open, so sound is the only feedback
      // this page can give at all.
      const CUE_OPEN = [{ at: 0, freq: 1568, len: 0.08 }]
      const CUE_HEARD = [{ at: 0, freq: 1320, len: 0.1 }, { at: 0.12, freq: 880, len: 0.18 }]
      const CUE_EMPTY = [{ at: 0, freq: 392, len: 0.09 }, { at: 0.16, freq: 294, len: 0.16 }]
      const CUE_SHUT = [{ at: 0, freq: 440, len: 0.13 }]
      // Not a ball cue: there the composer simply closes. One note, because two read as a word being
      // said rather than a thing being done — but longer and rounder than anything else here, so it
      // is not mistaken for the microphone opening: that one is a 80 ms sine blip at 1568 Hz, this
      // is a 180 ms triangle chime at 1175, a fourth below it, with nothing to mistake it for.
      const CUE_SENT = [{ at: 0, freq: 1175, len: 0.18, type: 'triangle' }]
      // One cue is audible at a time. The cues are a small language — up for "listening", down for
      // "stopped" — and two of them at once is not twice the information, it is a buzz: recognising
      // a two-word sentence takes about as long as the "heard" cue rings, so the "sent" cue used to
      // start on top of it. A cue that arrives while another is still ringing now takes the channel
      // over: the old one is faded out in 20 ms, long enough not to click, short enough to read as
      // a deliberate cut.
      let ringing
      let toneCtx
      /** Silence the cue that is still sounding, so the next one starts from quiet. */
      function hush(at) {
        const previous = ringing
        ringing = undefined
        if (previous === undefined) return
        const param = previous.gain.gain
        try {
          if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(at)
          else {
            const held = Math.max(0.0001, param.value)
            param.cancelScheduledValues(at)
            param.setValueAtTime(held, at)
          }
          param.exponentialRampToValueAtTime(0.0001, at + 0.02)
        } catch {
          /* a gain that is already gone needs no fader */
        }
        for (const osc of previous.oscs) {
          try { osc.stop(at + 0.03) } catch { /* already stopped */ }
        }
      }
      function tone(notes, level) {
        try {
          const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext
          if (typeof Ctor !== 'function') return
          if (toneCtx === undefined || toneCtx.state === 'closed') toneCtx = new Ctor()
          const ctx = toneCtx
          hush(ctx.currentTime)
          // A wake word is speech, not a gesture, so a context that has never been clicked into
          // life may still be suspended. Asking is all that can be done; a silent cue is not a
          // reason to break the hand-off.
          if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
          const gain = ctx.createGain()
          gain.gain.value = 0.0001
          gain.connect(ctx.destination)
          const start = ctx.currentTime + 0.02
          const oscs = []
          for (const note of notes) {
            const osc = ctx.createOscillator()
            // A note may name its own waveform; the ball's cues are all sine, and only the sent cue
            // wants to sound like a different instrument.
            osc.type = note.type === undefined ? 'sine' : note.type
            osc.frequency.setValueAtTime(note.freq, start + note.at)
            osc.connect(gain)
            osc.start(start + note.at)
            osc.stop(start + note.at + note.len)
            oscs.push(osc)
          }
          // The envelope outlives the last note by a fixed tail, so the cue rings out to silence
          // instead of being cut off, and the node is dropped once it has.
          const last = notes[notes.length - 1]
          const total = (last === undefined ? 0 : last.at + last.len) + 0.08
          gain.gain.setValueAtTime(0.0001, start)
          gain.gain.exponentialRampToValueAtTime(level, start + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.0001, start + total)
          // This cue now owns the channel, so a cue asked for in the next 300 ms has something to
          // cut instead of something to talk over.
          ringing = { gain, oscs }
          setTimeout(() => {
            try { gain.disconnect() } catch { /* already gone */ }
            if (ringing !== undefined && ringing.gain === gain) ringing = undefined
          }, (total + 0.5) * 1000)
        } catch {
          /* a missing tone must never break the hand-off */
        }
      }
      // Chromium only lets an audio context start inside a gesture, and a wake word is not one.
      // A click or a keypress anywhere in the page pre-arms it, so the first cue already has a
      // running context to lean on. Whichever of the two happens first is enough.
      const armAudio = () => {
        try {
          if (toneCtx === undefined) {
            const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext
            if (typeof Ctor !== 'function') return
            toneCtx = new Ctor()
            if (toneCtx.state === 'suspended') void toneCtx.resume().catch(() => {})
          }
          // Both listeners go once there is a context, however it got created.
          document.removeEventListener('pointerdown', armAudio, true)
          document.removeEventListener('keydown', armAudio, true)
        } catch {
          /* no audio in this page; the cues stay silent */
        }
      }
      try {
        document.addEventListener('pointerdown', armAudio, true)
        document.addEventListener('keydown', armAudio, true)
      } catch {
        /* a document without listeners is a document without cues */
      }
      /**
       * Press send, and report whether it went.
       *
       * The button is disabled while the editor is empty, and the editor learns about new text one
       * commit after it lands, so the press waits for the button instead of for a fixed delay. A
       * click on a disabled button is a no-op that looks exactly like a click that worked, so the
       * answer is read back from the box: the words are gone, or they are not.
       */
      async function submit(text) {
        const gone = () => {
          const left = composerText().trim()
          return left === '' || !left.includes(String(text || '').slice(0, 2))
        }
        for (let attempt = 0; attempt < 14; attempt += 1) {
          const button = sendButton()
          if (button !== undefined && !button.disabled) {
            button.click()
            for (let settle = 0; settle < 12; settle += 1) {
              await sleep(100)
              if (gone()) return true
            }
            tell('send: the box still holds the words after the press')
            return false
          }
          await sleep(100)
        }
        const button = sendButton()
        tell(`send: no pressable button (${button === undefined ? 'none found' : 'found, still disabled'})`)
        const editor = composerEditor()
        if (editor !== undefined) {
          try {
            editor.focus()
            editor.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
            }))
            for (let settle = 0; settle < 10; settle += 1) {
              await sleep(100)
              if (gone()) return true
            }
          } catch {
            /* the fallback was the last door */
          }
        }
        // A page whose composer really is a textarea submits on Enter there instead.
        const area = (() => {
          try {
            return document.querySelector('textarea')
          } catch {
            return null
          }
        })()
        if (area !== null && area !== undefined && editor === undefined) {
          try {
            area.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
            }))
            for (let settle = 0; settle < 10; settle += 1) {
              await sleep(100)
              if (gone()) return true
            }
          } catch {
            /* nothing else to press */
          }
        }
        return false
      }
      let busy = false

      // --- the exchange, as the ball runs it -----------------------------------------------
      // A voice loop has one exit the user can take without touching anything: saying so. The
      // list and the trimming below are the ball's own (`voice-closing.js`); a test keeps the two
      // copies equal, because a phrase added on one side only is a phrase that stops working.
      const CLOSING_PHRASES = ['你退下', '你退一下', '退下', '你可以退了', '你可以休息了', '没你事了', '没你事儿了', '没你的事了', '没你的事儿了', '不需要你了', '先这样', '就先这样', '先这么办', '就先这么办', '先这样办', '就这样', '到此为止', '先到这', '结束', '结束吧', '收工', '收工吧', '散会', '没事了', '不用了', '我走了', '我先走了', '拜拜', '再见', 'that is all', 'thats all', 'that is it', 'thats it', 'we are done', 'were done', 'im done', 'you can go', 'stand down', 'nothing else', 'done for now', 'stop here', 'leave it there', 'goodbye', 'bye']
      const LEADING_FILLERS = ['那', '嗯', '好', '行', '呃', '哎', '唉', '哦', '额', 'ok', 'okay', 'alright', 'well', 'so']
      const TRAILING_PARTICLES = ['吧', '啊', '呀', '了', '啦', '哈', '哦', '嘛', '呢', '呗', '喔', '噢', 'please', 'now']
      const normalizeSpeech = (text) => String(text === null || text === undefined ? '' : text)
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]/gu, '')
      const CLOSING_SET = new Set(CLOSING_PHRASES.map((phrase) => normalizeSpeech(phrase)))
      function isClosingPhrase(text) {
        const whole = normalizeSpeech(text)
        // Equality after trimming, never "contains": a sentence that merely ends the way a closer
        // does ("就这样把它删掉") is ordinary speech.
        if (whole === '' || whole.length > 24) return false
        const tails = [whole]
        let trimmed = whole
        for (let round = 0; round < 2; round += 1) {
          const particle = TRAILING_PARTICLES.find((value) => trimmed.length > value.length && trimmed.endsWith(value))
          if (particle === undefined) break
          trimmed = trimmed.slice(0, -particle.length)
          tails.push(trimmed)
        }
        for (const tail of tails) {
          let head = tail
          if (CLOSING_SET.has(head)) return true
          for (let round = 0; round < 2; round += 1) {
            const filler = LEADING_FILLERS.find((prefix) => head.length > prefix.length && head.startsWith(prefix))
            if (filler === undefined) break
            head = head.slice(filler.length)
            if (CLOSING_SET.has(head)) return true
          }
        }
        return false
      }

      // While the agent is answering, the composer's primary button offers Stop. That label is the
      // only "still working" the page exposes, and a voice turn leaves the draft empty, which is
      // what keeps the button on Stop instead of Send for the whole reply.
      const AGENT_STOP = /^(停止|停止生成|停止回答|stop|stop generating)$/i
      const replyStop = () => byLabel(undefined, AGENT_STOP)

      /**
       * Resolve when the reply has finished, or after `limitMs` of continuous work.
       *
       * Until Stop has been seen once the wait is short — a turn that ends before the button is
       * ever painted must not cost a full grace period. After a sighting, the wait is the
       * disappearance of that button.
       */
      async function waitForReply(limitMs = 300_000) {
        const begin = Date.now()
        let sawStop = false
        while (Date.now() - begin < limitMs) {
          if (replyStop() !== undefined) sawStop = true
          else if (sawStop || Date.now() - begin > 2500) return true
          await sleep(120)
        }
        return false
      }

      /**
       * Take the closing phrase back out of the draft.
       *
       * The page inserts a transcript by itself, so by the time the words can be read they are
       * already in the composer. Clearing it needs the native setter: React keeps its own copy of
       * the value and ignores a plain assignment. A page that refuses keeps the draft and loses
       * only the tidiness — the exchange still ends, and nothing is sent.
       */
      function clearDraft() {
        try {
          const area = document.querySelector('textarea')
          if (area !== null) {
            const setter = typeof HTMLTextAreaElement === 'function'
              ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
              : undefined
            if (setter === undefined) return false
            setter.call(area, '')
            area.dispatchEvent(new Event('input', { bubbles: true }))
            return composerText().trim() === ''
          }
          const editable = document.querySelector('[contenteditable="true"]')
          if (editable === null) return false
          editable.textContent = ''
          editable.dispatchEvent(new Event('input', { bubbles: true }))
          return composerText().trim() === ''
        } catch {
          return false
        }
      }

      // --- the ball's own ears, in this window ------------------------------------------------
      //
      // Both doors into a voice turn — the composer's microphone button and a wake-word hand-off
      // from the ball — come through here. The page opens the device, measures the RMS of the
      // samples it actually receives, decides by itself when the sentence is over, and posts the
      // finished WAV to the host, whose transcriber is the very service the ball talks to. Same
      // engine, same numbers, nothing animated in between. The voice plugin's own microphone is
      // never pressed: its waveform is an animation, so the level read from it is a guess and the
      // pause built on that guess is approximate.

      const SAMPLE_RATE = 16_000
      const DICTATION_FALLBACK = { silenceMs: 2500, maxSeconds: 15, autoSend: false, noSpeechMs: 6000 }
      const numberOr = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

      /**
       * A signal that gives up after `ms`, where the page has one.
       *
       * Every request in a turn is answered on loopback, so the wait is short — unless the host is
       * not answering at all, and then a turn that waits forever is a button that is dead until the
       * page is reloaded. A page without `AbortSignal.timeout` simply waits, as before.
       */
      const giveUpAfter = (ms) => {
        try {
          return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(ms)
            : undefined
        } catch {
          return undefined
        }
      }

      /** The pause, the ceiling and the auto-send rule, as the black panel stores them. */
      async function dictationSettings() {
        try {
          const signal = giveUpAfter(2000)
          const body = await request('/.dsh-orb/dictation', signal === undefined ? undefined : { signal })
          if (body === null || typeof body !== 'object') return DICTATION_FALLBACK
          return {
            silenceMs: numberOr(body.silenceMs, DICTATION_FALLBACK.silenceMs),
            maxSeconds: numberOr(body.maxSeconds, DICTATION_FALLBACK.maxSeconds),
            autoSend: body.autoSend === true,
            noSpeechMs: numberOr(body.noSpeechMs, DICTATION_FALLBACK.noSpeechMs),
          }
        } catch {
          // A page that cannot read the settings still records on the shipped numbers rather than
          // refusing the press: the numbers are the defaults the ball ships with anyway.
          return DICTATION_FALLBACK
        }
      }

      const closeStream = (stream) => {
        try {
          for (const track of stream.getTracks()) track.stop()
        } catch {
          /* a stream that refuses to close is the OS's problem, not the turn's */
        }
      }

      /** Root-mean-square of one frame — the quantity the ball's recorder measures. */
      function levelOf(frame) {
        let sum = 0
        for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i]
        return Math.sqrt(sum / frame.length)
      }

      /** Join the recorded frames into one contiguous buffer. */
      function concatFrames(frames) {
        let length = 0
        for (const frame of frames) length += frame.length
        const merged = new Float32Array(length)
        let offset = 0
        for (const frame of frames) {
          merged.set(frame, offset)
          offset += frame.length
        }
        return merged
      }

      /**
       * Resample to 16 kHz, linearly.
       *
       * `new AudioContext({ sampleRate })` is honoured here, so this is the fallback for a machine
       * that refused it. Linear interpolation is enough for speech at this ratio, and the ball's
       * own converter does the same thing when its context comes up at the device rate.
       */
      function resample(input, from, to) {
        if (from === to || input.length === 0) return input
        const ratio = to / from
        const length = Math.max(1, Math.round(input.length * ratio))
        const output = new Float32Array(length)
        for (let i = 0; i < length; i += 1) {
          const position = i / ratio
          const left = Math.floor(position)
          const right = Math.min(input.length - 1, left + 1)
          const weight = position - left
          output[i] = input[left] * (1 - weight) + input[right] * weight
        }
        return output
      }

      /** 16-bit mono PCM in a RIFF container — the shape the host's transcriber accepts. */
      function encodeWav(samples, sampleRate) {
        const bytes = new ArrayBuffer(44 + samples.length * 2)
        const view = new DataView(bytes)
        const text = (offset, value) => {
          for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i))
        }
        text(0, 'RIFF')
        view.setUint32(4, 36 + samples.length * 2, true)
        text(8, 'WAVE')
        text(12, 'fmt ')
        view.setUint32(16, 16, true)                 // PCM chunk size
        view.setUint16(20, 1, true)                  // format: PCM
        view.setUint16(22, 1, true)                  // channels
        view.setUint32(24, sampleRate, true)
        view.setUint32(28, sampleRate * 2, true)     // bytes per second
        view.setUint16(32, 2, true)                  // bytes per frame
        view.setUint16(34, 16, true)                 // bits per sample
        text(36, 'data')
        view.setUint32(40, samples.length * 2, true)
        let offset = 44
        for (let i = 0; i < samples.length; i += 1) {
          const value = Math.max(-1, Math.min(1, samples[i]))
          view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true)
          offset += 2
        }
        return new Blob([bytes], { type: 'audio/wav' })
      }

      /**
       * Record one sentence and hand back the WAV, or say why there is none.
       *
       * The three limits are the ball's: give up when nobody speaks, stop after a pause once
       * somebody did, and never hold the device past the ceiling. The level comes from the samples,
       * so the noise floor of this room is measured rather than assumed — a quiet room lands around
       * 0.002 and speech an order of magnitude above it, and the threshold is set from what was
       * actually heard instead of a constant borrowed from another window.
       */
      async function recordUtterance(limits) {
        const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
        if (media === undefined || typeof media.getUserMedia !== 'function') {
          return { ok: false, reason: '这个窗口没有可用的麦克风' }
        }
        let stream
        try {
          stream = await media.getUserMedia({
            // The ball's own constraints, unchanged: echo cancellation keeps our own cue and the
            // reply from being recorded as the user, while noise suppression and automatic gain
            // are off because both of them rewrite the level this recorder is about to measure —
            // suppression eats the quiet first syllables, and gain lifts the room's floor until
            // every pause looks like speech.
            audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
          })
        } catch (error) {
          const name = error && typeof error.name === 'string' ? error.name : ''
          return { ok: false, reason: name === 'NotAllowedError' ? '麦克风没有授权' : '打不开麦克风' }
        }
        // The device can take a few hundred milliseconds to open, and the button is already red by
        // then. A press that came in during that wait is a press on a turn whose only sample so far
        // is silence: closing the device here is faster than opening it for a sentence nobody is
        // going to say, and it is the one place that knows the stream exists to close.
        if (stopRequested) {
          stopRequested = false
          closeStream(stream)
          return { ok: false, reason: '你结束了这次录音', empty: true, stopped: true }
        }
        const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext
        if (typeof Ctor !== 'function') {
          closeStream(stream)
          return { ok: false, reason: '这个窗口没有音频上下文' }
        }
        let ctx
        try {
          ctx = new Ctor({ sampleRate: SAMPLE_RATE })
        } catch {
          try {
            ctx = new Ctor()
          } catch {
            closeStream(stream)
            return { ok: false, reason: '打不开音频上下文' }
          }
        }
        if (ctx.state === 'suspended') {
          try { await ctx.resume() } catch { /* the frames below simply stay empty */ }
        }
        const source = ctx.createMediaStreamSource(stream)
        const processor = typeof ctx.createScriptProcessor === 'function'
          ? ctx.createScriptProcessor(1024, 1, 1)
          : undefined
        if (processor === undefined) {
          closeStream(stream)
          try { await ctx.close() } catch { /* already gone */ }
          return { ok: false, reason: '这个窗口不支持录音' }
        }

        // Kept for the log: when a turn hears nobody, "the wrong device" and "a quiet room" look
        // identical from the outside, and the track's own label is what separates them.
        const track = typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks()[0] : undefined
        const device = track !== undefined && typeof track.label === 'string' ? track.label.slice(0, 32) : ''
        const frames = []
        const startedAt = Date.now()
        // The room's own level, measured rather than assumed: the trigger is a multiple of what
        // this device actually hears, not a constant borrowed from another window. Eight frames is
        // about half a second — long enough not to be a single click, short enough that a sentence
        // starting straight away is still judged against the room it started in. A window that is
        // loud all the way through is speech already in progress, not a floor, and is treated as
        // such below.
        const floorSamples = []
        let floor = 0
        let hot = 0
        let heard = false
        let lastVoiceAt = 0
        let peak = 0
        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0)
          frames.push(new Float32Array(input))
          const now = Date.now()
          const level = levelOf(input)
          if (level > peak) peak = level
          // Every other frame: the bars are 64 ms apart, and repainting them 16 times a second is
          // visibly smoother than the plugin's animation ever was without costing anything.
          if (frames.length % 2 === 0) {
            try { meterPush(level) } catch { /* the overlay is not the recorder */ }
          }
          if (floor === 0) {
            floorSamples.push(level)
            if (floorSamples.length < 8) return
            const sorted = [...floorSamples].sort((a, b) => a - b)
            const quiet = sorted[Math.floor(sorted.length * 0.25)] ?? 0.004
            const typical = sorted[Math.floor(sorted.length * 0.75)] ?? 0.006
            if (typical > 0.03) {
              // Half a second of nothing but loud frames is either a very noisy device or a
              // sentence that started before the recorder did. There is no floor to measure from
              // in that case, so the quietest of it is used and the sentence is assumed to be
              // under way: a recording that ran a little long is recoverable, one that stopped
              // before the first word is not.
              floor = Math.max(0.002, quiet * 1.2)
              heard = true
              lastVoiceAt = now
            } else {
              // Three quarters of the way up the quiet frames: the room and its ordinary bumps,
              // not its loudest click. Everything below is a multiple of this.
              floor = Math.max(0.002, typical)
            }
            return
          }
          // Two frames in a row to start — a single bump is a door, a chair, or this machine's own
          // fan — and only one to keep going, because a pause between syllables is a real pause
          // and must not be scored as the end of the sentence.
          const threshold = heard ? Math.max(0.006, floor * 1.6) : Math.max(0.009, floor * 2.5)
          if (level > threshold) {
            hot += 1
            if (heard || hot >= 2) {
              heard = true
              lastVoiceAt = now
            }
          } else {
            hot = 0
          }
        }
        source.connect(processor)
        // An unconnected ScriptProcessor is never pulled. The silent gain in front of the
        // destination is what pulls it without putting anything on the speaker.
        const sink = ctx.createGain()
        sink.gain.value = 0
        processor.connect(sink)
        sink.connect(ctx.destination)

        let ending = 'ceiling'
        for (;;) {
          const now = Date.now()
          if (stopRequested) {
            stopRequested = false
            ending = 'stop'
            break
          }
          if (!heard && now - startedAt >= limits.noSpeechMs) { ending = 'quiet'; break }
          if (heard && now - lastVoiceAt >= limits.silenceMs) { ending = 'spoken'; break }
          if (now - startedAt >= limits.maxSeconds * 1000) break
          await sleep(50)
        }
        const elapsed = Date.now() - startedAt
        try {
          processor.onaudioprocess = null
          source.disconnect()
          processor.disconnect()
          sink.disconnect()
        } catch {
          /* the nodes are going away with the context either way */
        }
        closeStream(stream)
        const rate = ctx.sampleRate
        try { await ctx.close() } catch { /* already gone */ }
        tell(`composer recorder: ${elapsed}ms, end=${ending}, heard=${heard}, peak=${peak.toFixed(3)}, floor=${floor.toFixed(3)}, device="${device}"${track !== undefined && track.muted ? ' MUTED' : ''}`)

        if (!heard) {
          // A press that ended a turn with nothing in it is not a failure to hear: the user said
          // "stop" before the first word, and the cue for that is the closing one.
          const stopped = ending === 'stop'
          return { ok: false, reason: stopped ? '你结束了这次录音' : '没有听到说话', empty: true, stopped }
        }
        const merged = concatFrames(frames)
        const pcm = rate === SAMPLE_RATE ? merged : resample(merged, rate, SAMPLE_RATE)
        if (pcm.length === 0) return { ok: false, reason: '没有录到声音', empty: true, stopped: ending === 'stop' }
        return { ok: true, blob: encodeWav(pcm, SAMPLE_RATE), seconds: elapsed / 1000, stopped: ending === 'stop' }
      }

      /** Put the caret at the end of the editor, so an insert lands after what is already there. */
      function caretToEnd(editor) {
        try {
          const selection = window.getSelection()
          if (selection === null) return false
          const range = document.createRange()
          range.selectNodeContents(editor)
          range.collapse(false)
          selection.removeAllRanges()
          selection.addRange(range)
          return true
        } catch {
          return false
        }
      }

      /**
       * Put a transcript in the composer, through the editor rather than around it.
       *
       * `execCommand('insertText')` is the one call that produces the `beforeinput`/`input` pair an
       * editor listens to, at the caret, as if the text had been typed — which is what makes the
       * composer's own state change and the send button enable. A synthetic `beforeinput` is the
       * second attempt; writing the DOM is the last and only works where the composer is a plain
       * textarea, so it is tried only when there is no editor at all.
       */
      async function setDraft(whole, insert = whole) {
        const next = insert
        const editor = composerEditor()
        if (editor !== undefined) {
          const landed = () => (editor.textContent || '').includes(next.slice(0, 2))
          try {
            editor.focus()
            caretToEnd(editor)
            const typed = typeof document.execCommand === 'function'
              && document.execCommand('insertText', false, next)
            if (typed) {
              for (let attempt = 0; attempt < 8; attempt += 1) {
                if (landed()) break
                await sleep(20)
              }
              // The call only answers true when the browser itself carried the text in; a DOM
              // read-back that lags a frame is not a reason to insert it twice.
              return true
            }
            caretToEnd(editor)
            editor.dispatchEvent(new InputEvent('beforeinput', {
              inputType: 'insertText', data: next, bubbles: true, cancelable: true, composed: true,
            }))
            for (let attempt = 0; attempt < 8; attempt += 1) {
              if (landed()) return true
              await sleep(20)
            }
            tell('composer: the editor refused the text (execCommand and beforeinput both)')
          } catch (error) {
            tell(`composer: writing to the editor failed: ${error && error.message ? error.message : String(error)}`)
          }
        }
        try {
          const area = document.querySelector('textarea')
          if (area === null) return false
          const setter = typeof HTMLTextAreaElement === 'function'
            ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
            : undefined
          if (setter === undefined) return false
          // A plain textarea has no caret to insert at from outside, so it is written whole.
          setter.call(area, whole)
          area.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        } catch {
          return false
        }
      }

      /**
       * One press of the composer's dictation button: record, transcribe, write, maybe send.
       *
       * Every ending is a cue, because nothing on screen says what happened. A closing phrase is
       * the user getting off — it is dropped rather than typed, the same way the ball drops it.
       */
      // --- the level, on screen ----------------------------------------------------------------
      //
      // The voice plugin drew a waveform while it recorded; this page records itself now, so for a
      // while the listening half was audible and invisible. These are the same bars, fed from the
      // samples this recorder actually measures rather than from an animation.
      //
      // It is a body-level overlay on purpose: anything inserted into the composer's own subtree is
      // pruned by React on its next commit, which is what killed the first attempt at a switch here.
      const WAVE_BARS = 32
      let meter
      let meterBars = []
      let meterPushes = 0

      function meterEnsure() {
        if (meter !== undefined && meter.isConnected) return meter
        const node = document.createElement('div')
        node.className = 'dsh-orb-level'
        node.setAttribute('aria-hidden', 'true')
        node.setAttribute('data-on', 'false')
        const bars = []
        for (let index = 0; index < WAVE_BARS; index += 1) {
          const bar = document.createElement('span')
          bar.className = 'dsh-orb-level-bar'
          node.append(bar)
          bars.push(bar)
        }
        if (document.body !== null && document.body !== undefined) document.body.append(node)
        meter = node
        meterBars = bars
        return meter
      }

      /** Sit just above the microphone button that opened the device, or above the composer. */
      function meterPlace() {
        const node = meterEnsure()
        const width = 144
        const button = document.querySelector('.dsh-orb-mic-toggle')
        const rect = button !== null && typeof button.getBoundingClientRect === 'function'
          ? button.getBoundingClientRect()
          : undefined
        if (rect !== undefined && rect.width > 0) {
          // The centred fallback below shifts by half a width; a leftover transform here would
          // move the anchored overlay back off the button.
          node.style.transform = 'none'
          node.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`
          node.style.top = `${Math.max(8, rect.top - 34)}px`
          node.style.bottom = 'auto'
          return
        }
        node.style.left = '50%'
        node.style.top = 'auto'
        node.style.bottom = '104px'
        node.style.transform = 'translateX(-50%)'
      }

      /**
       * Paint one frame of the level.
       *
       * The mapping is a square root rather than a straight line: the room sits near 0.004 and a
       * full voice near 0.06, so a linear bar would spend most of its range on the loudest moment
       * and look dead while somebody talks normally.
       */
      function meterPush(level) {
        const node = meterEnsure()
        const shaped = Math.min(1, Math.sqrt(Math.max(0, level) / 0.06))
        const height = 2 + Math.round(shaped * 18)
        for (let index = 0; index < meterBars.length - 1; index += 1) {
          meterBars[index].style.height = meterBars[index + 1].style.height
        }
        const last = meterBars[meterBars.length - 1]
        if (last !== undefined) last.style.height = `${height}px`
        meterPushes += 1
        // The composer can move while a long sentence is being recorded (a wrapping draft, a
        // resized window), so the overlay follows it about once a second.
        if (meterPushes % 15 === 0) meterPlace()
        node.setAttribute('data-on', 'true')
      }

      function meterShow(on) {
        if (!on) {
          if (meter !== undefined) meter.setAttribute('data-on', 'false')
          return
        }
        meterEnsure()
        meterPlace()
        // Start from silence: the previous sentence's bars must not be read as this one's.
        for (const bar of meterBars) bar.style.height = '2px'
        meter.setAttribute('data-on', 'true')
      }

      // --- waiting for the page to stop talking ------------------------------------------------
      //
      // Read-aloud plays the reply through the speakers while a continuous exchange is already
      // waiting to open the microphone again, and Chromium's echo canceller makes that fatal:
      // measured on this machine, the microphone's own reading drops from 0.0038 to 0.0017 while
      // the page plays a tone through the speakers — the canceller gates the capture together with
      // the echo it is removing. A turn that opens then records near-digital silence, hears nobody
      // and ends with "没有听到说话", which is what every follow-up turn in the log did. The reply
      // has to finish reading before the device opens, not after.
      const speakBusy = () => document.querySelector('[data-phase="playing"], [data-phase="preparing"]') !== null
      // How often the read-aloud is looked at. Everything else on this page polls at 120 ms or
      // slower; this one is in the path between the last syllable and the microphone opening.
      const SPEAK_POLL_MS = 60
      /**
       * How long the page must stay silent before the microphone opens.
       *
       * Short because of what `speakBusy` actually observes: the reader's `phase` only returns to
       * `idle` when its whole queue is empty, so a gap between two sentences never looks idle — the
       * tail is not guarding against those. All it covers is the output buffer, and the last few
       * milliseconds of a sentence. It used to be 700 ms, from when the signal was assumed to
       * flicker between sentences; it does not, and the pause was heard as the system thinking.
       */
      const SPEECH_TAIL_MS = 150

      /**
       * Resolve when nothing on the page is speaking, or after `limitMs`.
       *
       * A page without read-aloud has nothing to wait for and answers at once. `grace` is the wait
       * for a reading that has not started yet: a follow-up turn follows a reply that auto-read may
       * still be fetching, while a wake turn follows whatever was playing and needs no grace at all
       * — waiting there would put four seconds between "我在" and listening. Once playback has been
       * seen, `SPEECH_TAIL_MS` is the whole of what is left: the output buffer, not a guess about
       * whether the sentence was over.
       */
      async function waitForQuiet(limitMs, grace) {
        // A page that cannot even be asked (a test harness, a page loading this file outside the
        // composer) has no read-aloud to wait for.
        let hasReadAloud = false
        try {
          hasReadAloud = typeof document.querySelector === 'function' && document.querySelector('.dsh-speak-action') !== null
        } catch {
          hasReadAloud = false
        }
        if (!hasReadAloud) return true
        const begin = Date.now()
        let idleAt = 0
        let spoke = false
        while (Date.now() - begin < limitMs) {
          if (speakBusy()) {
            spoke = true
            idleAt = 0
          } else {
            if (idleAt === 0) idleAt = Date.now()
            if (Date.now() - idleAt >= (spoke ? SPEECH_TAIL_MS : grace)) return true
          }
          await sleep(SPEAK_POLL_MS)
        }
        return false
      }

      /** While the device is open the microphone button goes red, whichever door opened it. */
      let listening = false
      /**
       * Set by a second press on the microphone: the recorder stops on its next tick instead of
       * waiting out the pause, the ceiling, or the silence that ends a turn nobody spoke into.
       *
       * It is a flag rather than a callback because the recorder's loop is the only place that can
       * close the device cleanly — stopping has to happen where the samples stop, or the last
       * frames arrive after the WAV was built.
       */
      let stopRequested = false
      function markListening(on) {
        listening = on
        try {
          meterShow(on)
        } catch {
          /* an overlay is a nicety; the recorder is not */
        }
        try {
          window.dispatchEvent(new CustomEvent('dsh-orb-listening', { detail: on }))
        } catch {
          /* a page without events simply keeps the button as it is */
        }
      }
      // Read when the button mounts, so a wake that arrives before the row renders still shows.
      window.__dshOrbListening = () => listening

      /**
       * One sentence, start to finish, on the ball's own line.
       *
       * This opens the device itself, measures the level of the samples it actually receives and
       * decides from them when the sentence is over — the ball's procedure, not the voice plugin's
       * animation. The finished WAV goes to the host, whose transcriber is the very service the
       * ball talks to, and the words land in the composer (or are sent, when `send` says so).
       *
       * Every ending is a cue, because nothing on screen says what happened. A closing phrase is
       * the user getting off: it is dropped rather than typed, the same way the ball drops it.
       */
      async function voiceTurn(limits, send, graceMs = 0) {
        try {
          // Before the device opens, for the reason `waitForQuiet` gives: a microphone opened into a
          // reply that is still being read records the reply, not the user.
          if (!(await waitForQuiet(180_000, graceMs))) {
            tell('the page never stopped reading; the microphone opens anyway')
          }
          // A press on stop while the page was still reading: nothing was heard, so this is
          // "ended by hand", not a failure.
          if (stopRequested) {
            tone(CUE_SHUT, 0.48)
            return 'empty'
          }
          markListening(true)
          // Still before the device opens, so the cue is not part of the recording. Full scale:
          // over room noise anything less was easy to miss, and the one thing this cue has to
          // answer is "did it start listening".
          tone(CUE_OPEN, 1)
          const recorded = await recordUtterance(limits)
          // The device is closed now: the button may go quiet while the words are on their way.
          markListening(false)
          if (!recorded.ok) {
            // Ending a turn by hand and hearing nothing are two different events, and only one of
            // them is bad news.
            if (recorded.stopped) tone(CUE_SHUT, 0.48)
            else tone(CUE_EMPTY, 0.64)
            tell(`composer recorder gave up: ${recorded.reason}`)
            return 'empty'
          }
          // "Heard" is the cue for words that stay in the box: it says "this is yours now". When the
          // turn is going to send them instead, the sending cue says the same thing and more, and
          // the two arrive close enough together that the first used to be cut off by the second.
          // One event, one sound.
          if (!send) tone(CUE_HEARD, 0.8)
          let body = null
          let status = 0
          try {
            const signal = giveUpAfter(30_000)
            const response = await fetch('/.dsh-orb/transcribe', {
              method: 'POST',
              headers: { 'content-type': 'audio/wav' },
              body: recorded.blob,
              ...(signal === undefined ? {} : { signal }),
            })
            status = response.status
            body = await response.json()
          } catch (error) {
            tell(`composer transcript request failed: ${error && error.message ? error.message : String(error)}`)
          }
          const text = body !== null && typeof body.text === 'string' ? body.text.trim() : ''
          if (text === '') {
            const reason = body !== null && typeof body.error === 'string' ? body.error : `转写没有返回文字（${status}）`
            tone(CUE_EMPTY, 0.64)
            tell(`composer transcript empty: ${reason}`)
            return 'empty'
          }
          tell(`composer transcript: "${text}" (${text.length} chars in ${recorded.seconds.toFixed(1)}s)`)
          if (isClosingPhrase(text)) {
            tone(CUE_SHUT, 0.48)
            tell('composer recorder: the user closed the exchange')
            return 'closing'
          }
          const before = composerText()
          const blank = before.trim() === ''
          const insert = blank ? text : ` ${text}`
          const whole = blank ? text : `${before.trimEnd()} ${text}`
          if (!(await setDraft(whole, insert))) {
            tone(CUE_EMPTY, 0.64)
            tell(`composer recorder: the composer would not take the words (editor=${composerEditor() !== undefined})`)
            return 'failed'
          }
          if (!send) return 'draft'
          if (!(await submit(text))) {
            tone(CUE_EMPTY, 0.64)
            tell('composer recorder: the words are in the box but did not leave it')
            return 'failed'
          }
          tell('sent the transcript')
          tone(CUE_SENT, 0.45)
          return 'sent'
        } catch (error) {
          tell(`composer recorder failed: ${error && error.message ? error.message : String(error)}`)
          tone(CUE_EMPTY, 0.64)
          return 'failed'
        } finally {
          // The flag belongs to one turn: consume it here so a press that landed after the device
          // closed — or a turn that gave up before the recorder ever ran — cannot end the next one.
          stopRequested = false
          markListening(false)
        }
      }

      /** One press of the composer's microphone button. */
      async function ballTurn() {
        if (busy) return 'busy'
        busy = true
        try {
          const limits = await dictationSettings()
          return await voiceTurn(limits, limits.autoSend)
        } finally {
          busy = false
        }
      }
      // The button mounts from the slot, which is registered in the same tick this function runs;
      // publishing here keeps the component free of any knowledge about the bridge.
      window.__dshOrbBallTurn = ballTurn
      // A turn whose device is already closed — transcribing, writing, sending — has nothing left
      // to end and no room for a second one. The button asks before it paints itself red.
      window.__dshOrbTurnBusy = () => busy
      /**
       * End the turn that is recording right now — the second press on the microphone.
       *
       * Answers whether there was a turn to end, so a press on a quiet button is a press that
       * starts one. The recorder itself closes the device on its next tick and hands over whatever
       * it heard: ending a turn is not throwing it away, and a turn with nothing in it is dropped
       * with the closing cue. The button goes quiet immediately, before the device is actually
       * closed, because a button that stays red after being pressed reads as a button that is
       * broken.
       *
       * A turn that has not reached the recorder yet — it is still waiting out the previous reply —
       * counts too: the flag makes it give up instead of opening the device for a sentence the user
       * has already called off.
       */
      window.__dshOrbStopListening = () => {
        if (!listening && !busy) return false
        stopRequested = true
        markListening(false)
        return true
      }

      /**
       * One turn of a wake-word exchange.
       *
       * The hand-off carries the ball's own numbers — `silenceMs`, `noSpeechMs`, `maxSeconds` — and
       * whether the transcript should be sent, so this is the same recorder the button uses, run on
       * the values the ball was configured with. There is no second implementation of the ear here
       * and no pressing of the voice plugin: the page records with its own microphone.
       *
       * Returns what became of the turn: `sent`, `draft` (no auto-send), `closing` (the user
       * said they were done), `empty` (no words came back) or `failed`. Only `sent` may continue
       * the exchange — every other ending is the user getting off the ride.
       */
      async function oneTurn(command, afterReply = false) {
        const limits = {
          silenceMs: numberOr(command.silenceMs, DICTATION_FALLBACK.silenceMs),
          maxSeconds: numberOr(command.maxSeconds, DICTATION_FALLBACK.maxSeconds),
          noSpeechMs: numberOr(command.noSpeechMs, DICTATION_FALLBACK.noSpeechMs),
        }
        tell(`wake turn: pause ${limits.silenceMs}ms, no speech ${limits.noSpeechMs}ms, ceiling ${limits.maxSeconds}s, send=${command.send === true}${afterReply ? ' (follow-up)' : ''}`)
        // A follow-up follows a reply that auto-read may still be fetching, so it gives that job a
        // moment to be queued; a wake turn follows whatever was already playing and waits only for
        // it to end, because four seconds between "我在" and listening is a broken wake word.
        let grace = 0
        if (afterReply) {
          try {
            const autoRead = document.querySelector('.dsh-speak-auto[data-on="true"]') !== null
            grace = autoRead ? 4000 : 0
          } catch {
            grace = 0
          }
        }
        return await voiceTurn(limits, command.send === true, grace)
      }

      async function run(command) {
        if (busy) return
        busy = true
        try {
          tell(`hand-off received ${JSON.stringify(command)}; page visible=${document.visibilityState}`)
          let outcome = await oneTurn(command)
          // Continuous conversation, as the ball runs it: a sent voice turn hands the microphone
          // back when the reply finishes, so the next sentence needs no wake word. Every other
          // ending — silence, a closing phrase, a failed press — is the user getting off, and the
          // loop ends there.
          while (outcome === 'sent' && command.continuous === true) {
            if (!(await waitForReply())) {
              tell('the reply never ended; the exchange stops here')
              return
            }
            // The host sends its own gap; this is the fallback for a hand-off without one. It only
            // has to let the stop button's removal reach the DOM — the turn opens with a cue, so
            // nothing here is waiting for the user to notice.
            const gap = typeof command.followUpMs === 'number' ? command.followUpMs : 150
            await sleep(gap)
            if (replyStop() !== undefined) {
              tell('still answering after the gap; the exchange stops here')
              return
            }
            outcome = await oneTurn(command, true)
          }
        } catch (error) {
          // `void run(...)` swallows a rejection, and a swallowed rejection is a wake that does
          // nothing with no line to say why. This is the one place that must never be silent.
          tell(`the hand-off failed: ${error && error.message ? error.message : String(error)}`)
        } finally {
          busy = false
        }
      }
      // Baseline, once the composer has had time to mount. This one line answers the first
      // question a missing microphone raises — does the page have a record button at all — and it
      // is written even when no wake ever arrives.
      // One line at startup about the ear this page is going to use, so a wake that records
      // nothing can be told apart from a page that never had a microphone at all.
      setTimeout(() => {
        const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
        tell(`composer recorder ready: ${media !== undefined && typeof media.getUserMedia === 'function'}`)
      }, 8000)
      while (true) {
        try {
          const response = await fetch('/.dsh-orb/main-voice', { cache: 'no-store', credentials: 'same-origin' })
          if (response.ok) {
            const command = await response.json()
            if (command !== null && command.start === true) {
              // A second hand-off during a turn is dropped, and dropping it silently reads from
              // outside as "the switch does nothing".
              if (busy) tell('hand-off arrived while a turn was recording; dropped')
              else void run(command)
            }
            // `{ start: false }` is the host's "nothing waiting", which is the answer to almost
            // every poll. Logging it would bury the four lines that matter. 
          }
        } catch (_error) {
          // The host may not be mounted on this port (for example a plain page). Keep polling.
        }
        // The hand-off is only useful while the user is still holding the word they just said, so
        // this poll is the fastest one on the page: a wake should open the microphone on the same
        // breath, not a fifth of a second later. The request is a bare GET on loopback, and the
        // clock it costs is the whole remaining delay between the helper's signal and the device.
        await sleep(120)
      }
    }

    // ── the wake switch in the composer ─────────────────────────────
    //
    // The ball hears the wake word, but it is not where the user types: that is the main window,
    // and its composer already owns a microphone. This puts the switch for the *listening* half
    // right there, next to the microphone it arms, and the hand-off (above) turns a wake into a
    // press of that microphone.
    //
    // It is a slot occupant, not a hand-inserted node. The first version mounted a plain button
    // into the composer row with `insertBefore`; React owns that row and pruned the stranger on
    // its next commit, so the switch flashed and then vanished. `conversation.input.right` is a
    // list slot rendered inside the row's standard controls, immediately before the model
    // selector — the composer's own bottom line, on the near side of the microphone.
    const WAKE_SLASH = 'M3.5 3.5l17 17'

    function WakeSwitch() {
      // Re-read on every render so a locale switch lands without a remount.
      const text = copy()
      const [on, setOn] = React.useState(true)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let live = true
        void request('/.dsh-orb/wake')
          .then((body) => {
            if (!live) return
            if (body !== null && typeof body.enabled === 'boolean') setOn(body.enabled)
          })
          .catch(() => {
            // A page without the host (a plain browser tab) keeps the default it was shown.
          })
        return () => { live = false }
      }, [])

      async function flip() {
        if (busy) return
        const next = !on
        setBusy(true)
        setOn(next)
        try {
          const body = await request('/.dsh-orb/wake', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: next }),
          })
          if (body !== null && typeof body.enabled === 'boolean') setOn(body.enabled)
        } catch (error) {
          // The switch is a preference: if the host refused it, show what is actually stored
          // rather than a state nothing is honouring.
          setOn(!next)
          console.warn('dsh-orb: the wake-word switch was not saved', error)
        } finally {
          setBusy(false)
        }
      }

      return h('button', {
        type: 'button',
        className: 'dsh-orb-wake-toggle',
        // The icon is the whole control, so the accessible name stays the noun and the state is
        // carried by `aria-pressed` and the strike-through. The hover title says what a click does.
        'aria-label': text.wakeLabel,
        'aria-pressed': on ? 'true' : 'false',
        disabled: busy,
        title: on ? text.wakeOn : text.wakeOff,
        onMouseDown: (event) => { event.preventDefault() },
        onClick: () => { void flip() },
      }, h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      // Five bars of a standing wave, not a microphone: this switch is about the ball listening
      // for a word, and the composer already has a microphone sitting a few pixels away. Same
      // family of stroke and weight, a shape that cannot be mistaken for it.
      h('path', { key: 'b1', className: 'dsh-orb-wake-bar', d: 'M3.5 10.5v3' }),
      h('path', { key: 'b2', className: 'dsh-orb-wake-bar', d: 'M7.75 7.5v9' }),
      h('path', { key: 'b3', className: 'dsh-orb-wake-bar', d: 'M12 4.5v15' }),
      h('path', { key: 'b4', className: 'dsh-orb-wake-bar', d: 'M16.25 7.5v9' }),
      h('path', { key: 'b5', className: 'dsh-orb-wake-bar', d: 'M20.5 10.5v3' }),
      on ? null : h('path', { key: 'slash', className: 'dsh-orb-wake-slash', d: WAKE_SLASH })))
    }

    /**
     * The dictation button, sitting left of the wake switch.
     *
     * A microphone is the right shape here after all: this one records a sentence, which is what
     * the wake switch does not do — that one only decides whether the ball is listening for a word.
     * It borrows the switch's box so the pair reads as one control cluster, and turns red while the
     * device is open.
     */
    function BallMic() {
      const text = copy()
      const [recording, setRecording] = React.useState(false)
      // A wake-word turn opens the device without this button being pressed, and the one state a
      // person has to be able to see is "it is listening right now". The bridge announces that; the
      // press below also sets it locally so the button does not wait for its own event.
      React.useEffect(() => {
        const host = typeof window === 'undefined' ? undefined : window
        if (host === undefined) return undefined
        const read = () => {
          const probe = host.__dshOrbListening
          if (typeof probe === 'function') setRecording(probe() === true)
        }
        read()
        if (typeof host.addEventListener !== 'function') return undefined
        const onState = (event) => setRecording(event !== null && event !== undefined && event.detail === true)
        host.addEventListener('dsh-orb-listening', onState)
        // A backstop for a page that never dispatches the event: one read twice a second is
        // cheaper than a component that can be left red after a failed turn.
        const timer = typeof setInterval === 'function' ? setInterval(read, 500) : undefined
        return () => {
          host.removeEventListener('dsh-orb-listening', onState)
          if (timer !== undefined) clearInterval(timer)
        }
      }, [])
      function press() {
        const host = typeof window === 'undefined' ? undefined : window
        // Read live rather than from `recording`: a second press can arrive before React has
        // re-rendered, and a press that is meant to stop a turn must not be read as one that
        // starts another.
        const live = host !== undefined && typeof host.__dshOrbListening === 'function'
          ? host.__dshOrbListening() === true
          : false
        // A turn can be running without the device being open yet (it is still waiting out the
        // reply being read) or any more (the words are already on their way). Both are presses on
        // a live turn, and both are answered by the bridge rather than by a second recorder.
        const running = host !== undefined && typeof host.__dshOrbTurnBusy === 'function'
          && host.__dshOrbTurnBusy() === true
        if (recording || live || running) {
          const stop = host === undefined ? undefined : host.__dshOrbStopListening
          // It answers whether a turn was actually open. A button that is still red a moment after
          // a turn ended is a button whose press should start the next one, not a press that is
          // swallowed.
          if (typeof stop === 'function' && stop() === true) return
        }
        const turn = host === undefined ? undefined : host.__dshOrbBallTurn
        if (typeof turn !== 'function') return
        setRecording(true)
        void Promise.resolve(turn()).finally(() => {
          // What the bridge says, not what this press assumed: a turn can end before the device
          // opens, and the button must not stay red on its own word.
          const probe = host === undefined ? undefined : host.__dshOrbListening
          setRecording(typeof probe === 'function' ? probe() === true : false)
        })
      }
      return h('button', {
        type: 'button',
        className: 'dsh-orb-wake-toggle dsh-orb-mic-toggle',
        // While it is listening the button is a stop button, and says so: the same key press now
        // does the opposite thing.
        'aria-label': recording ? text.micStop : text.micLabel,
        'data-recording': recording ? 'true' : 'false',
        title: recording ? text.micRecording : text.micIdle,
        onMouseDown: (event) => { event.preventDefault() },
        onClick: () => { void press() },
      }, h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      // A microphone: capsule, yoke, stem, base — the four strokes everyone draws, at the wake
      // switch's own weight so the row stays one family.
      h('path', { key: 'body', className: 'dsh-orb-mic-body', d: 'M12 3.2a3.1 3.1 0 0 1 3.1 3.1v4.9a3.1 3.1 0 0 1-6.2 0V6.3A3.1 3.1 0 0 1 12 3.2z' }),
      h('path', { key: 'yoke', d: 'M5.6 11.4a6.4 6.4 0 0 0 12.8 0' }),
      h('path', { key: 'stem', d: 'M12 17.8v3.2' }),
      h('path', { key: 'base', d: 'M8.6 21h6.8' })))
    }

    const inject = ['slots']

    function apply(ctx) {
      if (!document.getElementById('dsh-orb-settings-style')) {
        const node = document.createElement('style')
        node.id = 'dsh-orb-settings-style'
        node.textContent = style
        document.head.append(node)
      }
      // TODO(main-window-voice): the wake-word hand-off is served by this page, so the bridge
      // has to run whether or not the settings section is ever opened.
      void mainVoiceBridge()
      // One beacon per page load. If the switch never shows up, this records what the page looked
      // like when this file ran, which separates "the plugin never loaded" from "the slot never
      // rendered it" without attaching a debugger to a running window.
      void request('/.dsh-orb/client-report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          at: new Date().toISOString(),
          phase: 'apply',
          ready: document.readyState,
          path: typeof location === 'undefined' ? '' : location.pathname,
          mics: countMics(),
        }),
      }).catch(() => {
        // Diagnosis only: a page without the host simply has no one to tell.
      })
      // The switch for the ball's ears lives in this window's composer, so it registers on the
      // same terms as the bridge: at page load, not when a settings page is opened. `order` keeps
      // it left of the model selector, which is where the microphone's half of the row begins.
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'orb-mic',
        // Left of the wake switch (order 5): the pair reads "speak to it, then let it listen".
        order: 4,
        inject: () => ({}),
      }, BallMic))
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'orb-wake',
        order: 5,
        inject: () => ({}),
      }, WakeSwitch))
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'orb',
        order: 25,
        label: () => copy().nav,
        inject: () => ({}),
      }, OrbSettingsSection))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
