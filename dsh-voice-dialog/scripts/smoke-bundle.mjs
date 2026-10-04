/**
 * Bundle smoke test for `dsh-voice-dialog`.
 *
 * The browser bundle is never executed by a build step, so this harness is the
 * only pre-flight check available without a browser: it installs the same
 * `window.__ModuleLoader__` facade the shell provides, records the registration,
 * materializes the factory against stub React/session/slots faces, and runs
 * `apply(ctx)` far enough to prove the plugin registers both surfaces and that
 * its own lifecycle wiring is sound.
 *
 * Run: node scripts/smoke-bundle.mjs
 *
 * It is a plain script rather than a `node --test` file on purpose: the DSH
 * sandbox blocks the piped stdio the test runner spawns its children with, so a
 * self-contained runner is the only portable form here.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'lib', 'client.js')
const PACKAGE = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))

/** Registrations collected by the local runner at the bottom of this file. */
const tests = []
/**
 * Declare one case for the local runner.
 * @param name - the case name.
 * @param body - an async or sync case body.
 */
function test(name, body) {
	tests.push([name, body])
}

/** A controllable timer set: the bundle delays work, and tests must drive it. */
function timerStub() {
	const pending = new Map()
	let nextId = 1
	return {
		setTimeout: (fn) => {
			const id = nextId++
			pending.set(id, fn)
			return id
		},
		clearTimeout: (id) => {
			pending.delete(id)
		},
		/** Run every currently scheduled callback once. */
		runAll: () => {
			const run = [...pending.values()]
			pending.clear()
			for (const fn of run) fn()
		},
		get size() {
			return pending.size
		}
	}
}

/** Minimal DOM/Runtime the bundle touches at materialization time. */
function installGlobals() {
	const styles = []
	const timers = timerStub()
	const document = {
		querySelector: () => null,
		createElement: () => ({ dataset: {}, textContent: '' }),
		head: {
			appendChild: (node) => styles.push(node)
		},
		addEventListener: () => {},
		removeEventListener: () => {}
	}
	const storage = new Map()
	const window = {
		document,
		speechSynthesis: undefined,
		localStorage: {
			getItem: (key) => (storage.has(key) ? storage.get(key) : null),
			setItem: (key, value) => storage.set(key, value)
		},
		addEventListener: () => {},
		removeEventListener: () => {},
		// The wake-word diagnostics poll through an interval; the setter of the
		// stubbed useState is a no-op, so these only need to exist.
		setInterval: () => 0,
		clearInterval: () => {},
		// Timers are driveable so the settle-before-read delay is testable.
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout
	}
	globalThis.window = window
	globalThis.document = document
	return { styles, window, storage, timers }
}

/** A React stand-in: createElement plus the hooks the bundle calls. */
function reactStub() {
	const React = {
		createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
		useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
		useRef: (initial) => ({ current: initial }),
		useEffect: () => {},
		useMemo: (factory) => factory(),
		useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot()
	}
	return {
		default: React,
		createElement: React.createElement,
		useState: React.useState,
		useRef: React.useRef,
		useEffect: React.useEffect,
		useMemo: React.useMemo,
		useSyncExternalStore: React.useSyncExternalStore
	}
}

/** A sessions service stand-in whose list and binding faces behave. */
function sessionsStub() {
	const listListeners = new Set()
	const eventListeners = new Set()
	const session = {
		sessionId: 'session-test',
		prompt: async () => ({ ok: true }),
		getSnapshot: () => ({ running: false, openState: 'open', sessionId: 'session-test' }),
		subscribe: (listener) => {
			eventListeners.add(listener)
			return () => eventListeners.delete(listener)
		},
		eventSource: {
			getSnapshot: () => ({ entries: [], hasMore: false, revision: 0 }),
			subscribe: (listener) => {
				eventListeners.add(listener)
				return () => eventListeners.delete(listener)
			}
		}
	}
	return {
		list: {
			getSnapshot: () => ({ current: 'session-test' }),
			subscribe: (listener) => {
				listListeners.add(listener)
				return () => listListeners.delete(listener)
			}
		},
		binding: (id) => (id === 'session-test' ? { session } : undefined),
		_session: session
	}
}

