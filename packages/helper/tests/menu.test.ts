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

  it('lists open, both models, coordinates, wake, voice input, and disable', () => {
    const actions: string[] = []
    const template = contextMenuTemplate({
      catalog,
      overlay: { provider: 'deepseek-official', model: 'plain' },
      background: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
      millifractionEnabled: false,
      wakeEnabled: false,
      wakeAvailable: true,
      dictationReady: true,
      openMain: true,
    }, true, {
      openMain: () => { actions.push('open') },
      setOverlay: () => { actions.push('overlay') },
      setBackground: () => { actions.push('background') },
      setMillifraction: (enabled) => { actions.push(`fraction:${enabled}`) },
      setWake: (enabled) => { actions.push(`wake:${enabled}`) },
      dictate: () => { actions.push('dictate') },
      disable: () => { actions.push('disable') },
    })
    assert.deepEqual(template.map((item) => item.label ?? item.type), [
      '打开主窗口',
      '悬浮球 Agent 模型',
      '后台 Agent 模型',
      '千分比坐标',
      '语音唤醒（Hey Jarvis）',
      '语音输入（现在说一句）',
      'separator',
      '停用悬浮球',
    ])
    assert.equal(template[0]?.enabled, true)
    template[0]?.click?.({ checked: false })
    template[3]?.click?.({ checked: true })
    template[4]?.click?.({ checked: true })
    // Voice input needs the wake engine running, so the row follows that state.
    assert.equal(template[5]?.enabled, true)
    template[5]?.click?.({ checked: false })
    template[7]?.click?.({ checked: false })
    const background = template[2]?.submenu?.find((item) => item.label === '✓ Flash')
    assert.equal(background?.submenu?.find((item) => item.label === 'Max')?.checked, true)
    background?.submenu?.[0]?.click?.({ checked: true })
    assert.deepEqual(actions, ['open', 'fraction:true', 'wake:true', 'dictate', 'disable', 'background'])
    // With the engine off the row explains itself instead of recording nothing.
    const noEngine = contextMenuTemplate({
      catalog,
      overlay: { provider: 'deepseek-official', model: 'plain' },
      background: { provider: 'deepseek-official', model: 'plain' },
      millifractionEnabled: false,
      wakeEnabled: false,
      wakeAvailable: true,
      dictationReady: false,
      openMain: true,
    }, true, {
      openMain: () => {},
      setOverlay: () => {},
      setBackground: () => {},
      setMillifraction: () => {},
      setWake: () => {},
      dictate: () => { actions.push('should-not-run') },
      disable: () => {},
    })
    assert.equal(noEngine[5]?.label, '语音输入（需先开启语音唤醒）')
    assert.equal(noEngine[5]?.enabled, false)
    const english = contextMenuTemplate({
      catalog: { groups: [] },
      overlay: { provider: 'deepseek-official', model: 'plain' },
      background: { provider: 'deepseek-official', model: 'plain' },
      millifractionEnabled: false,
      wakeEnabled: false,
      wakeAvailable: true,
      openMain: false,
    }, false, {
      openMain() {},
      setOverlay() {},
      setBackground() {},
      setMillifraction() {},
      setWake() {},
      disable() {},
    })
    assert.equal(english[0]?.label, 'Open Main Window')
    assert.equal(english[0]?.enabled, false)
    assert.equal(english[4]?.label, 'Voice wake word (Hey Jarvis)')
    assert.equal(english.at(-1)?.label, 'Disable floating ball')
  })

  it('disables the wake row when no model directory was found', () => {
    const template = contextMenuTemplate({
      catalog: { groups: [] },
      overlay: { provider: 'deepseek-official', model: 'plain' },
      background: { provider: 'deepseek-official', model: 'plain' },
      millifractionEnabled: false,
      wakeEnabled: false,
      wakeAvailable: false,
      openMain: false,
    }, true, {
      openMain() {},
      setOverlay() {},
      setBackground() {},
      setMillifraction() {},
      setWake() {},
      disable() {},
    })
    const row = template.find((item) => item.label?.startsWith('语音唤醒'))
    assert.equal(row?.label, '语音唤醒（未找到本地模型）')
    assert.equal(row?.enabled, false)
    assert.equal(row?.checked, false)
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
