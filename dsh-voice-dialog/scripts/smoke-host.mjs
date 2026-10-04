/**
 * Host-half test for `dsh-voice-dialog`.
 *
 * The smoke harness only exercises the browser bundle, so the asset route that
 * feeds the wake-word engine would otherwise ship untested. This drives
 * `apply()` against a stub webserver, then calls the captured route handler with
 * fake requests to prove: the route is registered exactly once as a prefix,
 * every asset the browser half asks for is served with the content type that
 * matters, and path traversal is refused.
 *
 * Run: node scripts/smoke-host.mjs
 */

import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST = join(HERE, '..', 'lib', 'index.js')
const ASSETS = join(HERE, '..', 'assets')

const tests = []
function test(name, body) {
	tests.push([name, body])
}

/** Load the host half and capture the route it registers. */
async function mountHost() {
	const mod = await import(pathToFileURL(HOST).href)
	const routes = []
	const effects = []
	const ctx = {
		get: () => undefined,
		inject: (_names, callback) => callback(ctx),
		effect: (factory, label) => {
			effects.push({ label, dispose: factory() })
		},
		webServer: {
			register: (route) => {
				routes.push(route)
				return () => {}
			}
		}
	}
	mod.apply(ctx)
	return { mod, ctx, routes, effects }
}

/** A minimal ServerResponse that records what the handler wrote. */
function fakeRes() {
	return {
		status: undefined,
		headers: undefined,
		chunks: [],
		ended: false,
		writeHead(status, headers) {
			this.status = status
			this.headers = headers
		},
		write(chunk) {
			this.chunks.push(chunk)
		},
		end(chunk) {
			if (chunk !== undefined) this.chunks.push(chunk)
			this.ended = true
		},
		on() {},
		once() {},
		emit() {},
		// The handler pipes a read stream into the response, so the response has
		// to be a writable target for `pipe`.
		removeListener() {}
	}
}

/** Await the streamed body of a response produced by the route handler. */
function bodyOf(res) {
	return new Promise((resolve) => {
		if (res.ended) {
			resolve(Buffer.concat(res.chunks.map((c) => Buffer.from(c))))
			return
		}
		// `pipe` writes chunks after the handler resolves; poll until the stream
		// reaches the end of the file, which is what `ended` marks.
		const started = Date.now()
		const tick = () => {
			if (res.ended || Date.now() - started > 5000) {
				resolve(Buffer.concat(res.chunks.map((c) => Buffer.from(c))))
				return
			}
			setTimeout(tick, 20)
		}
		tick()
	})
}

/** Drive the captured prefix route for one pathname. */
async function request(routes, pathname) {
	const route = routes.find((r) => r.kind === 'prefix')
	const res = fakeRes()
	await route.handler({ url: pathname }, res)
	return { res, body: await bodyOf(res) }
}

test('the host half exports an apply function and injects webServer', async () => {
	const { mod } = await mountHost()
	assert.equal(typeof mod.apply, 'function')
	assert.deepEqual(mod.inject, ['webServer'])
})

test('apply registers exactly one prefix route', async () => {
	const { routes, effects } = await mountHost()
	assert.equal(routes.length, 1)
	assert.equal(routes[0].kind, 'prefix')
	assert.equal(routes[0].path, '/voice-assets')
	assert.equal(typeof routes[0].handler, 'function')
	assert.equal(effects.length, 1)
	assert.match(String(effects[0].label), /wake-word assets/)
})

test('every wake-word asset the browser half requests exists on disk', async () => {
	const needed = [
		'ort/ort.min.js',
		'ort/ort-wasm-simd-threaded.wasm',
		'ort/ort-wasm-simd-threaded.mjs',
		'melspectrogram.onnx',
		'embedding_model.onnx',
		'silero_vad.onnx',
		'hey_jarvis_v0.1.onnx'
	]
	for (const rel of needed) {
		const info = await stat(join(ASSETS, rel))
		assert.ok(info.isFile(), rel + ' must be a file')
		assert.ok(info.size > 1024, rel + ' must be non-trivial')
	}
})

test('the runtime script is served as JavaScript', async () => {
	const { routes } = await mountHost()
	const { res, body } = await request(routes, '/voice-assets/ort/ort.min.js')
	assert.equal(res.status, 200)
	assert.match(res.headers['content-type'], /javascript/)
	assert.ok(body.length > 1024)
})

test('the wasm binary is served as application/wasm', async () => {
	const { routes } = await mountHost()
	const { res, body } = await request(routes, '/voice-assets/ort/ort-wasm-simd-threaded.wasm')
	assert.equal(res.status, 200)
	// Streaming instantiation rejects any other type, so this exact value matters.
	assert.equal(res.headers['content-type'], 'application/wasm')
	// WebAssembly magic number.
	assert.equal(body.subarray(0, 4).toString('hex'), '0061736d')
})

test('models are served as octet-stream with a length', async () => {
	const { routes } = await mountHost()
	const { res, body } = await request(routes, '/voice-assets/hey_jarvis_v0.1.onnx')
	assert.equal(res.status, 200)
	assert.equal(res.headers['content-type'], 'application/octet-stream')
	assert.equal(Number(res.headers['content-length']), body.length)
	assert.ok(body.length > 1000000)
})

test('a missing asset answers 404', async () => {
	const { routes } = await mountHost()
	const { res } = await request(routes, '/voice-assets/nope.onnx')
	assert.equal(res.status, 404)
})

test('path traversal cannot escape the asset root', async () => {
	const { routes } = await mountHost()
	for (const attack of [
		'/voice-assets/../../package.json',
		'/voice-assets/..%2f..%2fpackage.json',
		'/voice-assets/ort/../../../lib/index.js'
	]) {
		const { res } = await request(routes, attack)
		assert.ok(res.status === 403 || res.status === 404, attack + ' must be refused, got ' + String(res.status))
	}
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