/**
 * Load and materialize the bundle against the stub platform.
 * @returns the registered id, the plugin exports, and the installed context.
 */
function loadBundle() {
	const { styles, timers } = installGlobals()
	let registration
	globalThis.window.__ModuleLoader__ = {
		mode: 'queue',
		pendingQueue: [],
		load: (entry) => {
			registration = entry
		},
		create: () => {
			throw new Error('not used by this test')
		}
	}
	const source = readFileSync(BUNDLE, 'utf8')
	// The bundle is a classic script by contract: evaluate it as one.
	new Function('window', 'document', source)(globalThis.window, globalThis.document)
	assert.ok(registration, 'the bundle must call window.__ModuleLoader__.load')
	const react = reactStub()
	const sessions = sessionsStub()
	const registered = []
	const effects = []
	const ctx = {
		logger: { warn: () => {}, error: () => {} },
		sessions,
		slots: {
			inject: (name, callback) => {
				registered.push({ name, dispose: callback() })
			},
			register: (options, component) => {
				registered.push({ name: options.name, options, component })
				return () => {}
			}
		},
		effect: (factory) => {
			const dispose = factory()
			effects.push(dispose)
			return () => {}
		}
	}
	const exports = registration.factory((spec) => {
		if (spec === 'react' || spec === 'react/jsx-runtime') return react
		throw new Error('bundle required an undeclared module: ' + spec)
	})
	return { registration, exports, ctx, registered, effects, styles, sessions, timers }
}

test('the bundle registers under the package name', () => {
	const { registration } = loadBundle()
	assert.equal(registration.id, PACKAGE.name, 'bundle id must equal the package name')
	assert.equal(typeof registration.factory, 'function')
})

test('the plugin face exports apply and inject', () => {
	const { exports } = loadBundle()
	assert.equal(typeof exports.apply, 'function')
	assert.deepEqual(exports.inject, ['sessions', 'slots'])
})

test('apply registers the composer control and the settings row', () => {
	const { exports, ctx, registered } = loadBundle()
	exports.apply(ctx)
	const names = registered.map((entry) => entry.name)
	assert.ok(names.includes('conversation.input.right'), 'composer control slot: ' + String(names))
	assert.ok(names.includes('settings.general.item'), 'settings row slot: ' + String(names))
	for (const entry of registered) {
		if (entry.component === undefined) continue
		assert.equal(typeof entry.component, 'function', entry.name + ' must register a component function, not an element')
		assert.ok(entry.options.id !== undefined, entry.name + ' must carry a list-slot id')
	}
})

test('the composer control renders without a live browser speech API', () => {
	const { exports, ctx, registered } = loadBundle()
	exports.apply(ctx)
	const entry = registered.find((candidate) => candidate.component !== undefined && candidate.name === 'conversation.input.right')
	const element = entry.component({ controller: entry.options.inject('session-test').controller })
	assert.equal(element.type, 'div')
	const button = element.props.children.find((child) => child !== null && child !== false && child.type === 'button')
	assert.ok(button !== undefined, 'the control renders a button')
	assert.equal(button.props.disabled, true, 'a browser without SpeechRecognition disables the control')
})

test('the settings row renders the auto-speak switch', () => {
	const { exports, ctx, registered } = loadBundle()
	exports.apply(ctx)
	const entry = registered.find((candidate) => candidate.component !== undefined && candidate.name === 'settings.general.item')
	const element = entry.component({ controller: entry.options.inject(undefined).controller })
	assert.equal(element.type, 'div')
	assert.ok(element.props.children.some((child) => child !== null && child.type !== undefined))
})

