import { createRequire, Module } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { contextMenuTemplate } from '../src/menu.ts'
import { modelMenuItems } from '../src/model-menu.ts'

const here = dirname(fileURLToPath(import.meta.url))

interface PreloadApi {
  send?: (text: string) => void
  setPermission?: (preset: string) => void
  requestHistory?: () => void
  openSession?: (id: string) => void
  newSession?: () => void
  stop?: () => void
  answerQuestion?: (id: string, answers: unknown) => void
  tccStatus?: () => Promise<unknown>
  openTcc?: (right: string) => Promise<unknown>
  wakeConfig?: () => Promise<unknown>
  wakeEnable?: () => Promise<unknown>
  wakeDisable?: () => Promise<unknown>
  wakeReport?: (status: unknown) => Promise<unknown>
  setWakeEnabled?: (enabled: boolean) => Promise<unknown>
  onWake?: (callback: (payload: unknown) => void) => void
  selection?: {
    search?: () => void
    setLanguage?: (language: string) => void
    setContentSize?: (size: { width: number; height: number }) => Promise<unknown>
  }
}

function loadPreload(file: string): { api: PreloadApi; sent: [string, unknown][]; invoked: [string, unknown][] } {
  const sent: [string, unknown][] = []
  const invoked: [string, unknown][] = []
  const exposed: Record<string, PreloadApi> = {}
  const electron = {
    contextBridge: {
      exposeInMainWorld(name: string, value: PreloadApi) { exposed[name] = value },
    },
    ipcRenderer: {
      send(channel: string, payload?: unknown) { sent.push([channel, payload]) },
      invoke(channel: string, payload?: unknown) {
        invoked.push([channel, payload])
        return Promise.resolve({ menuAbove: false })
      },
      on(channel: string) { sent.push([`listen:${channel}`, undefined]) },
    },
  }
  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: unknown, isMain: boolean, options: unknown) => string
    _cache: Record<string, { id: string; filename: string; loaded: boolean; exports: unknown }>
  }
  const original = loader._resolveFilename
  loader._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'electron') return 'electron-mock-dsh-orb'
    return original.call(this, request, parent, isMain, options)
  }
  loader._cache['electron-mock-dsh-orb'] = {
    id: 'electron-mock-dsh-orb',
    filename: 'electron-mock-dsh-orb',
    loaded: true,
    exports: electron,
  }
  const filename = join(here, file)
  delete loader._cache[filename]
  try {
    createRequire(import.meta.url)(filename)
  } finally {
    loader._resolveFilename = original
    delete loader._cache['electron-mock-dsh-orb']
    delete loader._cache[filename]
  }
  return { api: exposed.dshOrb ?? {}, sent, invoked }
}

const catalog = {
  groups: [{
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'plain', name: 'Plain' },
      {
        id: 'deepseek-flash',
        name: 'Flash',
        reasoning: { efforts: [{ id: 'max', name: 'Max' }, { id: 'high', name: 'High' }], defaultEffort: 'max' },
      },
    ],
  }],
}

