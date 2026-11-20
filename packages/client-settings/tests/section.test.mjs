import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../../..')

// The host owns the preset ids, the page owns their names. Read the real list so a
// preset added on the host side without copy here fails a test instead of shipping.
const { AVATAR_PRESETS } = await import(pathToFileURL(join(root, 'packages/host/src/avatar-presets.ts')).href)

function loadSection(options = {}) {
  const calls = []
  let mode = 'ready'
  let confirm = false
  const snapshot = {
    supported: true,
    ballEnabled: true,
    avatarUrl: '/.dsh-orb/avatar?v=0',
    avatarPresetId: null,
    avatarPresets: AVATAR_PRESETS.map((preset) => ({ id: preset.id, url: `/.dsh-orb/avatar/preset/${preset.id}` })),
    overlay: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
    background: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
    selectionEnabled: false,
    millifractionEnabled: false,
    dictation: { enabled: true, silenceMs: 2200, maxSeconds: 15, autoSend: false },
    tcc: { applicable: true, appName: 'DeepSeek Harness', screen: 'missing', accessibility: 'granted' },
  }
  // `dictation: null` means a profile that has never stored one: the page has to fall back to 2.2 s
  // instead of rendering a thumb at zero.
  if (options.dictation === null) delete snapshot.dictation
  else if (options.dictation !== undefined) snapshot.dictation = options.dictation
  const catalog = {
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-flash',
        name: 'Flash',
        reasoning: { efforts: [{ id: 'max', name: 'Max' }, { id: 'high', name: 'High' }], defaultEffort: 'max' },
      }, {
        id: 'deepseek-pro',
        name: 'Pro',
      }],
    }],
  }
  const stateSlots = []
  const effects = []
  const ran = new Set()
  let cursor = 0
  const React = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((child) => child != null && child !== false && child !== true)
      if (typeof type === 'function') return type(props ?? {})
      return { type, props: props ?? {}, children: flat }
    },
    useState(initial) {
      const index = cursor++
      if (stateSlots[index] === undefined) stateSlots[index] = { current: initial }
      const slot = stateSlots[index]
      return [slot.current, (next) => {
        slot.current = typeof next === 'function' ? next(slot.current) : next
      }]
    },
    useEffect(effect) {
      effects[cursor] = effect
      cursor += 1
    },
    // Enough of `useRef` for a component that only uses it to know whether it is still mounted.
    useRef(initial) {
      return { current: initial }
    },
  }
  let registered
  let plugin
  let file = { size: 10, async arrayBuffer() { return new Uint8Array([1, 2, 3]).buffer } }
  const sandbox = {
    window: { confirm: () => confirm },
    document: {
      documentElement: { lang: '' },
      getElementById: () => null,
      head: { append() {} },
      createElement(tag) {
        if (tag !== 'input') return { id: '', textContent: '' }
        const input = {
          type: '',
          accept: '',
          files: [file],
          onchange: undefined,
          click() { input.onchange?.() },
        }
        return input
      },
    },
    navigator: { language: 'zh-CN' },
    // The tuning slider lives in `localStorage` because the reader that applies it is another
    // bundle; the page has to be able to write that key for the sample to mean anything.
    localStorage: (() => {
      const store = new Map()
      return {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => { store.set(key, String(value)) },
        removeItem: (key) => { store.delete(key) },
      }
    })(),
    // The page's wake bridge polls for as long as the page is open. A vm has no such thing, and a
    // real timer would outlive the last test and keep the process from exiting; a promise that
    // never settles parks the loop instead of running it.
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async (path, options = {}) => {
      // The wake hand-off polls this page for as long as it is open. That traffic belongs to the
      // ball, not to the settings section, and leaving it in the log would make every assertion
      // about "what the page asked for" depend on how long the test happened to run.
      if (path === '/.dsh-orb/main-voice') return json({ start: false })
      // The diagnosis beacon fires once per page load. It is deliberately outside the assertion
      // log for the same reason as the poll above: it reports the page, it does not serve it.
      if (path === '/.dsh-orb/client-report') return json({ ok: true })
      calls.push({ path, options })
      if (String(path).includes('token') || String(path).startsWith('http')) throw new Error(`credentialed fetch ${path}`)
      if (path === '/.dsh-orb/settings') {
        return json(mode === 'linux' ? { ...snapshot, supported: false, tcc: { ...snapshot.tcc, applicable: false } } : snapshot)
      }
      if (path === '/.dsh-orb/models') return json(catalog)
      if (options.method === 'POST' && path === '/.dsh-orb/ball') snapshot.ballEnabled = JSON.parse(options.body).enabled
      if (options.method === 'POST' && path === '/.dsh-orb/millifraction') snapshot.millifractionEnabled = JSON.parse(options.body).enabled
      if (options.method === 'POST' && path === '/.dsh-orb/overlay-model') snapshot.overlay = JSON.parse(options.body)
      if (options.method === 'POST' && path === '/.dsh-orb/avatar/preset') snapshot.avatarPresetId = JSON.parse(options.body).preset
      if (options.method === 'POST' && path === '/.dsh-orb/wake/silence') {
        snapshot.dictation = { ...(snapshot.dictation ?? { enabled: true, maxSeconds: 15, autoSend: false }), silenceMs: JSON.parse(options.body).silenceMs }
      }
      if (options.method === 'POST') return json(snapshot)
      return { ok: false, status: 404, async text() { return JSON.stringify({ error: 'missing' }) } }
    },
    console,
    // The page is a browser page: the slider's trailing save uses these. Real timers, so the test
    // can wait out the debounce instead of reaching into the page's internals.
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (id) => clearTimeout(id),
  }
  sandbox.window.__ModuleLoader__ = {
    load(spec) {
      plugin = spec.factory((id) => {
        if (id === 'react') return React
        throw new Error(id)
      })
      return plugin
    },
  }
  runInContext(readFileSync(join(here, '../client.js'), 'utf8'), createContext(sandbox))
  const ctx = {
    slots: {
      inject(_name, register) { register() },
      register(spec, Component) { registered = { spec, Component } },
    },
  }
  plugin.apply(ctx)

  function render() {
    cursor = 0
    return registered.Component()
  }
  async function flush() {
    for (let index = 0; index < effects.length; index += 1) {
      if (effects[index] === undefined || ran.has(index)) continue
      ran.add(index)
      await effects[index]()
    }
    for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return {
    calls,
    sandbox,
    spec: registered.spec,
    render,
    flush,
    setMode(next) { mode = next },
    setConfirm(next) { confirm = next },
    setFile(next) { file = next },
    setLang(next) { sandbox.document.documentElement.lang = next },
    reset() {
      stateSlots.length = 0
      effects.length = 0
      ran.clear()
    },
  }
}