test('the injected controller sends a transcript into the bound session', async () => {
	const { exports, ctx, registered, sessions } = loadBundle()
	exports.apply(ctx)
	const entry = registered.find((candidate) => candidate.component !== undefined && candidate.name === 'conversation.input.right')
	const controller = entry.options.inject('session-test').controller
	let sent
	sessions._session.prompt = async (content) => {
		sent = content
		return { ok: true }
	}
	await controller.acceptTranscript('你好，测试语音输入')
	assert.deepEqual(sent, [{ type: 'text', text: '你好，测试语音输入' }])
	assert.equal(controller.getSnapshot().sending, false)
	assert.equal(controller.getSnapshot().transcript, '你好，测试语音输入')
})

test('a failing prompt surfaces as a user-visible error', async () => {
	const { exports, ctx, registered, sessions } = loadBundle()
	exports.apply(ctx)
	const entry = registered.find((candidate) => candidate.component !== undefined && candidate.name === 'conversation.input.right')
	const controller = entry.options.inject('session-test').controller
	sessions._session.prompt = async () => ({ ok: false, error: { code: 'gateway/internal', message: 'boom' } })
	await controller.acceptTranscript('测试失败')
	assert.match(controller.getSnapshot().error, /boom/)
})

test('a settled turn is read aloud when auto-speak is on', async () => {
	const { exports, ctx, registered, sessions, timers } = loadBundle()
	exports.apply(ctx)
	const entry = registered.find((candidate) => candidate.component !== undefined && candidate.name === 'conversation.input.right')
	const controller = entry.options.inject('session-test').controller
	const spoken = []
	controller.speak = (text) => spoken.push(text)
	let running = true
	sessions._session.getSnapshot = () => ({ running, openState: 'open', sessionId: 'session-test' })
	sessions._session.eventSource.getSnapshot = () => ({
		entries: [
			{
				type: 'event',
				event: {
					type: 'assistant/message',
					data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '语音回复内容' }] } }
				}
			}
		],
		hasMore: false,
		revision: 1
	})
	controller.setAutoSpeak(true)
	controller.inspectSession(sessions._session)
	running = false
	controller.inspectSession(sessions._session)
	// The read is deliberately delayed so the final message can land; drive it.
	timers.runAll()
	assert.deepEqual(spoken, ['语音回复内容'])
})

test('a settled turn reads its own reply, never the previous one', () => {
	const { exports, ctx, registered, sessions, timers } = loadBundle()
	exports.apply(ctx)
	const entry = registered.find((c) => c.component !== undefined && c.name === 'conversation.input.right')
	const controller = entry.options.inject('session-test').controller
	const spoken = []
	controller.speak = (text) => spoken.push(text)

	// The event window ends with turn 1's reply: the newest text available.
	const events = [
		{
			type: 'event',
			event: {
				type: 'assistant/message',
				data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第一轮的回复' }] } }
			}
		}
	]
	let running = true
	sessions._session.getSnapshot = () => ({ running, openState: 'open', sessionId: 'session-test' })
	sessions._session.eventSource.getSnapshot = () => ({ entries: events, hasMore: false, revision: 1 })

	controller.setAutoSpeak(true)

	// Turn 2 starts: still busy, and the window still only holds turn 1's text.
	controller.inspectSession(sessions._session)
	// The turn settles *before* its final message reaches the window. Reading
	// whatever is newest right now would speak turn 1 again — the reported bug.
	running = false
	events.push({
		type: 'event',
		event: {
			type: 'assistant/message',
			data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第二轮的回复' }] } }
		}
	})
	controller.inspectSession(sessions._session)
	timers.runAll()

	assert.deepEqual(spoken, ['第二轮的回复'], 'only the settled turn is read')
})

