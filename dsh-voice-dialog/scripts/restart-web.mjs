/**
 * Restart the DSH web server that serves the GUI at http://127.0.0.1:3080.
 *
 * Why this exists: the voice-dialog plugin was added to the `web` profile, and
 * the running server must be replaced for the new row (and its served client
 * bundle) to exist. This script can therefore not be run BY the server it
 * replaces — it is spawned detached, so it survives the death of the very
 * process that started it, then waits for the port to be released, boots a fresh
 * `dsh web` in its own process group, and self-checks readiness over HTTP.
 *
 * A readiness probe answering 401 is SUCCESS: the DSH webserver authenticates
 * every request and the probe has no browser cookie.
 *
 * Usage: node restart-web.mjs [--port 3080] [--timeout-ms 180000]
 */

import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = 'D:\\DeepSeekHarness\\npm-global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const NODE = process.execPath
const LOG_DIR = join(HERE, 'logs')

/** Read one `--flag value` argument, falling back to a default. */
function arg(name, fallback) {
	const index = process.argv.indexOf('--' + name)
	if (index === -1 || index + 1 >= process.argv.length) return fallback
	return process.argv[index + 1]
}

const PORT = Number(arg('port', '3080'))
const TIMEOUT_MS = Number(arg('timeout-ms', '180000'))
const URL = 'http://127.0.0.1:' + String(PORT) + '/'

/** Resolve after `ms` milliseconds. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Probe the server root.
 * @returns a promise of the HTTP status, or undefined when nothing answers.
 */
async function probe() {
	try {
		const response = await fetch(URL, { redirect: 'manual', signal: AbortSignal.timeout(4000) })
		return response.status
	} catch {
		return undefined
	}
}

/** Wait until nothing answers on the port (or the deadline passes). */
async function waitForPortFree() {
	const deadline = Date.now() + TIMEOUT_MS
	for (;;) {
		const status = await probe()
		if (status === undefined) return true
		if (Date.now() > deadline) return false
		await sleep(1000)
	}
}

/** Wait until the freshly booted server answers. */
async function waitForReady() {
	const deadline = Date.now() + TIMEOUT_MS
	for (;;) {
		const status = await probe()
		if (status !== undefined) return status
		if (Date.now() > deadline) return undefined
		await sleep(1000)
	}
}

mkdirSync(LOG_DIR, { recursive: true })
const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\..+$/u, '')
const outPath = join(LOG_DIR, 'web-' + stamp + '.log')
const errPath = join(LOG_DIR, 'web-' + stamp + '.err.log')
// `spawn` needs real file descriptors: a WriteStream has `fd === null` until its
// open completes, and Node rejects it with ERR_INVALID_ARG_VALUE.
const outFd = openSync(outPath, 'a')
const errFd = openSync(errPath, 'a')
const note = (line) => {
	const text = '[restart-web] ' + line + '\n'
	appendFileSync(outPath, text)
	process.stdout.write(text)
}

note('started; waiting for port ' + String(PORT) + ' to be released')
const freed = await waitForPortFree()
if (!freed) {
	note('port ' + String(PORT) + ' is still answering after ' + String(TIMEOUT_MS) + 'ms — aborting, nothing was started')
	process.exit(2)
}

note('port is free; booting `dsh web`')
const child = spawn(NODE, [CLI, 'web'], {
	cwd: HERE,
	detached: true,
	stdio: ['ignore', outFd, errFd],
	windowsHide: true,
	env: { ...process.env }
})
child.unref()
note('spawned pid ' + String(child.pid))

const status = await waitForReady()
if (status === undefined) {
	note('the new server did not answer within ' + String(TIMEOUT_MS) + 'ms — inspect ' + join(LOG_DIR, 'web-' + stamp + '.err.log'))
	process.exit(3)
}
note('server is up: GET ' + URL + ' answered ' + String(status) + (status === 401 ? ' (expected: no browser cookie)' : ''))
note('done; open ' + URL + ' and refresh the page to load the voice plugin')

// ── hand the login URL to the user ───────────────────────────────────────────
// `dsh web` prints its own tokenized URL (`/?token=...`) and normally opens a
// browser with it. That line lands in the server's stdout log a moment after the
// port starts answering, so read it back and put it on the clipboard as well:
// the token changes on every boot, and a URL the user cannot find is the same as
// no server at all.
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let loginUrl
for (let attempt = 0; attempt < 20 && loginUrl === undefined; attempt += 1) {
	try {
		const text = readFileSync(outPath, 'utf8')
		const match = text.match(/https?:\/\/\S*\/?\?token=\S+/u)
		if (match) loginUrl = match[0]
	} catch {
		/* the log may not exist yet on the first pass */
	}
	if (loginUrl === undefined) await sleepMs(500)
}

if (loginUrl === undefined) {
	note('could not read the tokenized URL yet; read it from ' + outPath)
} else {
	note('login URL: ' + loginUrl)
	try {
		// clip.exe is the one clipboard writer present on every Windows install.
		execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'clip.exe'), {
			input: loginUrl,
			windowsHide: true
		})
		note('the login URL is now on the clipboard — paste it into the browser address bar')
	} catch {
		/* clipboard is a convenience; the note above already carries the URL */
	}
}
process.exit(0)