function json(body) {
  return { ok: true, status: 200, async text() { return JSON.stringify(body) } }
}

function find(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) find(child, predicate, found)
  return found
}

describe('settings section', () => {
  it('registers 悬浮球 and talks to /.dsh-orb with relative fetches', async () => {
    const page = loadSection()
    assert.equal(page.spec.id, 'orb')
    assert.equal(page.spec.order, 25)
    assert.equal(page.spec.name, 'settings.section')
    assert.equal(page.spec.label(), '悬浮球')
    let view = page.render()
    await page.flush()
    view = page.render()
    assert.deepEqual(page.calls.map((call) => call.path), ['/.dsh-orb/settings', '/.dsh-orb/models'])
    const avatar = find(view, (node) => node.type === 'img')[0]
    assert.equal(avatar.props.src, '/.dsh-orb/avatar?v=0')
    assert.equal(String(avatar.props.src).includes('token'), false)

    const ball = find(view, (node) => node.props?.['aria-label'] === '启用悬浮球')[0]
    ball.props.onClick()
    await settle()
    const ballCall = page.calls.at(-1)
    assert.equal(ballCall.path, '/.dsh-orb/ball')
    assert.equal(JSON.parse(ballCall.options.body).enabled, false)

    view = page.render()
    const fraction = find(view, (node) => node.props?.['aria-label'] === '使用千分比坐标')[0]
    page.setConfirm(false)
    fraction.props.onClick()
    await settle()
    assert.equal(page.calls.some((call) => call.path === '/.dsh-orb/millifraction'), false)
    page.setConfirm(true)
    fraction.props.onClick()
    await settle()
    const fractionCall = page.calls.find((call) => call.path === '/.dsh-orb/millifraction')
    assert.equal(JSON.parse(fractionCall.options.body).enabled, true)

    view = page.render()
    const overlay = find(view, (node) => node.type === 'select' && node.props['aria-label'] === '悬浮球 Agent')[0]
    overlay.props.onChange({ target: { value: 'deepseek-official\u001fdeepseek-pro' } })
    await settle()
    const modelCall = page.calls.find((call) => call.path === '/.dsh-orb/overlay-model')
    assert.deepEqual(JSON.parse(modelCall.options.body), { provider: 'deepseek-official', model: 'deepseek-pro' })

    const choose = find(view, (node) => node.type === 'button' && node.children?.includes('选择图片'))[0]
    page.setFile({ size: 3 * 1024 * 1024, async arrayBuffer() { throw new Error('unread') } })
    choose.props.onClick()
    view = page.render()
    assert.equal(find(view, (node) => node.children?.includes('图片超过 2 MB。')).length, 1)
    assert.equal(page.calls.some((call) => call.path === '/.dsh-orb/avatar'), false)

    // Built-in GIFs: one animated thumbnail per shipped preset, named, and pickable.
    const gallery = find(view, (node) => node.props?.className === 'dsh-orb-set-presets-row')[0]
    assert.ok(gallery)
    const thumbs = gallery.children
    assert.equal(thumbs.length, AVATAR_PRESETS.length)
    for (const [index, preset] of AVATAR_PRESETS.entries()) {
      const button = thumbs[index]
      const image = find(button, (node) => node.type === 'img')[0]
      assert.equal(image.props.src, `/.dsh-orb/avatar/preset/${preset.id}`)
      const name = button.children.find((child) => child.type === 'span')
      assert.ok(name.children[0].length > 0, `${preset.id} has copy`)
      assert.equal(name.children[0] === preset.id, false, `${preset.id} has a real label, not the raw id`)
      assert.equal(button.props['aria-pressed'], 'false')
    }
    thumbs[1].props.onClick()
    await settle()
    const pick = page.calls.find((call) => call.path === '/.dsh-orb/avatar/preset')
    assert.equal(JSON.parse(pick.options.body).preset, AVATAR_PRESETS[1].id)

    // The snapshot the host echoes back is what marks the pick.
    view = page.render()
    const selected = find(view, (node) => node.props?.className === 'dsh-orb-set-preset is-selected')
    assert.equal(selected.length, 1)
    assert.equal(selected[0].props['aria-pressed'], 'true')

    page.setMode('linux')
    page.reset()
    page.calls.length = 0
    view = page.render()
    await page.flush()
    view = page.render()
    const fieldset = find(view, (node) => node.type === 'fieldset')[0]
    assert.equal(fieldset.props.disabled, true)
    assert.equal(find(view, (node) => node.children?.includes('悬浮球在 Linux 上不可用。')).length, 1)

    const pkg = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8'))
    assert.equal(pkg.name, '@dsh-orb/client-ui-settings-orb')
    assert.equal(pkg.exports['./client'], './client.js')
    assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings'])
    const patch = readFileSync(join(root, 'packages/bundle/cordis.patch.yml'), 'utf8')
    assert.match(patch, /id: ui-settings-orb/)
    assert.match(patch, /id: ui-settings-orb\n\s+name: dsh-orb\n/)
    const client = readFileSync(join(here, '../client.js'), 'utf8')
    // The selection toolbar is disabled (buggy): no settings entry point may ship.
    assert.equal(client.includes('划词'), false)
    assert.equal(client.includes('selectionToggle'), false)
    assert.equal(client.includes('authenticatedUrl'), false)
  })

  it('follows the main window locale on <html lang>', () => {
    const page = loadSection()
    assert.equal(page.spec.label(), '悬浮球', 'zh-CN navigator with no lang stays Chinese')
    page.setLang('en')
    assert.equal(page.spec.label(), 'Floating ball')
    page.setLang('zh-CN')
    assert.equal(page.spec.label(), '悬浮球')
    page.setLang('')
    assert.equal(page.spec.label(), '悬浮球', 'no lang falls back to the browser languages')
  })

  it('moves the finished-speaking pause: seconds on screen, milliseconds on the wire', async () => {
    const page = loadSection()
    let view = page.render()
    await page.flush()
    view = page.render()

    const slider = find(view, (node) => node.type === 'input' && node.props?.['data-role'] === 'silence')[0]
    assert.ok(slider, 'the voice panel has the pause slider')
    // The range is the requirement, in the unit the recorder uses; the copy next to it is seconds.
    assert.equal(slider.props.min, 1000)
    assert.equal(slider.props.max, 10000)
    assert.equal(slider.props.step, 100)
    assert.equal(slider.props.value, 2200, 'the stored 2.2 s is where the thumb starts')
    assert.equal(slider.props['aria-label'], '说完判定停顿')
    const readout = () => find(view, (node) => node.props?.className === 'dsh-orb-set-silence-value')[0]
    assert.deepEqual(readout().children, ['2.2 秒'])

    // The number follows the thumb immediately; the write waits for the hand to stop.
    slider.props.onChange({ target: { value: '3500' } })
    view = page.render()
    assert.deepEqual(readout().children, ['3.5 秒'], 'the readout moves before any request')
    assert.equal(page.calls.some((call) => call.path === '/.dsh-orb/wake/silence'), false)

    await settleFor(360)
    await settle()
    const save = page.calls.find((call) => call.path === '/.dsh-orb/wake/silence')
    assert.equal(save.options.method, 'POST')
    assert.deepEqual(JSON.parse(save.options.body), { silenceMs: 3500 }, 'seconds are converted once, here')

    // A second drag saves only its final position, not every step it passed through.
    view = page.render()
    const again = find(view, (node) => node.type === 'input' && node.props?.['data-role'] === 'silence')[0]
    again.props.onChange({ target: { value: '5000' } })
    again.props.onChange({ target: { value: '6000' } })
    await settleFor(360)
    await settle()
    const saves = page.calls.filter((call) => call.path === '/.dsh-orb/wake/silence')
    assert.equal(saves.length, 2, 'one write per gesture')
    assert.deepEqual(JSON.parse(saves.at(-1).options.body), { silenceMs: 6000 })
    view = page.render()
    assert.deepEqual(readout().children, ['6.0 秒'])
  })

  it('falls back to 2.5 s when the profile has never stored a pause', async () => {
    const page = loadSection({ dictation: null })
    let view = page.render()
    await page.flush()
    view = page.render()

    const slider = find(view, (node) => node.type === 'input' && node.props?.['data-role'] === 'silence')[0]
    assert.equal(slider.props.value, 2500, 'unset is the shipped default, never zero')
    const readout = find(view, (node) => node.props?.className === 'dsh-orb-set-silence-value')[0]
    assert.deepEqual(readout.children, ['2.5 秒'])

    slider.props.onChange({ target: { value: '1000' } })
    await settleFor(360)
    await settle()
    const save = page.calls.find((call) => call.path === '/.dsh-orb/wake/silence')
    assert.deepEqual(JSON.parse(save.options.body), { silenceMs: 1000 }, 'the low end of the range')
  })

  // The tuning is written where the reader reads it, not into the profile: the slider and the
  // player belong to different bundles, and a sample has to be heard on the next sentence rather
  // than after a restart. These three cases are the whole contract — the key, the sample, and
  // what happens when the reader is not there.
  it('writes the pitch under the key the reader reads', async () => {
    const page = loadSection()
    let view = page.render()
    await page.flush()
    view = page.render()

    const slider = find(view, (node) => node.type === 'input' && node.props?.['data-role'] === 'pitch')[0]
    assert.equal(slider.props.value, 0, 'a page that never touched the slider is the voice as sent')
    assert.equal(slider.props.min, -6)
    assert.equal(slider.props.max, 6)
    assert.equal(page.sandbox.localStorage.getItem('dsh-speak-button.pitch'), null, 'nothing is stored until it is moved')

    slider.props.onChange({ target: { value: '-3' } })
    assert.equal(page.sandbox.localStorage.getItem('dsh-speak-button.pitch'), '-3')

    view = page.render()
    const readout = find(view, (node) => node.props?.className === 'dsh-orb-set-pitch-value')[0]
    assert.deepEqual(readout.children, ['-3 半音'], 'the number on screen is the number that is stored')

    const reset = find(view, (node) => node.type === 'button' && node.children?.includes('复位'))[0]
    reset.props.onClick()
    assert.equal(page.sandbox.localStorage.getItem('dsh-speak-button.pitch'), '0', 'reset is a value, not an absence')
  })

  it('plays the sample through the reader, so the sample is the real voice', async () => {
    const page = loadSection()
    const samples = []
    // What the read-aloud bundle publishes on the page it shares with this one.
    page.sandbox.__dshSpeakButton = { preview: async (text) => { samples.push(text); return true } }
    let view = page.render()
    await page.flush()
    view = page.render()

    const button = find(view, (node) => node.type === 'button' && node.children?.includes('试听'))[0]
    assert.ok(button, 'the tuning card needs a way to hear the change')
    button.props.onClick()
    await settle()
    assert.equal(samples.length, 1, 'one press, one sample')
    assert.ok(samples[0].length > 0, 'the sample is a sentence, not silence')
  })

  it('says so when the reader is not on the page', async () => {
    const page = loadSection()
    let view = page.render()
    await page.flush()
    view = page.render()

    const button = find(view, (node) => node.type === 'button' && node.children?.includes('试听'))[0]
    button.props.onClick()
    await settle()
    view = page.render()
    const alert = find(view, (node) => node.props?.role === 'alert' && String(node.props?.className).includes('dsh-orb-set-error'))[0]
    assert.ok(alert, 'a press that can do nothing has to say why')
  })
})

async function settle() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Real time, for the slider's trailing save: the page debounces a drag instead of writing per step. */
async function settleFor(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