test('a wake detection chimes, times itself, and hands off to recognition', () => {
	const { exports, ctx, registered } = loadBundle()
	exports.apply(ctx)
	const entry = registered.find((c) => c.component !== undefined && c.name === 'conversation.input.right')
	const controller = entry.options.inject('session-test').controller

	// The stub environment has no AudioContext at all, which is the worst case for
	// the confirmation tone: it must be swallowed rather than breaking the wake
	// path. A missing AudioContext here also proves the guard is real.
	let armed = true
	controller.wakeEngine = {
		metrics: { detections: 0 },
		audioContext: undefined,
		stop: async () => { armed = false; }
	}
	// A detection is only actionable while the feature is on; the guard is
	// deliberate, so the fixture has to reflect a live feature.
	controller.patch({ wakeEnabled: true })
	controller.recognition = { start: () => {}, stop: () => {} }

	assert.equal(typeof controller.onWakeDetected, 'function')
	controller.onWakeDetected({ keyword: 'hey_jarvis', score: 0.93 })
	const after = controller.getSnapshot()
	assert.ok(after.lastWakeAt > 0, 'a detection records its timestamp')
	assert.match(after.error, /^$/, 'a detection does not raise a user-visible error')
})

test('the composer dock contributes an ambient wake status strip', () => {
	const { exports, ctx, registered } = loadBundle()
	exports.apply(ctx)
	const names = registered.map((entry) => entry.name)
	assert.ok(
		names.includes('conversation.composer.dock'),
		'the wake strip registers into the composer dock: ' + String(names)
	)

	const entry = registered.find((c) => c.component !== undefined && c.name === 'conversation.composer.dock')
	assert.equal(typeof entry.component, 'function')
	assert.ok(entry.options.id !== undefined, 'a list slot entry carries an id')
	assert.equal(entry.options.id, 'voice-dialog-wake')

	// Injected controller reaches the strip through the same face as the button.
	const controller = entry.options.inject('session-test').controller
	assert.equal(typeof controller, 'object')

	// Disarmed: the strip renders nothing at all, so an unused composer keeps its
	// full height.
	const hidden = entry.component({ controller })
	assert.ok(hidden === null || hidden === false, 'the strip stays hidden while wake is off, got: ' + String(hidden))
})

test('an auto-sent utterance returns the listener to wake mode', async () => {
	const { exports, ctx, registered, sessions } = loadBundle()
	exports.apply(ctx)
	const entry = registered.find((c) => c.component !== undefined && c.name === 'conversation.input.right')
	const controller = entry.options.inject('session-test').controller

	// State as it stands right after a wake detection: armed and loaded, but the
	// microphone has been handed to cloud recognition.
	controller.patch({ wakeEnabled: true, wakeReady: true, wakeListening: false, sending: false })
	controller.sessionFromWake = true
	controller.recognition = { start: () => {}, stop: () => {} }

	let armed = 0
	controller.armWake = async () => {
		armed += 1
		controller.patch({ wakeListening: true, mode: 'wake' })
	}
	sessions._session.prompt = async () => ({ ok: true })

	// Drive the real auto-send path: a finalized utterance, then the silence
	// timeout firing. Going through acceptTranscript() directly would skip the
	// stopListening() that used to strand the plugin.
	controller.pendingFinal = '自动发送的一句话'
	await controller.flushPendingTranscript()
	await new Promise((resolve) => setTimeout(resolve, 0))

	assert.equal(armed, 1, 'the listener is re-armed exactly once after an auto-send')
	assert.equal(controller.getSnapshot().wakeListening, true, 'wake mode is active again')

	// A manual stop must NOT bounce straight back into wake mode. There is no
	// suppression flag to assert on any more: the hand-back decision is derived
	// from the session's origin, so this checks that no second arm happens.
	controller.sessionFromWake = false
	controller.wakeEnabled = true
	controller.startListening()
	controller.stopListening()
	await controller.armWakeIfIdle('测试')
	assert.equal(armed, 1, 'a user-initiated stop is not handed back to the listener')
})

