/**
 * Host half of `dsh-voice-dialog`.
 *
 * The voice feature itself is browser-only: speech recognition and synthesis
 * both live in the Web Speech API, so this package contributes no host service,
 * tool, or prompt section.
 *
 * What it DOES own now is the wake-word asset carrier. The browser half runs
 * openWakeWord's pipeline (melspectrogram -> embedding -> per-keyword
 * classifier) through `onnxruntime-web`, and neither the ONNX models nor the
 * ONNX Runtime build can live in the client bundle: they are binary assets
 * (5.2 MB of models, 14 MB of WebAssembly) that must be fetched over HTTP from
 * the same origin. This half serves them from `assets/` at
 * `/voice-assets/*`, so the feature works fully offline on loopback with no
 * CDN dependency and no audio ever leaving the machine.
 *
 * @module dsh-voice-dialog
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of the package root, derived from this module's own URL. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Absolute path of the served asset directory. */
const ASSET_ROOT = join(PACKAGE_ROOT, 'assets')

/** URL prefix the browser half fetches assets from. */
const ASSET_ROUTE = '/voice-assets'

/**
 * Content types for every extension present under `assets/`.
 *
 * `application/wasm` is load-bearing: `WebAssembly.instantiateStreaming`
 * refuses a response whose content type is not exactly this, and ONNX Runtime
 * uses the streaming instantiation path.
 */
const MIME = {
	'.onnx': 'application/octet-stream',
	'.wasm': 'application/wasm',
	'.mjs': 'text/javascript; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	// The self-test page is served from this route so it shares the app's origin
	// and can therefore borrow the authenticated session cookie.
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8'
}

/**
 * Serve one file from {@link ASSET_ROOT}, or answer 404/403.
 *
 * The resolved target must stay inside the asset root: `normalize` plus the
 * prefix check is what makes `..` traversal a 403 instead of an arbitrary read.
 * @param req - the incoming request, whose URL carries the asset pathname.
 * @param res - the response, owned end to end by this handler.
 */
async function serveAsset(req, res) {
	const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
	const relative = decodeURIComponent(pathname.slice(ASSET_ROUTE.length)).replace(/^\/+/, '')
	const target = resolve(normalize(join(ASSET_ROOT, relative)))

	if (target !== ASSET_ROOT && !target.startsWith(ASSET_ROOT + sep)) {
		res.writeHead(403)
		res.end()
		return
	}

	let info
	try {
		info = await stat(target)
	} catch {
		res.writeHead(404)
		res.end()
		return
	}
	if (!info.isFile()) {
		res.writeHead(404)
		res.end()
		return
	}

	const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
	res.writeHead(200, {
		'content-type': type,
		'content-length': String(info.size),
		// Models are content-addressed by filename and only ever replaced with a
		// different name, so a long private cache is safe and keeps the ~19 MB
		// asset set off the wire on every page load.
		'cache-control': 'private, max-age=604800'
	})
	createReadStream(target).pipe(res)
}

/** Host-side services this half needs before it can serve anything. */
export const inject = ['webServer']

/**
 * Mount the asset route. Cordis rejects any loader entry that is neither a
 * function nor an object exposing `apply`, so this is the plugin body.
 * @param ctx - the host root context.
 */
export function apply(ctx) {
	const mount = (webCtx) => {
		webCtx.effect(
			() =>
				webCtx.webServer.register({
					kind: 'prefix',
					path: ASSET_ROUTE,
					handler: serveAsset
				}),
			'voice-dialog: wake-word assets'
		)
	}
	if (ctx.get('webServer') === undefined) ctx.inject(['webServer'], mount)
	else mount(ctx)
}