describe('ball menu', () => {
  it('checks the current model and uses a radio submenu for thinking models', () => {
    const chosen: unknown[] = []
    const items = modelMenuItems(catalog, {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
    }, (selection) => { chosen.push(selection) }, { empty: '没有可用的模型。', defaultEffort: '默认' })
    assert.equal(items[0]?.label, 'DeepSeek')
    assert.equal(items[0]?.enabled, false)
    const plain = items.find((item) => item.label === 'Plain')
    assert.equal(plain?.type, 'checkbox')
    assert.equal(plain?.checked, false)
    plain?.click?.({ checked: true })
    assert.deepEqual(chosen[0], { provider: 'deepseek-official', model: 'plain' })
    const flash = items.find((item) => item.label === '✓ Flash')
    assert.equal(flash?.submenu?.[0]?.type, 'radio')
    assert.equal(flash?.submenu?.find((item) => item.label === 'High')?.checked, true)
    assert.equal(flash?.submenu?.find((item) => item.label === 'Max')?.checked, false)
    flash?.submenu?.find((item) => item.label === 'Max')?.click?.({ checked: true })
    assert.deepEqual(chosen[1], { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' })
    assert.deepEqual(modelMenuItems({ groups: [] }, { provider: 'x', model: 'y' }, () => {}, {
      empty: '没有可用的模型。',
      defaultEffort: '默认',
    }), [{ label: '没有可用的模型。', enabled: false }])
  })

  it('lists open, both models, coordinates, terse replies, the chime, wake, voice input, and disable', () => {
    const actions: string[] = []
    const template = contextMenuTemplate({
      catalog,
      overlay: { provider: 'deepseek-official', model: 'plain' },
      background: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
      millifractionEnabled: false,
      replyEnabled: false,
      replyMaxChars: 80,
      // The chime needs a voice: with read-aloud on, the row is live and names its silent hours.
      chimeEnabled: true,
      chimeQuietFrom: 0,
      chimeQuietTo: 7,
      speechEnabled: true,
      // The voice row names the timbre that is live, and lists the ones on offer.
      speechVoice: 'zh-CN-XiaoxiaoNeural',
      speechVoices: [
        { voice: 'stella', zh: 'stella（默认女声）', en: 'stella (default female)' },
        { voice: 'zh-CN-XiaoxiaoNeural', zh: '晓晓（温柔女声）', en: 'Xiaoxiao (warm female)' },
      ],
      wakeEnabled: false,
      wakeAvailable: true,
      wakeKeyword: 'hey_jarvis',
      wakeKeywords: [
        { keyword: 'hey_jarvis', spoken: 'Hey Jarvis', available: true },
        { keyword: 'dafeiyu', spoken: '大肥鱼大肥鱼', available: false },
      ],
      wakeWord: 'Hey Jarvis',
      dictationReady: true,
      openMain: true,
    }, true, {
      openMain: () => { actions.push('open') },
      setOverlay: () => { actions.push('overlay') },
      setBackground: () => { actions.push('background') },
      setMillifraction: (enabled) => { actions.push(`fraction:${enabled}`) },
      setReply: (enabled) => { actions.push(`reply:${enabled}`) },
      setChime: (enabled) => { actions.push(`chime:${enabled}`) },
      setSpeechVoice: (voice) => { actions.push(`voice:${voice}`) },
      setWake: (enabled) => { actions.push(`wake:${enabled}`) },
      setWakeWord: (keyword) => { actions.push(`word:${keyword}`) },
      dictate: () => { actions.push('dictate') },
      disable: () => { actions.push('disable') },
    })
    assert.deepEqual(template.map((item) => item.label ?? item.type), [
      '打开主窗口',
      '悬浮球 Agent 模型',
      '后台 Agent 模型',
      '千分比坐标',
      '极简回复（≤80 字）',
      '整点报时（0–7 点静音）',
      '音色 · 晓晓（温柔女声）',
      '语音唤醒（Hey Jarvis）',
      '语音输入（现在说一句）',
      'separator',
      '停用悬浮球',
    ])
    assert.equal(template[0]?.enabled, true)
    template[0]?.click?.({ checked: false })
    template[3]?.click?.({ checked: true })
    // The reply row is a checkbox whose label states the cap it enforces.
    assert.equal(template[4]?.type, 'checkbox')
    assert.equal(template[4]?.checked, false)
    template[4]?.click?.({ checked: true })
    // The chime row carries its quiet window in the label, because that number lives nowhere else.
    assert.equal(template[5]?.type, 'checkbox')
    assert.equal(template[5]?.checked, true)
    template[5]?.click?.({ checked: false })
    // The wake row is now a submenu: the switch on top, the phrase choices below it. A phrase whose
    // model is not on disk is shown but disabled, so a half-trained word cannot be picked.
    assert.equal(template[6]?.submenu?.length, 2)
    assert.equal(template[6]?.submenu?.find((item) => item.label === '晓晓（温柔女声）')?.checked, true)
    assert.equal(template[6]?.submenu?.find((item) => item.label === 'stella（默认女声）')?.checked, false)
    template[6]?.submenu?.find((item) => item.label === 'stella（默认女声）')?.click?.({ checked: true })
    assert.equal(template[7]?.submenu?.[0]?.type, 'checkbox')
    assert.equal(template[7]?.submenu?.[0]?.checked, false)
    assert.equal(template[7]?.submenu?.[1]?.type, 'separator')
    const phrases = template[7]?.submenu ?? []
    assert.equal(phrases.find((item) => item.label === 'Hey Jarvis')?.checked, true)
    assert.equal(phrases.find((item) => item.label === '大肥鱼大肥鱼（模型未训练）')?.enabled, false)
    template[7]?.submenu?.[0]?.click?.({ checked: true })
    // Voice input needs the wake engine running, so the row follows that state.
    assert.equal(template[8]?.enabled, true)
    template[8]?.click?.({ checked: false })
    template[10]?.click?.({ checked: false })
    const background = template[2]?.submenu?.find((item) => item.label === '✓ Flash')
    assert.equal(background?.submenu?.find((item) => item.label === 'Max')?.checked, true)
    background?.submenu?.[0]?.click?.({ checked: true })
    assert.deepEqual(actions, ['open', 'fraction:true', 'reply:true', 'chime:false', 'voice:stella', 'wake:true', 'dictate', 'disable', 'background'])
    // With the engine off the row explains itself instead of recording nothing.
    const noEngine = contextMenuTemplate({
      catalog,
      overlay: { provider: 'deepseek-official', model: 'plain' },
      background: { provider: 'deepseek-official', model: 'plain' },
      millifractionEnabled: false,
      replyEnabled: true,
      replyMaxChars: 80,
      chimeEnabled: false,
      chimeQuietFrom: 0,
      chimeQuietTo: 7,
      speechEnabled: true,
      // The voice row names the timbre that is live, and lists the ones on offer.
      speechVoice: 'zh-CN-XiaoxiaoNeural',
      speechVoices: [
        { voice: 'stella', zh: 'stella（默认女声）', en: 'stella (default female)' },
        { voice: 'zh-CN-XiaoxiaoNeural', zh: '晓晓（温柔女声）', en: 'Xiaoxiao (warm female)' },
      ],
      wakeEnabled: false,
      wakeAvailable: true,
      wakeKeyword: 'hey_jarvis',
      wakeKeywords: [
        { keyword: 'hey_jarvis', spoken: 'Hey Jarvis', available: true },
        { keyword: 'dafeiyu', spoken: '大肥鱼大肥鱼', available: false },
      ],
      wakeWord: 'Hey Jarvis',
      dictationReady: false,
      openMain: true,
    }, true, {
      openMain: () => {},
      setOverlay: () => {},
      setBackground: () => {},
      setMillifraction: () => {},
      setReply: () => {},
      setChime: () => {},
      setSpeechVoice: () => {},
      setWake: () => {},
      dictate: () => { actions.push('should-not-run') },
      disable: () => {},
    })
    assert.equal(noEngine[8]?.label, '语音输入（需先开启语音唤醒）')
    assert.equal(noEngine[8]?.enabled, false)
    assert.equal(noEngine[4]?.checked, true)
    assert.equal(noEngine[5]?.checked, false)
    const english = contextMenuTemplate({
      catalog: { groups: [] },
      overlay: { provider: 'deepseek-official', model: 'plain' },
      background: { provider: 'deepseek-official', model: 'plain' },
      millifractionEnabled: false,
      replyEnabled: true,
      replyMaxChars: 80,
      chimeEnabled: true,
      chimeQuietFrom: 22,
      chimeQuietTo: 6,
      speechEnabled: true,
      // The voice row names the timbre that is live, and lists the ones on offer.
      speechVoice: 'zh-CN-XiaoxiaoNeural',
      speechVoices: [
        { voice: 'stella', zh: 'stella（默认女声）', en: 'stella (default female)' },
        { voice: 'zh-CN-XiaoxiaoNeural', zh: '晓晓（温柔女声）', en: 'Xiaoxiao (warm female)' },
      ],
      wakeEnabled: false,
      wakeAvailable: true,
      wakeKeyword: 'hey_jarvis',
      wakeKeywords: [
        { keyword: 'hey_jarvis', spoken: 'Hey Jarvis', available: true },
        { keyword: 'dafeiyu', spoken: '大肥鱼大肥鱼', available: false },
      ],
      wakeWord: 'Hey Jarvis',
      openMain: false,
    }, false, {
      openMain() {},
      setOverlay() {},
      setBackground() {},
      setMillifraction() {},
      setReply() {},
      setChime() {},
      setSpeechVoice() {},
      setWake() {},
      setWakeWord() {},
      disable() {},
    })
    assert.equal(english[0]?.label, 'Open Main Window')
    assert.equal(english[0]?.enabled, false)
    assert.equal(english[4]?.label, 'Minimal replies (≤80 chars)')
    // The window wraps midnight here: the label has to say so, or the user reads 22–6 as a range
    // that is silent in the afternoon.
    assert.equal(english[5]?.label, 'Hourly chime (quiet 22–6)')
    assert.equal(english[6]?.label, 'Voice · Xiaoxiao (warm female)')
    assert.equal(english[7]?.label, 'Voice wake word (Hey Jarvis)')
    assert.equal(english.at(-1)?.label, 'Disable floating ball')
  })

  it('names the configured wake word, not the one that ships', () => {
    // The row used to read "语音唤醒（Hey Jarvis）" whatever was configured, so a user with a
    // self-trained word was shown the wrong one at the exact place they turn it on and off.
    const template = contextMenuTemplate({
      catalog: { groups: [] },
      overlay: { provider: 'deepseek-official', model: 'plain' },
      background: { provider: 'deepseek-official', model: 'plain' },
      millifractionEnabled: false,
      replyEnabled: true,
      // The row names whatever cap the profile actually holds, not the shipped eighty.
      replyMaxChars: 120,
      wakeEnabled: true,
      wakeAvailable: true,
      wakeKeyword: 'dafeiyu',
      wakeKeywords: [
        { keyword: 'hey_jarvis', spoken: 'Hey Jarvis', available: true },
        { keyword: 'dafeiyu', spoken: '大肥鱼大肥鱼', available: true },
      ],
      wakeWord: '大肥鱼大肥鱼',
      dictationReady: true,
      openMain: true,
    }, true, {
      openMain() {},
      setOverlay() {},
      setBackground() {},
      setMillifraction() {},
      setReply() {},
      setWake() {},
      setWakeWord() {},
      dictate() {},
      disable() {},
    })
    const row = template.find((item) => item.label?.startsWith('语音唤醒'))
    assert.equal(row?.label, '语音唤醒（大肥鱼大肥鱼）')
    // The radio group states which phrase is live, so a user can see it without saying it.
    assert.equal(row?.submenu?.find((item) => item.label === '大肥鱼大肥鱼')?.checked, true)
    assert.equal(row?.submenu?.find((item) => item.label === 'Hey Jarvis')?.checked, false)
    const picked: string[] = []
    const picking = contextMenuTemplate({
      catalog: { groups: [] },
      overlay: { provider: 'deepseek-official', model: 'plain' },
      background: { provider: 'deepseek-official', model: 'plain' },
      millifractionEnabled: false,
      replyEnabled: true,
      replyMaxChars: 120,
      wakeEnabled: true,
      wakeAvailable: true,
      wakeKeyword: 'dafeiyu',
      wakeKeywords: [
        { keyword: 'hey_jarvis', spoken: 'Hey Jarvis', available: true },
        { keyword: 'xiaodi', spoken: '小弟小弟', available: true },
      ],
      wakeWord: '大肥鱼大肥鱼',
      openMain: true,
    }, true, {
      openMain() {},
      setOverlay() {},
      setBackground() {},
      setMillifraction() {},
      setReply() {},
      setWake() {},
      setWakeWord: (keyword) => { picked.push(keyword) },
      disable() {},
    })
    const choice = picking.find((item) => item.label?.startsWith('语音唤醒'))
    choice?.submenu?.find((item) => item.label === '小弟小弟')?.click?.({ checked: true })
    assert.deepEqual(picked, ['xiaodi'])
    assert.equal(template.find((item) => item.label?.startsWith('极简回复'))?.label, '极简回复（≤120 字）')
  })

  it('disables the wake row when no model directory was found', () => {
    const template = contextMenuTemplate({
      catalog: { groups: [] },
      overlay: { provider: 'deepseek-official', model: 'plain' },
      background: { provider: 'deepseek-official', model: 'plain' },
      millifractionEnabled: false,
      replyEnabled: true,
      replyMaxChars: 80,
      wakeEnabled: false,
      wakeAvailable: false,
      wakeKeyword: 'hey_jarvis',
      wakeKeywords: [
        { keyword: 'hey_jarvis', spoken: 'Hey Jarvis', available: true },
        { keyword: 'dafeiyu', spoken: '大肥鱼大肥鱼', available: false },
      ],
      wakeWord: 'Hey Jarvis',
      openMain: false,
    }, true, {
      openMain() {},
      setOverlay() {},
      setBackground() {},
      setMillifraction() {},
      setReply() {},
      setWake() {},
      setWakeWord() {},
      disable() {},
    })
    const row = template.find((item) => item.label?.startsWith('语音唤醒'))
    assert.equal(row?.label, '语音唤醒（未找到本地模型）')
    assert.equal(row?.enabled, false)
    // Nothing under the row can be chosen either: the switch and every phrase are disabled together.
    assert.equal(row?.submenu?.[0]?.enabled, false)
    assert.equal(row?.submenu?.some((item) => item.type === 'radio' && item.enabled === true), false)
  })

  it('keeps the chime row honest about its voice and its silent hours', () => {
    // Two states the label has to carry, because both are otherwise invisible: without a read-aloud
    // service there is nothing to speak the time, and with `quietFrom === quietTo` there is no silent
    // hour at all — a label that printed "0–0 点静音" would read as silence around midnight.
    const build = (chime: { enabled: boolean; quietFrom: number; quietTo: number }, speech: boolean) =>
      contextMenuTemplate({
        catalog: { groups: [] },
        overlay: { provider: 'deepseek-official', model: 'plain' },
        background: { provider: 'deepseek-official', model: 'plain' },
        millifractionEnabled: false,
        replyEnabled: true,
        replyMaxChars: 80,
        chimeEnabled: chime.enabled,
        chimeQuietFrom: chime.quietFrom,
        chimeQuietTo: chime.quietTo,
        speechEnabled: speech,
        wakeEnabled: false,
        wakeAvailable: false,
        wakeKeyword: 'hey_jarvis',
      wakeKeywords: [
        { keyword: 'hey_jarvis', spoken: 'Hey Jarvis', available: true },
        { keyword: 'dafeiyu', spoken: '大肥鱼大肥鱼', available: false },
      ],
      wakeWord: 'Hey Jarvis',
        openMain: true,
      }, true, {
        openMain() {},
        setOverlay() {},
        setBackground() {},
        setMillifraction() {},
        setReply() {},
        setChime() {},
        setSpeechVoice() {},
        setWake() {},
      setWakeWord() {},
        disable() {},
      }).find((item) => item.label?.startsWith('整点报时'))
    const live = build({ enabled: true, quietFrom: 0, quietTo: 7 }, true)
    assert.equal(live?.label, '整点报时（0–7 点静音）')
    assert.equal(live?.type, 'checkbox')
    assert.equal(live?.checked, true)
    assert.equal(live?.enabled, true)
    const noSilence = build({ enabled: false, quietFrom: 3, quietTo: 3 }, true)
    assert.equal(noSilence?.label, '整点报时')
    assert.equal(noSilence?.checked, false)
    const noVoice = build({ enabled: true, quietFrom: 0, quietTo: 7 }, false)
    assert.equal(noVoice?.label, '整点报时（需先开启朗读）')
    assert.equal(noVoice?.enabled, false)
  })

  it('toggles terse replies from the menu, stating the cap it enforces', () => {
    // The whole point of the row is that a user who will not open `orb-reply.json` can still turn
    // the contract off; both directions have to reach the action with the clicked state.
    const clicked: boolean[] = []
    const build = (enabled: boolean) => contextMenuTemplate({
      catalog: { groups: [] },
      overlay: { provider: 'deepseek-official', model: 'plain' },
      background: { provider: 'deepseek-official', model: 'plain' },
      millifractionEnabled: true,
      replyEnabled: enabled,
      replyMaxChars: 60,
      wakeEnabled: false,
      wakeAvailable: false,
      wakeKeyword: 'hey_jarvis',
      wakeKeywords: [
        { keyword: 'hey_jarvis', spoken: 'Hey Jarvis', available: true },
        { keyword: 'dafeiyu', spoken: '大肥鱼大肥鱼', available: false },
      ],
      wakeWord: 'Hey Jarvis',
      openMain: true,
    }, true, {
      openMain() {},
      setOverlay() {},
      setBackground() {},
      setMillifraction() {},
      setReply: (value) => { clicked.push(value) },
      setWake() {},
      setWakeWord() {},
      disable() {},
    })
    const on = build(true).find((item) => item.label?.startsWith('极简回复'))
    assert.equal(on?.label, '极简回复（≤60 字）')
    assert.equal(on?.type, 'checkbox')
    assert.equal(on?.checked, true)
    on?.click?.({ checked: false })
    const off = build(false).find((item) => item.label?.startsWith('极简回复'))
    assert.equal(off?.checked, false)
    off?.click?.({ checked: true })
    assert.deepEqual(clicked, [false, true])
  })

  it('names the voice in use and offers the rest, but only when something can speak', () => {
    // The row exists because the timbre is a one-click preference nobody should have to find in
    // a JSON file; these are the four states it can be in, and each has to say the truth without
    // relying on the user having heard anything yet.
    const picked: string[] = []
    const voices = [
      { voice: 'stella', zh: 'stella（默认女声）', en: 'stella (default female)' },
      { voice: 'zh-CN-YunxiNeural', zh: '云希（年轻男声）', en: 'Yunxi (young male)' },
    ]
    const build = (speech: boolean, voice: string, offered: typeof voices) =>
      contextMenuTemplate({
        catalog: { groups: [] },
        overlay: { provider: 'deepseek-official', model: 'plain' },
        background: { provider: 'deepseek-official', model: 'plain' },
        millifractionEnabled: false,
        replyEnabled: true,
        replyMaxChars: 80,
        speechEnabled: speech,
        speechVoice: voice,
        speechVoices: offered,
        wakeEnabled: false,
        wakeAvailable: false,
        wakeKeyword: 'hey_jarvis',
        wakeKeywords: [],
        wakeWord: 'Hey Jarvis',
        openMain: true,
      }, true, {
        openMain() {},
        setOverlay() {},
        setBackground() {},
        setMillifraction() {},
        setReply() {},
        setChime() {},
        setSpeechVoice: (next) => { picked.push(next) },
        setWake() {},
        setWakeWord() {},
        disable() {},
      }).find((item) => item.label?.startsWith('音色'))

    const live = build(true, 'stella', voices)
    assert.equal(live?.label, '音色 · stella（默认女声）')
    assert.equal(live?.enabled, true)
    assert.equal(live?.submenu?.find((item) => item.label === 'stella（默认女声）')?.checked, true)
    assert.equal(live?.submenu?.find((item) => item.label === '云希（年轻男声）')?.checked, false)
    live?.submenu?.find((item) => item.label === '云希（年轻男声）')?.click?.({ checked: true })
    // An empty voice is a real state: it means the service reads in whatever it was started with.
    assert.equal(build(true, '', voices)?.label, '音色 · 跟随服务默认')
    // Without read-aloud there is nothing to choose a voice for, and the row says why.
    const off = build(false, 'stella', voices)
    assert.equal(off?.label, '音色（需先开启朗读）')
    assert.equal(off?.enabled, false)
    // And a build that offers no voices at all cannot open a submenu of nothing.
    assert.equal(build(true, 'stella', [])?.enabled, false)
    assert.deepEqual(picked, ['zh-CN-YunxiNeural'])
  })

  it('keeps every wake hook the ball page uses present in its markup and stylesheet', () => {
    const html = readFileSync(join(here, '..', 'assets', 'floating.html'), 'utf8')
    const css = readFileSync(join(here, '..', 'assets', 'floating.css'), 'utf8')
    const page = readFileSync(join(here, '..', 'assets', 'shell.js'), 'utf8')
    // The wake badge is the only new DOM the page reaches for by id.
    assert.match(html, /id="wake-badge"/)
    assert.match(page, /querySelector\('#wake-badge'\)/)
    // The asset route the engine fetches from has to be allowed by the page CSP.
    assert.match(html, /connect-src[^"]*dsh-wake:\/\/assets\//)
    assert.match(html, /'wasm-unsafe-eval'/)
    // The runtime arrives as a classic `<script src="dsh-wake://…">`, so the scheme has to
    // be in `script-src` too: with only `connect-src` the tag is blocked and the engine
    // fails with "onnxruntime script failed to load" while the ball sits on "loading".
    assert.match(html, /script-src[^;"]*dsh-wake:\/\/assets\//)
    // The four visual states the page toggles have to exist as rules.
    for (const state of ['wake-listening', 'wake-detected', 'wake-loading', 'wake-error', 'wake-recording']) {
      assert.ok(css.includes(`body.${state}`), state)
    }
    // The live level meter the recording state reveals: the row and its svg have to be in
    // the markup, its bars have to be built into that svg, and the levels have to come from
    // the engine. Any one of the three missing degrades to a permanently flat row. The curve
    // and the box themselves are pinned by running the real functions, in transcript-model.
    assert.match(html, /id="voice-wave"/)
    assert.match(page, /querySelector\('#voice-wave'\)/)
    assert.match(page, /wake\.waveform\(\)/)
    assert.match(page, /function paintWaveform\(levels\)/)
    // Detection no longer decorates the ball. The green ring was taken off on purpose — an
    // animation is going to replace it — so neither the glow nor its colour variable may come
    // back: a rule that put a shadow on `#ball` would quietly sit under that animation later.
    assert.equal(css.includes('wake-glow'), false)
    assert.equal(/body\.wake-detected #ball/.test(css), false)
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
    // Dictation: the page has to consume the helper's transcript event and the menu's
    // "speak one sentence" trigger, or the feature exists only on the helper side.
    assert.match(page, /api\.onTranscript\(/)
    assert.match(page, /api\.onDictate\(/)
    assert.match(page, /async function startDictation\(/)
    assert.match(page, /function applyTranscript\(/)
  })

  it('sends ball controls from the ball preload and keeps them off the toolbar', () => {
    const ball = loadPreload('../preload.cjs')
    ball.api.send?.('hello')
    ball.api.setPermission?.('read-only')
    ball.api.requestHistory?.()
    ball.api.openSession?.('session-1')
    ball.api.newSession?.()
    ball.api.stop?.()
    ball.api.answerQuestion?.('q', [{ id: 'q', selected: ['a'] }])
    void ball.api.tccStatus?.()
    void ball.api.openTcc?.('screen')
    void ball.api.wakeConfig?.()
    void ball.api.wakeEnable?.()
    void ball.api.wakeDisable?.()
    void ball.api.wakeReport?.({ state: 'listening' })
    void ball.api.setWakeEnabled?.(true)
    ball.api.onWake?.(() => {})
    assert.deepEqual(ball.sent.filter(([channel]) => !channel.startsWith('listen:')), [
      ['orb:prompt', 'hello'],
      ['orb:permission', 'read-only'],
      ['orb:history', undefined],
      ['orb:open', 'session-1'],
      ['orb:new', undefined],
      ['orb:stop', undefined],
      ['orb:question-answer', { id: 'q', answers: [{ id: 'q', selected: ['a'] }] }],
    ])
    assert.deepEqual(ball.invoked, [
      ['orb:tcc-status', undefined],
      ['orb:tcc-open', 'screen'],
      ['orb:wake-config', undefined],
      ['orb:wake-enable', undefined],
      ['orb:wake-disable', undefined],
      ['orb:wake-report', { state: 'listening' }],
      ['orb:wake-enabled', true],
    ])
    assert.deepEqual(ball.sent.filter(([channel]) => channel === 'listen:orb:wake').length, 1)
    assert.equal(ball.api.selection, undefined)
    const toolbar = loadPreload('../selection-preload.cjs')
    toolbar.api.selection?.search?.()
    toolbar.api.selection?.setLanguage?.('en')
    void toolbar.api.selection?.setContentSize?.({ width: 10, height: 20 })
    assert.deepEqual(toolbar.sent.filter(([channel]) => !channel.startsWith('listen:')), [
      ['orb:selection-action', { action: 'search' }],
      ['orb:selection-action', { action: 'language', language: 'en' }],
    ])
    assert.deepEqual(toolbar.invoked, [['orb:selection-size', { width: 10, height: 20 }]])
    assert.equal(toolbar.api.send, undefined)
    assert.equal(toolbar.api.setPermission, undefined)
    assert.equal(toolbar.api.tccStatus, undefined)
  })
})