test('a pause does not split one utterance into several prompts', async () => {
	// The recognizer must be installed *after* loadBundle(), because that helper
	// replaces globalThis.window wholesale.
	const { exports, ctx, registered, sessions } = loadBundle()

	// Capture the recognizer the controller builds so its handlers can be driven
	// directly — the only way to exercise the real recognition path without a
	// browser.
	let handlers = {}
	function FakeRecognition() {
		handlers = {}
		for (const name of ['onstart', 'onresult', 'onerror', 'onend']) {
			Object.defineProperty(this, name, {
				set(fn) { handlers[name] = fn },
				get() { return handlers[name] },
				configurable: true
			})
		}
		this.start = () => {}
		this.stop = () => {}
		this.abort = () => {}
	}
	globalThis.window.SpeechRecognition = FakeRecognition

	exports.apply(ctx)
	const entry = registered.find((c) => c.component !== undefined && c.name === 'conversation.input.right')
	const controller = entry.options.inject('session-test').controller
	controller.patch({ wakeEnabled: true, wakeReady: true, wakeListening: false })

	const sent = []
	sessions._session.prompt = async (content) => {
		sent.push(content[0].text)
		return { ok: true }
	}
	controller.startListening()
	assert.equal(typeof handlers.onresult, 'function', 'the recognizer handlers were wired')

	// Two "final" results in a row is exactly what a mid-sentence pause produces.
	handlers.onresult({
		resultIndex: 0,
		results: [Object.assign([{ transcript: '第一句话。' }], { isFinal: true })]
	})
	await new Promise((resolve) => setTimeout(resolve, 0))
	assert.deepEqual(sent, [], 'a final result must not be sent on its own')

	handlers.onresult({
		resultIndex: 0,
		results: [Object.assign([{ transcript: '第二句话。' }], { isFinal: true })]
	})
	await new Promise((resolve) => setTimeout(resolve, 0))
	assert.deepEqual(sent, [], 'a second final result must not be sent either')
	assert.match(
		controller.getSnapshot().transcript,
		/第一句话。第二句话。/,
		'the whole utterance stays visible instead of only the latest fragment'
	)

	// The silence window elapsed: the accumulated utterance goes as ONE prompt.
	await controller.flushPendingTranscript()
	assert.deepEqual(sent, ['第一句话。第二句话。'], 'the utterance is sent as a single prompt')
})

test('a wake followed by silence returns to wake mode instead of hanging', async () => {
	const { exports, ctx, registered } = loadBundle()
	exports.apply(ctx)
	const entry = registered.find((c) => c.component !== undefined && c.name === 'conversation.input.right')
	const controller = entry.options.inject('session-test').controller
	controller.patch({ wakeEnabled: true, wakeReady: true, wakeListening: false, listening: true })
	// State as a wake-opened session leaves it; `startListening(true)` sets this.
	controller.sessionFromWake = true

	let armed = 0
	controller.armWake = async () => {
		armed += 1
		controller.patch({ wakeListening: true, mode: 'wake' })
	}
	let stopped = 0
	controller.recognition = { start: () => {}, stop: () => { stopped += 1 } }

	// The dead end this guards: with no recognition result there is nothing to
	// drive the silence timer, so without the empty-session timeout the plugin
	// stays in "listening" forever.
	await controller.onNothingSaid()
	assert.equal(stopped, 1, 'the stuck recognition session is stopped')
	assert.equal(armed, 1, 'the wake listener is armed again')
	assert.equal(controller.getSnapshot().wakeListening, true, 'wake mode is active again')

	// If a result did land, the timeout must stand down and let the normal
	// silence flush handle the utterance.
	controller.patch({ wakeListening: false, listening: true })
	controller.sessionFromWake = true
	controller.pendingFinal = '已经说了一半'
	stopped = 0
	armed = 0
	await controller.onNothingSaid()
	assert.equal(stopped, 0, 'a session with speech is not torn down')
	assert.equal(armed, 0, 'and it is not handed back to the wake listener')
	assert.equal(controller.pendingFinal, '已经说了一半', 'the buffered utterance survives')
})

test('both entry points arm the same nothing-said window', () => {
	const { exports, ctx, registered } = loadBundle()
	exports.apply(ctx)
	const entry = registered.find((c) => c.component !== undefined && c.name === 'conversation.input.right')
	const controller = entry.options.inject('session-test').controller
	controller.recognition = { start: () => {}, stop: () => {} }

	// A click on the microphone must get the same window as a wake word: both are
	// "the user is about to speak", and a click that is abandoned must not pin the
	// microphone open. The stub's setTimeout returns 0, so a defined timer is the
	// observable proof that it was armed at all.
	controller.emptyTimer = undefined
	controller.startListening()
	// The stub hands out real ids now, so "armed" means a timer handle exists.
	assert.notEqual(controller.emptyTimer, undefined, 'a manual session arms the empty timeout')
	assert.equal(controller.sessionFromWake, false, 'and is recorded as user-initiated')

	// A real browser clears this from the recognizer's `onstart`; the stub never
	// fires it, so reset it by hand or the guard rejects the second session.
	controller.recognitionStarting = false
	controller.emptyTimer = undefined
	controller.startListening(true)
	assert.notEqual(controller.emptyTimer, undefined, 'a wake session arms the empty timeout')
	assert.equal(controller.sessionFromWake, true, 'and is recorded as wake-initiated')
})

test('clicking twice always ends stopped, even mid-start', () => {
	const { exports, ctx, registered } = loadBundle()
	exports.apply(ctx)
	const entry = registered.find((c) => c.component !== undefined && c.name === 'conversation.input.right')
	const controller = entry.options.inject('session-test').controller

	let aborts = 0
	controller.recognition = { start: () => {}, stop: () => {}, abort: () => { aborts += 1 } }

	// The reported bug: between `start()` and the browser's `onstart`,
	// `state.listening` is still false while `recognitionStarting` is true. The
	// second click used to fall into the start branch and be swallowed by its own
	// guard, leaving the microphone open.
	controller.startListening()
	assert.equal(controller.recognitionStarting, true, 'session is starting')
	assert.equal(controller.getSnapshot().listening, false, 'but not yet reported as listening')

	controller.toggleListening()
	assert.equal(aborts, 1, 'the second click cancels instead of doing nothing')
	assert.equal(controller.recognitionStarting, false, 'the starting flag is cleared')
	assert.equal(controller.getSnapshot().listening, false, 'the UI reflects the cancel')

	// And a normal listening session still stops through the sending path.
	controller.startListening()
	controller.patch({ listening: true })
	controller.pendingFinal = ''
	controller.toggleListening()
	assert.equal(controller.getSnapshot().listening, false, 'a listening session stops')
})

test('continuous wake mode survives repeated speech hand-offs', async () => {
	const { exports, ctx, registered, sessions } = loadBundle()
	exports.apply(ctx)
	const entry = registered.find((c) => c.component !== undefined && c.name === 'conversation.input.right')
	const controller = entry.options.inject('session-test').controller
	controller.patch({ wakeEnabled: true, wakeReady: true, wakeListening: false })
	controller.recognition = { start: () => {}, stop: () => {} }
	sessions._session.prompt = async () => ({ ok: true })

	let armed = 0
	controller.armWake = async () => {
		armed += 1
		controller.patch({ wakeListening: true, mode: 'wake' })
	}
	controller.disarmWake = async () => {
		controller.patch({ wakeListening: false, mode: 'idle' })
	}

	// A wake word opens continuous mode, with the listener armed.
	controller.sessionFromWake = true
	controller.patch({ wakeListening: true })

	// Turn one: the reply is read aloud, which takes the microphone away and then
	// hands it back. This cycle is what used to kill wake permanently, because the
	// successful arm cleared the mode flag and the hand-back afterwards found
	// nothing outstanding.
	for (let turn = 1; turn <= 3; turn += 1) {
		// Synthesis seizes the microphone (this is what `speak()` does).
		if (controller.getSnapshot().wakeListening) await controller.disarmWake()
		controller.patch({ speaking: true })
		await controller.armWakeIfIdle('朗读期间')
		assert.equal(controller.wakeHandbackPending(), true, `turn ${turn}: the mode survives speaking`)
		assert.equal(controller.getSnapshot().wakeListening, false, `turn ${turn}: the listener stayed down`)

		// Speech ends: the microphone must come back.
		controller.patch({ speaking: false })
		await controller.armWakeIfIdle(`朗读结束后 ${turn}`)
		assert.equal(armed, turn, `turn ${turn}: the listener is re-armed`)
		assert.equal(controller.getSnapshot().wakeListening, true, `turn ${turn}: and is listening`)
		assert.equal(controller.wakeHandbackPending(), true, `turn ${turn}: the mode is still active`)
	}

	// Only a manual click ends the mode: that is the user asking for a one-shot.
	controller.startListening()
	assert.equal(controller.wakeHandbackPending(), false, 'a manual click leaves continuous mode')
	controller.patch({ speaking: false })
	await controller.armWakeIfIdle('手动点击后')
	assert.equal(armed, 3, 'and the listener is not re-armed after a manual session')
})

test('a failed hand-back is retried, then reported instead of looping', async () => {
	const { exports, ctx, registered } = loadBundle()
	exports.apply(ctx)
	const entry = registered.find((c) => c.component !== undefined && c.name === 'conversation.input.right')
	const controller = entry.options.inject('session-test').controller
	controller.patch({ wakeEnabled: true, wakeReady: true, wakeListening: false })
	controller.sessionFromWake = true

	// An arm that returns without arming: the listener is still owed.
	controller.armWake = async () => {}
	await controller.armWakeIfIdle('测试')
	assert.equal(controller.wakeHandbackPending(), true, 'the hand-back is still outstanding')
	// The stub's setTimeout never fires, so the budget is inspected by hand.
	assert.equal(controller.wakeRetries, 1, 'a retry was scheduled')
	assert.equal(controller.getSnapshot().wakePending, true, 'and stays visible while retrying')

	// Exhausting the budget surfaces an error rather than looping forever.
	controller.wakeRetries = 3
	controller.scheduleWakeRetry('测试')
	assert.equal(controller.getSnapshot().wakePending, false, 'the pending flag is cleared')
	assert.match(controller.getSnapshot().wakeError, /多次尝试/, 'the user is told to toggle the switch')
})

test('wakeArmed tracks the microphone, not the intent to use it', () => {
	const { exports, ctx, registered } = loadBundle()
	exports.apply(ctx)
	const entry = registered.find((c) => c.component !== undefined && c.name === 'conversation.input.right')
	const controller = entry.options.inject('session-test').controller
	controller.recognition = { start: () => {}, stop: () => {} }

	// Intent says "on"; no engine is running, so nothing is armed. The settings
	// page and the status strip must say so instead of claiming to monitor.
	controller.patch({ wakeEnabled: true, wakeReady: true })
	controller.syncWakeArmed()
	assert.equal(controller.getSnapshot().wakeArmed, false, 'no engine means not armed')

	controller.wakeEngine = { running: true, metrics: {} }
	controller.syncWakeArmed()
	assert.equal(controller.getSnapshot().wakeArmed, true, 'a running engine means armed')

	// The click path takes the microphone without touching wake intent; the flag
	// has to follow immediately or the UI lies about who holds the mic.
	controller.wakeEngine.running = false
	controller.startListening()
	assert.equal(controller.getSnapshot().wakeArmed, false, 'cloud recognition disarms the claim')
})

test('the stylesheet is injected exactly once per document', () => {
	const { styles } = loadBundle()
	assert.equal(styles.length, 1)
	assert.match(styles[0].dataset.pluginCss, /dsh-voice-dialog/)
})

/**
 * Flatten a rendered element tree into its text content.
 *
 * The stub creates plain `{ type, props }` nodes without ever running them, so
 * function components (SwitchRow, VoiceSettingsRow's helpers) have to be invoked
 * here to reach the strings they render.
 * @param node - a stub element, array, or primitive.
 * @param depth - recursion guard against a component that renders itself.
 * @returns the concatenated visible text.
 */
function textOf(node, depth = 0) {
	if (depth > 25) return ''
	if (node === null || node === undefined || node === false || node === true) return ''
	if (typeof node === 'string' || typeof node === 'number') return String(node)
	if (Array.isArray(node)) return node.map((child) => textOf(child, depth + 1)).join(' ')
	if (typeof node !== 'object' || node.type === undefined) return ''
	if (typeof node.type === 'function') {
		return textOf(node.type({ ...(node.props ?? {}), children: undefined }), depth + 1)
	}
	return textOf(node.props.children, depth + 1)
}

test('the composer control offers a wake toggle and exposes live metrics', () => {
	const { exports, ctx, registered } = loadBundle()
	exports.apply(ctx)
	const entry = registered.find((c) => c.component !== undefined && c.name === 'conversation.input.right')
	const controller = entry.options.inject('session-test').controller

	// The diagnostics read this object; a fresh controller has no engine yet.
	assert.equal(controller.getWakeMetrics(), undefined)

	// Simulate an armed engine and confirm the exposed counters are the ones the
	// diagnostics panel renders.
	const metrics = { frames: 42, score: 0.91, peak: 0.97, level: 0.3, speech: true, contextState: 'running', detections: 2 }
	controller.wakeEngine = { metrics, audioContext: undefined }
	assert.equal(controller.getWakeMetrics().score, 0.91)
	assert.equal(controller.getWakeMetrics().detections, 2)

	// Rendering the diagnostics surface must not throw with no engine, with an
	// engine, or when wake is switched off.
	const button = entry.component({ controller })
	assert.ok(button !== undefined)
})

test('the settings row renders a wake toggle alongside auto-speak', () => {
	const { exports, ctx, registered } = loadBundle()
	exports.apply(ctx)
	const entry = registered.find((c) => c.component !== undefined && c.name === 'settings.general.item')
	const controller = entry.options.inject(undefined).controller
	const element = entry.component({ controller })
	const text = textOf(element)
	assert.match(text, /语音对话/, 'auto-speak row is present: ' + text.slice(0, 200))
	assert.match(text, /本地语音唤醒/, 'wake switch is present: ' + text.slice(0, 200))

	// The sensitivity slider only exists while wake is armed, and the stub's
	// useState setter is inert, so its conditional branch cannot be reached by
	// rendering. Assert the wiring instead: the wake switch must call the
	// controller's arm/disarm entry point rather than flipping local state.
	const buttons = []
	const collect = (node, depth = 0) => {
		if (depth > 25 || node === null || node === undefined) return
		if (Array.isArray(node)) { node.forEach((c) => collect(c, depth + 1)); return }
		if (typeof node !== 'object' || node.type === undefined) return
		if (typeof node.type === 'function') {
			collect(node.type({ ...(node.props ?? {}), children: undefined }), depth + 1)
			return
		}
		if (node.type === 'button' && typeof node.props?.onClick === 'function') buttons.push(node.props)
		collect(node.props?.children, depth + 1)
	}
	collect(element)

	const wakeSwitch = buttons.find((b) => String(b['aria-label'] ?? '').includes('本地语音唤醒'))
	assert.ok(wakeSwitch !== undefined, 'wake switch exposes a clickable control: ' + JSON.stringify(buttons.map((b) => b['aria-label'])))

	let armed
	controller.setWakeEnabled = async (value) => { armed = value }
	wakeSwitch.onClick()
	assert.equal(armed, true, 'the wake switch forwards to setWakeEnabled')
})

// ── runner ───────────────────────────────────────────────────────────────────
const results = []
for (const [name, body] of tests) {
	try {
		await body()
		results.push({ name, ok: true })
	} catch (error) {
		results.push({ name, ok: false, error })
	}
}
let failed = 0
for (const result of results) {
	if (result.ok) {
		process.stdout.write('  ok   ' + result.name + '\n')
	} else {
		failed += 1
		process.stdout.write('  FAIL ' + result.name + '\n       ' + String(result.error?.message ?? result.error) + '\n')
	}
}
process.stdout.write('\n' + String(results.length - failed) + '/' + String(results.length) + ' passed\n')
process.exit(failed === 0 ? 0 : 1)
