/**
 * Browser half of `dsh-voice-dialog`: a hand-written lazy-CJS plugin bundle.
 *
 * The DSH module system (see `@deepseek-ai/dsh-client-modules`) executes every
 * client bundle through `window.__ModuleLoader__.load({ id, factory })`; running
 * this file only REGISTERS the factory, and every side effect (including the
 * stylesheet injection below) runs at materialization. `id` must equal the
 * package name in package.json exactly, and the `require` handed to the factory
 * resolves only against the shell's frozen platform table plus registered graph
 * rows — the table seeds React, Cordis, the client store, the UI slots/primitives
 * faces, and the dockkit.
 */

window.__ModuleLoader__.load({
	id: 'dsh-voice-dialog',
	factory: (require) => {
		const React = require('react');

		// ── stylesheet ───────────────────────────────────────────────────────
		const CSS = `
.dshVoice_root{position:relative;display:inline-flex;align-items:center}
.dshVoice_btn{position:relative;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:color .12s,background-color .12s}
.dshVoice_btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-fill-l2)}
.dshVoice_btn:disabled{opacity:.45;cursor:default}
.dshVoice_btn[data-state="listening"]{color:var(--dsw-alias-label-error,#e5484d);background:color-mix(in srgb,currentColor 12%,transparent)}
.dshVoice_btn[data-state="speaking"]{color:var(--dsw-alias-label-accent,var(--dsw-alias-label-primary))}
.dshVoice_btn[data-auto="on"]::after{content:"";position:absolute;top:3px;right:3px;width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.85}
.dshVoice_btn[data-wake="on"]{color:var(--dsw-alias-label-accent,#4d6bfe)}
.dshVoice_btn[data-wake="on"]::before{content:"";position:absolute;bottom:3px;left:3px;width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.7}
.dshVoice_btn[data-wake="loading"]::before{content:"";position:absolute;bottom:3px;left:3px;width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.35;animation:dshVoice_wakeblink 1s ease-in-out infinite}
@keyframes dshVoice_wakeblink{0%,100%{opacity:.2}50%{opacity:.8}}
.dshVoice_range{flex:none;width:104px}
.dshVoice_diag{margin:6px 8px 2px;padding:7px 9px;border-radius:9px;background:var(--dsw-alias-fill-l2);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dshVoice_diagHead{display:flex;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-tertiary);margin-bottom:6px}
.dshVoice_diagOk{color:var(--dsw-alias-label-success,#2ea043)}
.dshVoice_diagBad{color:var(--dsw-alias-label-error,#e5484d)}
.dshVoice_meter{position:relative;height:7px;border-radius:4px;background:var(--dsw-alias-fill-l3,rgba(127,127,127,.28));overflow:hidden;margin:2px 0 4px}
.dshVoice_meter>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#4d6bfe,#3ddc84);transition:width .1s linear}
.dshVoice_meter>u{position:absolute;top:-2px;bottom:-2px;width:1.5px;background:var(--dsw-alias-label-tertiary);opacity:.9}
.dshVoice_meterInput{margin-bottom:4px}
.dshVoice_meterInput>i{background:linear-gradient(90deg,#7f8ea3,#c3ccd8);transition:width .12s linear}
.dshVoice_diagRow{display:flex;justify-content:space-between;gap:8px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.dshVoice_bar{margin:6px auto 0;max-width:min(760px,100%);padding:0 4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dshVoice_barMain{display:flex;align-items:center;gap:8px;width:100%;padding:4px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}
.dshVoice_barMain:hover{background:var(--dsw-alias-fill-l2)}
.dshVoice_dot{flex:none;width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.45}
.dshVoice_dotOn{background:var(--dsw-alias-label-accent,#4d6bfe);opacity:1;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-label-accent,#4d6bfe) 22%,transparent)}
.dshVoice_dotLoad{background:var(--dsw-alias-label-warning,#d29922);opacity:.9;animation:dshVoice_wakeblink 1s ease-in-out infinite}
.dshVoice_dotBad{background:var(--dsw-alias-label-error,#e5484d);opacity:1}
.dshVoice_dotDim{background:var(--dsw-alias-label-tertiary);opacity:.5}
.dshVoice_barStage{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshVoice_barLabel{flex:none;color:var(--dsw-alias-label-secondary)}
.dshVoice_barMeter{position:relative;flex:1 1 120px;min-width:90px;height:6px;border-radius:3px;background:var(--dsw-alias-fill-l3,rgba(127,127,127,.28));overflow:hidden}
.dshVoice_barMeter>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#4d6bfe,#3ddc84);transition:width .1s linear}
.dshVoice_barMeter>u{position:absolute;top:-2px;bottom:-2px;width:1.5px;background:var(--dsw-alias-label-tertiary);opacity:.9}
.dshVoice_barNum{flex:none;min-width:34px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dshVoice_barMeta{flex:none;white-space:nowrap}
.dshVoice_barCaret{flex:none;opacity:.6}
.dshVoice_barBody{margin:2px 8px 0;padding:7px 9px;border-radius:9px;background:var(--dsw-alias-fill-l2);display:flex;flex-direction:column;gap:4px}
@media (max-width:560px){.dshVoice_barMeta{display:none}}
.dshVoice_wakeRow{display:block}
.dshVoice_wakeRow .dshVoice_rowText{margin-bottom:4px}
.dshVoice_pulse{position:absolute;inset:0;border-radius:8px;border:1.5px solid currentColor;opacity:0;pointer-events:none}
.dshVoice_btn[data-state="listening"] .dshVoice_pulse{animation:dshVoice_pulse 1.5s ease-out infinite}
@keyframes dshVoice_pulse{0%{opacity:.55;transform:scale(1)}100%{opacity:0;transform:scale(1.35)}}
.dshVoice_menu{position:absolute;bottom:calc(100% + 8px);right:0;z-index:60;box-sizing:border-box;width:286px;padding:8px;border:1px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-l2));border-radius:14px;background:var(--dsw-specific-menu,#fff);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.18));color:var(--dsw-alias-label-primary)}
.dshVoice_row{display:flex;align-items:center;gap:10px;padding:6px 8px;font-size:13px;line-height:18px}
.dshVoice_row + .dshVoice_row{border-top:1px solid var(--dsw-alias-border-l2)}
.dshVoice_rowText{flex:1;min-width:0}
.dshVoice_title{color:var(--dsw-alias-label-primary)}
.dshVoice_desc{margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dshVoice_select{max-width:132px;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-fill-l2);border:0;border-radius:6px;padding:3px 4px}
.dshVoice_switch{flex:none;position:relative;width:34px;height:20px;border:0;border-radius:999px;background:var(--dsw-alias-fill-l3,rgba(127,127,127,.35));cursor:pointer;transition:background-color .15s}
.dshVoice_switch[data-on="1"]{background:var(--dsw-alias-label-accent,#4d6bfe)}
.dshVoice_switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}
.dshVoice_switch[data-on="1"]::after{transform:translateX(14px)}
/* The transcript and error live inside a 30px-wide inline-flex button container,
   so they must be taken out of flow: anchored above the composer tool row, with
   their own width. In flow they collapse to the button's width and wrap one
   character per line. */
.dshVoice_transcript{position:absolute;bottom:calc(100% + 6px);right:0;z-index:55;box-sizing:border-box;width:max-content;max-width:min(420px,72vw);margin:0;padding:7px 10px;max-height:110px;overflow:auto;border-radius:10px;background:var(--dsw-specific-menu,#fff);box-shadow:var(--dsw-elevation-prominent,0 6px 20px rgba(0,0,0,.16));font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;text-align:left}
.dshVoice_error{position:absolute;bottom:calc(100% + 6px);right:0;z-index:55;box-sizing:border-box;width:max-content;max-width:min(420px,72vw);margin:0;padding:6px 10px;border-radius:10px;background:var(--dsw-specific-menu,#fff);box-shadow:var(--dsw-elevation-prominent,0 6px 20px rgba(0,0,0,.16));font-size:11px;line-height:16px;color:var(--dsw-alias-label-error,#e5484d);text-align:left}
/* Panels (menu, settings) are full-width blocks, so errors there stay in flow. */
.dshVoice_menu .dshVoice_error,.dshVoice_menu .dshVoice_transcript,
.dshVoice_barBody .dshVoice_error{position:static;width:auto;max-width:none;box-shadow:none;background:transparent;padding:0}
.dshVoice_hint{margin:0 8px 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dshVoice_replay{width:100%;margin:2px 0 0;padding:6px 8px;border:0;border-radius:8px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}
.dshVoice_replay:hover:not(:disabled){background:var(--dsw-alias-fill-l3)}
.dshVoice_replay:disabled{opacity:.45;cursor:default}
`;

		const STYLE_ID = 'dsh-voice-dialog/voice.css';
		if (typeof document !== 'undefined') {
			const existing = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]');
			if (existing === null) {
				const tag = document.createElement('style');
				tag.dataset.plugin = 'dsh-voice-dialog';
				tag.dataset.pluginCss = STYLE_ID;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
		}

		// ── languages ────────────────────────────────────────────────────────
		/** Recognition locales offered in the menu; the label is what a user reads. */
		const LANGUAGES = [
			{ id: 'zh-CN', label: '中文（普通话）', speech: 'zh-CN' },
			{ id: 'zh-HK', label: '中文（粤语）', speech: 'zh-HK' },
			{ id: 'en-US', label: 'English (US)', speech: 'en-US' },
			{ id: 'en-GB', label: 'English (UK)', speech: 'en-GB' },
			{ id: 'ja-JP', label: '日本語', speech: 'ja-JP' },
			{ id: 'ko-KR', label: '한국어', speech: 'ko-KR' },
			{ id: 'fr-FR', label: 'Français', speech: 'fr-FR' },
			{ id: 'de-DE', label: 'Deutsch', speech: 'de-DE' },
			{ id: 'es-ES', label: 'Español', speech: 'es-ES' },
			{ id: 'ru-RU', label: 'Русский', speech: 'ru-RU' }
		];

		// ── persisted preferences ────────────────────────────────────────────
		const STORE_KEY = 'dsh-voice-dialog/preferences/v1';

		/** Read persisted preferences, tolerating absent or corrupt storage. */
		function readPreferences() {
			try {
				const raw = window.localStorage.getItem(STORE_KEY);
				if (raw === null) return {};
				const parsed = JSON.parse(raw);
				return typeof parsed === 'object' && parsed !== null ? parsed : {};
			} catch {
				return {};
			}
		}

		/** Persist preferences, ignoring a storage that refuses writes. */
		function writePreferences(value) {
			try {
				window.localStorage.setItem(STORE_KEY, JSON.stringify(value));
			} catch {
				/* private mode / quota: preferences simply do not outlive the tab */
			}
		}

		// ── text preparation for speech ──────────────────────────────────────
		const SPEAK_MAX_CHARS = 1800;

		/**
		 * Turn assistant markdown into something worth hearing: tool-call syntax,
		 * fenced code, links, tables, and emphasis markers all read as noise.
		 * @param {string} text - raw assistant text.
		 * @returns {string} speech-ready plain text.
		 */
		function toSpeakable(text) {
			let out = String(text ?? '');
			out = out.replace(/```[\s\S]*?```/g, ' … ');
			out = out.replace(/`([^`]*)`/g, '$1');
			out = out.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
			out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
			out = out.replace(/^\s{0,3}>\s?/gm, '');
			out = out.replace(/^\s*[-*+]\s+/gm, '');
			out = out.replace(/^\s*\|.*\|\s*$/gm, ' ');
			out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
			out = out.replace(/__([^_]+)__/g, '$1');
			out = out.replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2');
			out = out.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
			out = out.replace(/[ \t]+/g, ' ');
			out = out.replace(/\n{3,}/g, '\n\n');
			out = out.trim();
			if (out.length > SPEAK_MAX_CHARS) out = out.slice(0, SPEAK_MAX_CHARS) + ' …';
			return out;
		}

		/**
		 * Extract the concatenated text blocks of one assembled assistant message.
		 * @param {unknown} message - an `AssistantMessage` from a durable event.
		 * @returns {string} the message's visible prose.
		 */
		function assistantText(message) {
			const content = message !== null && typeof message === 'object' ? message.content : undefined;
			if (!Array.isArray(content)) return '';
			const parts = [];
			for (const block of content) {
				if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
			}
			return parts.join('\n').trim();
		}

		// ── local wake-word engine (openWakeWord on onnxruntime-web) ─────────
		//
		// Everything below runs on this machine. Audio is captured once, scored
		// locally frame by frame, and never uploaded: the keyword models are the
		// only thing the cloud ever hears about is nothing at all. Cloud
		// recognition is started only after a detection, and is stopped again
		// once the prompt has been sent.

		/** URL prefix the host half serves wake-word assets from. */
		const WAKE_ASSET_BASE = '/voice-assets';

		/**
		 * How long a pause ends the utterance and sends it.
		 *
		 * Speech recognition finalizes on every pause, so this is what separates
		 * "the user drew breath" from "the user is done". Too short and sentences
		 * still get chopped; too long and the plugin feels unresponsive.
		 */
		const SILENCE_MS = 1800;

		/**
		 * How long an armed prompt waits for the user to say anything at all.
		 *
		 * This is a different timer from {@link SILENCE_MS}, and it exists because
		 * that one is driven by recognition results: a wake that is followed by
		 * silence produces no result at all, so nothing would ever start the
		 * countdown and the plugin would sit in "listening" forever instead of
		 * returning to wake mode.
		 */
		const EMPTY_TIMEOUT_MS = 5000;

		/**
		 * How long to wait after a turn settles before reading the reply.
		 *
		 * The session's `running` flag can drop a moment before the final
		 * `assistant/message` lands in the event window. Reading immediately returns
		 * the *previous* answer; this delay gives the message time to arrive, and the
		 * arriving call re-checks. Short enough that the reply still feels prompt.
		 */
		const SPEAK_SETTLE_MS = 350;

		/**
		 * Script URL of the ONNX Runtime browser build that sets `window.ort`.
		 *
		 * This must be the *wasm-only* build. The full build (`ort.min.js`) hard-
		 * codes the WebGPU-capable loader filename (`ort-wasm-simd-threaded.jsep
		 * .mjs`); pairing that loader with the plain `ort-wasm-simd-threaded.wasm`
		 * fails at session creation with `TypeError: c is not a function`. The
		 * wasm-only build pairs with `ort-wasm-simd-threaded.mjs`, which matches
		 * the binary this package serves.
		 */
		const WAKE_ORT_SCRIPT = WAKE_ASSET_BASE + '/ort/ort.wasm.min.js';

		/** Model files, all served from the same route. */
		const WAKE_MODELS = Object.freeze({
			melspectrogram: 'melspectrogram.onnx',
			embedding: 'embedding_model.onnx',
			vad: 'silero_vad.onnx',
			keywords: { hey_jarvis: 'hey_jarvis_v0.1.onnx' }
		});

		/** AudioWorklet source: fixed 1280-sample frames, the models' frame size. */
		const WAKE_WORKLET = `
class WakeWordTap extends AudioWorkletProcessor {
	constructor() {
		super();
		this.size = 1280;
		this.buffer = new Float32Array(this.size);
		this.pos = 0;
	}
	process(inputs) {
		const input = inputs[0] && inputs[0][0];
		if (input) {
			for (let i = 0; i < input.length; i += 1) {
				this.buffer[this.pos] = input[i];
				this.pos += 1;
				if (this.pos === this.size) {
					this.port.postMessage(this.buffer.slice(0));
					this.pos = 0;
				}
			}
		}
		return true;
	}
}
registerProcessor('dsh-wake-word-tap', WakeWordTap);
`;

		/**
		 * Wrap one ONNX Runtime output tensor as a fresh Float32Array. The runtime
		 * may hand back a view into a reused arena, so every consumer that keeps
		 * the data (the embedding history ring) must own a copy.
		 * @param session - an `ort.InferenceSession`.
		 * @param results - the run() result map.
		 * @returns the output as an independent Float32Array.
		 */
		function wakeOutput(session, results) {
			return new Float32Array(results[session.outputNames[0]].data);
		}

		/**
		 * Dedicated output context for the wake confirmation tone.
		 *
		 * It is deliberately separate from the capture context and is never closed.
		 * An earlier version borrowed the engine's context, which the wake path
		 * tears down moments later — so the scheduled tone was queued and then
		 * silenced by `close()` before it could be heard.
		 */
		let chimeContext;

		/** Create (and resume) the chime context; safe to call repeatedly. */
		function ensureChimeContext() {
			try {
				const AudioCtor = window.AudioContext ?? window.webkitAudioContext;
				if (typeof AudioCtor !== 'function') return undefined;
				if (chimeContext === undefined || chimeContext.state === 'closed') chimeContext = new AudioCtor();
				// Autoplay policy: a context created without a preceding gesture stays
				// suspended. Callers reach here from a click (arming) or from a
				// detection, so resuming usually succeeds.
				if (chimeContext.state === 'suspended') void chimeContext.resume().catch(() => {});
				return chimeContext;
			} catch {
				return undefined;
			}
		}

		/**
		 * Play a short confirmation tone.
		 *
		 * Deliberately not `speechSynthesis`: the controller already owns that
		 * channel for reading replies aloud, and a spoken confirmation would both
		 * collide with an in-flight utterance and be captured by the microphone on
		 * its way back in. A WebAudio tone is instant and cannot be mistaken for
		 * speech by the recognizer that is about to start.
		 *
		 * Three distinct patterns, because in continuous conversation the user has to
		 * tell four moments apart by ear alone: the wake word landing, the prompt
		 * being sent, and the listener giving up or coming back.
		 * @param {'wake'|'sent'|'timeout'} kind - which confirmation to play.
		 */
		function playWakeChime(kind = 'wake') {
			try {
				const ctx = ensureChimeContext();
				if (ctx === undefined) return;
				const gain = ctx.createGain();
				gain.gain.value = 0.0001;
				gain.connect(ctx.destination);
				// Schedule slightly ahead of `currentTime`: a context that just
				// resumed reports 0, and a start time already in the past is skipped.
				const start = ctx.currentTime + 0.03;
				// `wake`    rises (880 -> 1320 Hz): "I heard you, go ahead".
				// `sent`    higher, shorter double blip (1245 -> 1660 Hz): "it is on
				//           its way" — clearly not the same event as the wake word.
				// `timeout` falls (1175 -> 784 Hz): "heard nothing, standing down" —
				//           the direction is the signal, so it cannot be confused with
				//           the rising wake tone.
				// `resume`  one soft mid tone (988 Hz): "listening again". Deliberately
				//           the shortest and quietest of the four, because in continuous
				//           conversation it fires once per reply and a loud marker there
				//           becomes noise.
				const notes =
					kind === 'sent'
						? [
								{ at: start, freq: 1245, len: 0.07 },
								{ at: start + 0.09, freq: 1660, len: 0.09 }
							]
						: kind === 'timeout'
							? [
									{ at: start, freq: 1175, len: 0.09 },
									{ at: start + 0.11, freq: 784, len: 0.16 }
								]
							: kind === 'resume'
								? [{ at: start, freq: 988, len: 0.09 }]
								: [
										{ at: start, freq: 880, len: 0.11 },
										{ at: start + 0.11, freq: 1320, len: 0.15 }
									];
				const span = notes[notes.length - 1].at + notes[notes.length - 1].len - start;
				for (const note of notes) {
					const osc = ctx.createOscillator();
					osc.type = 'sine';
					osc.frequency.setValueAtTime(note.freq, note.at);
					osc.connect(gain);
					osc.start(note.at);
					osc.stop(note.at + note.len);
				}
				gain.gain.setValueAtTime(0.0001, start);
				// Two quieter variants: `sent` is a short informational blip, `resume`
				// is the quietest because it repeats every turn.
				const peak = kind === 'sent' ? 0.16 : kind === 'resume' ? 0.11 : 0.22;
				gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
				gain.gain.exponentialRampToValueAtTime(0.0001, start + span + 0.04);
			} catch {
				/* a missing confirmation tone must never break the wake path */
			}
		}

		/**
		 * Continuous on-device keyword spotting: openWakeWord's three-stage
		 * pipeline (melspectrogram -> speech embedding -> per-keyword classifier)
		 * driven by `onnxruntime-web`, gated by Silero VAD.
		 *
		 * The exact transforms below are load-bearing and were taken from the
		 * reference implementation rather than reconstructed: the mel output is
		 * rescaled with `x / 10 + 2` before it reaches the embedding model, five
		 * 32-bin frames are produced per audio frame, the embedding consumes a
		 * 76-frame sliding window, and the classifier consumes a ring of 16
		 * embeddings of 96 values. Changing any of them silently degrades the
		 * score instead of failing loudly.
		 */
		class WakeWordEngine {
			/**
			 * @param {object} [options] - engine tuning.
			 * @param {string} [options.keyword] - active keyword name.
			 * @param {number} [options.threshold] - score above which a frame counts as a detection.
			 * @param {number} [options.cooldownMs] - suppression window after a detection.
			 * @param {Function} [options.onDetect] - called with `{ keyword, score }`.
			 * @param {Function} [options.onError] - called with an Error.
			 */
			constructor(options = {}) {
				this.keyword = options.keyword ?? 'hey_jarvis';
				this.threshold = typeof options.threshold === 'number' ? options.threshold : 0.5;
				this.cooldownMs = typeof options.cooldownMs === 'number' ? options.cooldownMs : 2500;
				this.onDetect = options.onDetect ?? (() => {});
				this.onError = options.onError ?? (() => {});

				this.frameSize = 1280;
				this.sampleRate = 16000;
				this.melWindowFrames = 76;

				this.ort = undefined;
				this.models = undefined;
				this.melBuffer = [];
				this.embeddingHistory = [];
				this.vadState = { h: undefined, c: undefined };
				this.speechActive = false;
				this.vadHangover = 0;

				this.audioContext = undefined;
				this.stream = undefined;
				this.node = undefined;
				this.source = undefined;
				this.queue = Promise.resolve();
				this.coolingDown = false;
				/** Handle for the detection cooldown, cancelled by `stop()`. */
				this.cooldownTimer = undefined;
				this.listening = false;
				this.loaded = false;
				/** Gates frame scoring; cleared by `stop()` so queued frames stand down. */
				this.running = false;

				// Live diagnostics. These deliberately live outside the controller's
				// immutable snapshot: the score changes on every 80 ms frame, and
				// pushing that through the React store would re-render the tree
				// ~12 times a second. The UI polls this object instead.
				this.metrics = {
					frames: 0,
					score: 0,
					peak: 0,
					level: 0,
					speech: false,
					contextState: 'none',
					detections: 0
				};
				this.peakAt = 0;
			}

			/**
			 * Whether the APIs this engine needs exist in the current browser.
			 * @returns true when capture and worklet processing are available.
			 */
			static supported() {
				return (
					typeof window !== 'undefined' &&
					typeof window.AudioContext === 'function' &&
					typeof window.AudioWorkletNode === 'function' &&
					window.navigator !== undefined &&
					window.navigator.mediaDevices !== undefined &&
					typeof window.navigator.mediaDevices.getUserMedia === 'function'
				);
			}

			/**
			 * Inject the ONNX Runtime UMD script once and resolve `window.ort`.
			 *
			 * `numThreads = 1` is deliberate: the served WebAssembly build is the
			 * threaded one, but multi-threaded execution needs a cross-origin
			 * isolated document (COOP/COEP headers) that this host does not send.
			 * Forcing one thread keeps the runtime on the non-isolated path, where
			 * a single wasm binary is enough.
			 * @returns the ONNX Runtime namespace.
			 */
			async ensureRuntime() {
				if (this.ort !== undefined) return this.ort;
				if (window.ort === undefined) {
					await new Promise((resolveScript, rejectScript) => {
						const existing = document.querySelector('script[data-dsh-ort]');
						if (existing !== null) {
							existing.addEventListener('load', () => resolveScript());
							existing.addEventListener('error', () => rejectScript(new Error('onnxruntime script failed')));
							return;
						}
						const tag = document.createElement('script');
						tag.src = WAKE_ORT_SCRIPT;
						tag.async = true;
						tag.dataset.dshOrt = '1';
						tag.addEventListener('load', () => resolveScript());
						tag.addEventListener('error', () => rejectScript(new Error('onnxruntime script failed to load')));
						document.head.appendChild(tag);
					});
				}
				const ort = window.ort;
				if (ort === undefined) throw new Error('onnxruntime-web did not expose window.ort');
				ort.env.wasm.numThreads = 1;
				// The object form is load-bearing. With a *string* wasmPaths the
				// runtime concatenates it with its default loader filename and then
				// dynamic-imports the result ("/voice-assets/ort/" + "ort-wasm-
				// simd-threaded.jsep.mjs"), which the browser rejects as an
				// unresolvable bare specifier. Passing explicit absolute URLs for
				// both the loader and the binary skips that concatenation entirely.
				const ORT_DIR = WAKE_ASSET_BASE + '/ort/';
				ort.env.wasm.wasmPaths = {
					mjs: new URL(ORT_DIR + 'ort-wasm-simd-threaded.mjs', window.location.href).href,
					wasm: new URL(ORT_DIR + 'ort-wasm-simd-threaded.wasm', window.location.href).href
				};
				this.ort = ort;
				return ort;
			}

			/** Load every model once. Safe to call repeatedly. */
			async load() {
				if (this.loaded) return;
				const ort = await this.ensureRuntime();
				const url = (file) => WAKE_ASSET_BASE + '/' + file;
				const options = { executionProviders: ['wasm'] };
				const mel = await ort.InferenceSession.create(url(WAKE_MODELS.melspectrogram), options);
				const emb = await ort.InferenceSession.create(url(WAKE_MODELS.embedding), options);
				const vad = await ort.InferenceSession.create(url(WAKE_MODELS.vad), options);
				const kw = await ort.InferenceSession.create(url(WAKE_MODELS.keywords[this.keyword]), options);
				this.models = { mel, emb, vad, kw };
				this.reset();
				this.loaded = true;
			}

			/** Clear every per-stream buffer, including the VAD recurrent state. */
			reset() {
				this.melBuffer = [];
				this.embeddingHistory = [];
				for (let i = 0; i < 16; i += 1) this.embeddingHistory.push(new Float32Array(96).fill(0));
				const shape = [2, 1, 64];
				if (this.vadState.h === undefined) {
					this.vadState.h = new this.ort.Tensor('float32', new Float32Array(128).fill(0), shape);
					this.vadState.c = new this.ort.Tensor('float32', new Float32Array(128).fill(0), shape);
				} else {
					this.vadState.h.data.fill(0);
					this.vadState.c.data.fill(0);
				}
				this.speechActive = false;
				this.vadHangover = 0;
			}

			/** Open the microphone and begin scoring frames. */
			async start() {
				if (this.listening) return;
				await this.load();
				this.reset();
				const stream = await window.navigator.mediaDevices.getUserMedia({ audio: true });
				const audioContext = new window.AudioContext({ sampleRate: this.sampleRate });
				// Browser autoplay policy can hand back a *suspended* context when no
				// user gesture preceded this call — which is the normal case here,
				// because an armed wake listener starts during page load. A suspended
				// context produces no audio callbacks at all: the feature looks
				// healthy and silently never detects anything. Try to resume, and
				// publish the real state so the UI can say so.
				if (audioContext.state === 'suspended') {
					try {
						await audioContext.resume();
					} catch {
						/* the UI reports the state below instead of failing the arm */
					}
				}
				const source = audioContext.createMediaStreamSource(stream);
				const blob = new Blob([WAKE_WORKLET], { type: 'application/javascript' });
				const blobUrl = URL.createObjectURL(blob);
				try {
					await audioContext.audioWorklet.addModule(blobUrl);
				} finally {
					URL.revokeObjectURL(blobUrl);
				}
				const node = new window.AudioWorkletNode(audioContext, 'dsh-wake-word-tap');
				this.running = true;
				node.port.onmessage = (event) => {
					const chunk = event.data;
					if (!chunk || !this.running) return;
					this.queue = this.queue
						.then(() => this.processChunk(chunk))
						.catch((error) => this.onError(error));
				};
				source.connect(node);
				// A worklet whose output is unconnected is still pulled by the graph
				// as long as it has an input, but connecting to a zero gain keeps the
				// pull unconditional without echoing the microphone to the speakers.
				const silence = audioContext.createGain();
				silence.gain.value = 0;
				node.connect(silence);
				silence.connect(audioContext.destination);
				this.stream = stream;
				this.audioContext = audioContext;
				this.source = source;
				this.node = node;
				this.listening = true;
				this.metrics.frames = 0;
				this.metrics.peak = 0;
				this.metrics.score = 0;
				this.metrics.level = 0;
				this.metrics.speech = false;
				this.metrics.detections = 0;
				this.metrics.contextState = audioContext.state;
				this.peakAt = 0;
			}

			/** Close the microphone and release every audio object. */
			async stop() {
				// Stop feeding the models *before* tearing anything down. Frames
				// already queued in the promise chain would otherwise finish
				// inferring after this returns, and a residual frame scoring above
				// threshold would fire `onDetect` and reopen a cloud session (and the
				// microphone) moments after the user disabled wake.
				this.running = false;
				if (this.node !== undefined) {
					this.node.port.onmessage = null;
					try {
						this.node.disconnect();
					} catch {
						/* already detached */
					}
					this.node = undefined;
				}
				if (this.source !== undefined) {
					try {
						this.source.disconnect();
					} catch {
						/* already detached */
					}
					this.source = undefined;
				}
				// Release the microphone FIRST, and unconditionally. `close()` can be
				// slow or stay pending on a suspended context, and stopping the tracks
				// afterwards would then be skipped — the OS recording indicator would
				// stay lit for the life of the tab.
				if (this.stream !== undefined) {
					for (const track of this.stream.getTracks()) {
						try {
							track.stop();
						} catch {
							/* already ended */
						}
					}
					this.stream = undefined;
				}
				if (this.audioContext !== undefined && this.audioContext.state !== 'closed') {
					try {
						await this.audioContext.close();
					} catch {
						/* already closing */
					}
				}
				this.audioContext = undefined;
				this.listening = false;
				this.coolingDown = false;
				if (this.cooldownTimer !== undefined) {
					window.clearTimeout(this.cooldownTimer);
					this.cooldownTimer = undefined;
				}
			}

			/**
			 * Score one 1280-sample frame: VAD first, then the model chain.
			 * @param {Float32Array} chunk - one audio frame.
			 */
			async processChunk(chunk) {
				// A frame that was queued before `stop()` must not be scored.
				if (!this.running) return;
				// Input level, sampled every 8th value — enough for a meter, cheap
				// enough to run unconditionally on every frame.
				let sumSquares = 0;
				let sampled = 0;
				for (let i = 0; i < chunk.length; i += 8) {
					sumSquares += chunk[i] * chunk[i];
					sampled += 1;
				}
				const rms = sampled > 0 ? Math.sqrt(sumSquares / sampled) : 0;
				// Light smoothing keeps the bar readable instead of flickering.
				this.metrics.level = this.metrics.level * 0.7 + Math.min(1, rms * 4) * 0.3;
				this.metrics.frames += 1;

				const speech = await this.runVad(chunk);
				if (speech) {
					this.speechActive = true;
					this.vadHangover = 12;
				} else if (this.speechActive) {
					this.vadHangover -= 1;
					if (this.vadHangover <= 0) this.speechActive = false;
				}
				this.metrics.speech = this.speechActive;
				if (this.audioContext !== undefined) this.metrics.contextState = this.audioContext.state;
				await this.runModels(chunk, this.speechActive);
			}

			/**
			 * Silero VAD step; false on any failure so scoring simply continues.
			 * @param {Float32Array} chunk - one audio frame.
			 * @returns whether the frame contains speech.
			 */
			async runVad(chunk) {
				try {
					const ort = this.ort;
					const input = new ort.Tensor('float32', chunk, [1, chunk.length]);
					const sr = new ort.Tensor('int64', [BigInt(this.sampleRate)], []);
					const out = await this.models.vad.run({ input, sr, h: this.vadState.h, c: this.vadState.c });
					this.vadState.h = out.hn;
					this.vadState.c = out.cn;
					return out.output.data[0] > 0.5;
				} catch (error) {
					this.onError(error);
					return false;
				}
			}

			/**
			 * The mel -> embedding -> classifier chain, plus the detection rule.
			 * @param {Float32Array} chunk - one audio frame.
			 * @param {boolean} speechActive - whether VAD currently considers speech present.
			 */
			async runModels(chunk, speechActive) {
				const ort = this.ort;
				const melTensor = new ort.Tensor('float32', chunk, [1, this.frameSize]);
				const melOut = await this.models.mel.run({ [this.models.mel.inputNames[0]]: melTensor });
				const mel = new Float32Array(melOut[this.models.mel.outputNames[0]].data);
				for (let i = 0; i < mel.length; i += 1) mel[i] = mel[i] / 10 + 2;
				for (let f = 0; f < 5; f += 1) this.melBuffer.push(mel.subarray(f * 32, (f + 1) * 32).slice());

				while (this.melBuffer.length >= this.melWindowFrames) {
					const flatMel = new Float32Array(this.melWindowFrames * 32);
					for (let f = 0; f < this.melWindowFrames; f += 1) flatMel.set(this.melBuffer[f], f * 32);
					const embTensor = new ort.Tensor('float32', flatMel, [1, this.melWindowFrames, 32, 1]);
					const embOut = await this.models.emb.run({ [this.models.emb.inputNames[0]]: embTensor });
					const embedding = wakeOutput(this.models.emb, embOut);

					this.embeddingHistory.shift();
					this.embeddingHistory.push(embedding);
					const flatEmb = new Float32Array(this.embeddingHistory.length * 96);
					for (let i = 0; i < this.embeddingHistory.length; i += 1) flatEmb.set(this.embeddingHistory[i], i * 96);
					const kwTensor = new ort.Tensor('float32', flatEmb, [1, this.embeddingHistory.length, 96]);
					const kwOut = await this.models.kw.run({ [this.models.kw.inputNames[0]]: kwTensor });
					const score = kwOut[this.models.kw.outputNames[0]].data[0];
					this.publishScore(score);

					if (score > this.threshold && speechActive && !this.coolingDown && this.running) {
						this.coolingDown = true;
						this.metrics.detections += 1;
						const keyword = this.keyword;
						// Tracked so `stop()` can cancel it: an un-cleared timer from a
						// previous stream would end the *next* session's cooldown early.
						if (this.cooldownTimer !== undefined) window.clearTimeout(this.cooldownTimer);
						this.cooldownTimer = window.setTimeout(() => {
							this.cooldownTimer = undefined;
							this.coolingDown = false;
						}, this.cooldownMs);
						try {
							this.onDetect({ keyword, score });
						} catch (error) {
							this.onError(error);
						}
					}
					this.melBuffer.splice(0, 8);
				}
			}

			/**
			 * Record one classifier score for the live meter.
			 *
			 * `peak` is a decaying maximum rather than a running maximum: a single
			 * 0.98 frame would otherwise pin the bar forever and hide how the score
			 * behaves while the user speaks.
			 * @param {number} score - the classifier output for this frame.
			 */
			publishScore(score) {
				this.metrics.score = score;
				const now = Date.now();
				if (score >= this.metrics.peak || now - this.peakAt > 3000) {
					this.metrics.peak = score;
					this.peakAt = now;
				}
			}
		}

		// ── the voice controller ─────────────────────────────────────────────
		const EMPTY_STATE = Object.freeze({
			recognitionSupported: false,
			synthesisSupported: false,
			listening: false,
			interim: '',
			transcript: '',
			autoSpeak: true,
			language: 'zh-CN',
			voiceURI: '',
			voices: [],
			speaking: false,
			error: '',
			sessionId: undefined,
			lastAssistantText: '',
			sending: false,
			// ── local wake word ──
			wakeEnabled: false,
			wakeSupported: false,
			wakeReady: false,
			wakeListening: false,
			/** Whether capture is genuinely running right now. The UI reads this. */
			wakeArmed: false,
			/** A wake-opened turn still owes the microphone back to the listener. */
			wakePending: false,
			wakeThreshold: 0.5,
			wakeKeyword: 'hey_jarvis',
			lastWakeAt: 0,
			wakeError: '',
			mode: 'idle'
		});

		/**
		 * The whole browser-side voice feature: Web Speech recognition driving
		 * `session.prompt`, and Web Speech synthesis driven by settled assistant
		 * messages of the selected session.
		 *
		 * State is one immutable snapshot exposed through `subscribe`/`getSnapshot`
		 * so any number of React consumers can bind it with `useSyncExternalStore`.
		 */
		class VoiceController {
			/**
			 * @param {object} ctx - the client root context.
			 */
			constructor(ctx) {
				this.ctx = ctx;
				this.listeners = new Set();
				this.state = EMPTY_STATE;
				this.recognition = undefined;
				this.recognitionStarting = false;
				this.disposers = [];
				this.boundSessionId = undefined;
				this.sessionUnsubscribe = undefined;
				this.sessionListener = undefined;
				this.wasRunning = false;
				this.historyLoaded = false;
				this.lastTurnEndAt = 0;
				this.lastSpokenText = '';
				/**
				 * Highest assistant turn observed while the session was busy. Used to
				 * reject a stale reply: `running` can fall to false before the final
				 * `assistant/message` reaches the event window, and reading whichever
				 * text is newest at that instant returns the previous answer.
				 */
				this.speakingTurn = 0;
				/** Pending short delay that lets the final message land before reading. */
				this.settleTimer = undefined;
				this.wakeEngine = undefined;
				this.wakeStarting = false;
				/**
				 * Identity of the utterance synthesis is currently playing. A terminal
				 * event from a cancelled utterance carries the previous value and is
				 * ignored, so a still-audible reply is not reported as finished.
				 */
				this.speechToken = 0;
				/** Finalized text held back until the user stops speaking. */
				this.pendingFinal = '';
				/** Pending silence countdown that decides the utterance is over. */
				this.silenceTimer = undefined;
				/** Countdown for "woke up but nothing was said" (see EMPTY_TIMEOUT_MS). */
				this.emptyTimer = undefined;
				/**
				 * Absolute end of the nothing-said window. Unlike the timer above this
				 * is never pushed back, so ambient noise cannot hold the session open.
				 */
				this.emptyDeadline = undefined;
				/** When the current `start()` was issued, used to expire a stuck flag. */
				this.recognitionStartedAt = 0;
				/** Set by `dispose`; parked timers and callbacks check it before acting. */
				this.disposed = false;
				/**
				 * Bumped whenever the wake listener is cancelled. An in-flight
				 * `armWake` compares its captured generation after every await and
				 * abandons its work when they differ, so a switch flipped off during
				 * the model load cannot end with the microphone open.
				 */
				this.wakeGeneration = 0;
				/** Bounded retry budget for an outstanding wake hand-back. */
				this.wakeRetries = 0;
				this.wakeRetryTimer = undefined;
				/**
				 * How the current recognition session started. True when a wake word
				 * opened it, false when the user clicked the microphone. Every
				 * "should the wake listener come back?" decision reads this.
				 */
				this.sessionFromWake = false;
				const prefs = readPreferences();
				this.patch({
					autoSpeak: prefs.autoSpeak !== false,
					language: typeof prefs.language === 'string' ? prefs.language : 'zh-CN',
					voiceURI: typeof prefs.voiceURI === 'string' ? prefs.voiceURI : '',
					wakeEnabled: prefs.wakeEnabled === true,
					wakeThreshold:
						typeof prefs.wakeThreshold === 'number' && prefs.wakeThreshold >= 0.05 && prefs.wakeThreshold <= 0.99
							? prefs.wakeThreshold
							: 0.5
				});
			}

			/** Merge a partial state patch and notify every subscriber. */
			patch(partial) {
				const next = { ...this.state, ...partial };
				let changed = false;
				for (const key of Object.keys(next)) {
					if (next[key] !== this.state[key]) {
						changed = true;
						break;
					}
				}
				if (!changed) return;
				this.state = next;
				for (const listener of [...this.listeners]) {
					try {
						listener();
					} catch (error) {
						this.ctx.logger?.warn?.('voice: a subscriber threw', error);
					}
				}
			}

			/** uSES read face. */
			getSnapshot() {
				return this.state;
			}

			/** uSES subscribe face. @returns the unsubscribe function. */
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}

			/** Wire capability probes, the sessions list, and voice enumeration. */
			start() {
				const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
				const synthesis = window.speechSynthesis;
				this.patch({
					recognitionSupported: typeof Recognition === 'function',
					synthesisSupported: synthesis !== undefined && synthesis !== null,
					wakeSupported: WakeWordEngine.supported()
				});
				// Restore an armed wake listener across reloads. Failures are
				// contained: a browser that refuses autoplay or microphone access
				// must not take the rest of the voice feature down with it.
				if (this.state.wakeEnabled && this.state.wakeSupported) {
					void this.armWake().catch((error) => {
						this.patch({
							wakeEnabled: false,
							wakeListening: false,
							wakeError: '本地唤醒启动失败：' + String(error?.message ?? error)
						});
					});
				}
				if (typeof Recognition === 'function') {
					this.recognition = new Recognition();
					this.recognition.continuous = true;
					this.recognition.interimResults = true;
					this.recognition.maxAlternatives = 1;
					this.recognition.lang = this.state.language;
					this.recognition.onstart = () => {
						this.recognitionStarting = false;
						this.patch({ listening: true, error: '' });
					};
					this.recognition.onresult = (event) => {
						// Ambient noise produces results with no user speech, so the
						// nothing-said window is capped by a deadline that noise cannot
						// postpone. Checked before the timer is cleared below.
						if (this.emptyDeadline !== undefined && Date.now() > this.emptyDeadline) {
							this.emptyDeadline = undefined;
							void this.onNothingSaid();
							return;
						}
						// Real input arrived, so the countdown is moot; the silence
						// countdown below takes over from here.
						this.clearEmptyTimer();
						let interim = '';
						let final = '';
						for (let index = event.resultIndex; index < event.results.length; index += 1) {
							const result = event.results[index];
							const text = result[0]?.transcript ?? '';
							if (result.isFinal) final += text;
							else interim += text;
						}
						if (final !== '') {
							// Accumulate instead of sending. `continuous = true` makes the
							// browser finalize on every pause, so submitting each final
							// ships one sentence as several separate prompts.
							this.pendingFinal = (this.pendingFinal + final).slice(-4000);
							this.touchSilenceTimer();
							// Keep the whole utterance on screen: the display is the only
							// place the user can see what is about to be sent.
							this.patch({ interim: '', transcript: this.pendingFinal.trim() });
						} else if (interim !== '') {
							this.patch({ interim });
							this.touchSilenceTimer();
						}
					};
					this.recognition.onerror = (event) => {
						this.recognitionStarting = false;
						this.patch({ listening: false, interim: '' });
						if (event.error === 'aborted' || event.error === 'no-speech') return;
						this.patch({ error: this.describeRecognitionError(event.error) });
					};
					this.recognition.onend = () => {
						this.handleRecognitionEnd()
					};
				}
				if (this.state.synthesisSupported) {
					const loadVoices = () => {
						const voices = synthesis.getVoices();
						if (voices.length === 0) return;
						this.patch({
							voices: voices.map((voice) => ({
								uri: voice.voiceURI,
								name: voice.name,
								lang: voice.lang,
								// Kept so the inventory can tell a locally installed voice
								// from a cloud-backed one: an "Online (Natural)" entry is
								// synthesised server-side, which is exactly the distinction
								// the natural-voice work needs to see.
								local: voice.localService === true,
								// Chromium exposes this for its own voice set; absent
								// elsewhere, so it is informational only.
								default: voice.default === true
							}))
						});
					};
					loadVoices();
					if (typeof synthesis.addEventListener === 'function') synthesis.addEventListener('voiceschanged', loadVoices);
					else synthesis.onvoiceschanged = loadVoices;
					this.disposers.push(() => {
						if (typeof synthesis.removeEventListener === 'function') synthesis.removeEventListener('voiceschanged', loadVoices);
						else synthesis.onvoiceschanged = null;
					});
				}
				const list = this.ctx.sessions?.list;
				if (list !== undefined) {
					const sync = () => {
						const current = list.getSnapshot().current;
						if (current !== this.boundSessionId) this.bindSession(current);
					};
					this.disposers.push(list.subscribe(sync));
					sync();
				}
				if (typeof window !== 'undefined') {
					const onUnload = () => this.stopSpeaking();
					window.addEventListener('pagehide', onUnload);
					this.disposers.push(() => window.removeEventListener('pagehide', onUnload));
				}
			}

			/** Release every registration this controller owns. */
			dispose() {
				this.disposed = true;
				this.stopListening();
				this.stopSpeaking();
				// Belt and braces: `stopListening` clears these today, but teardown
				// must not depend on that staying true — a surviving timer would fire
				// into a disposed controller.
				this.clearSilenceTimer();
				this.clearEmptyTimer();
				// A pending reply read would otherwise fire into a disposed controller.
				if (this.settleTimer !== undefined) {
					window.clearTimeout(this.settleTimer);
					this.settleTimer = undefined;
				}
				// Release the microphone: an armed wake listener holds a live
				// capture stream, and a plugin swap must not leave the OS
				// recording indicator on.
				void this.disarmWake();
				if (this.sessionUnsubscribe !== undefined) this.sessionUnsubscribe();
				this.sessionUnsubscribe = undefined;
				for (const dispose of this.disposers.splice(0)) {
					try {
						dispose();
					} catch {
						/* a teardown failure must not mask the rest */
					}
				}
				this.listeners.clear();
			}

			/** Map a SpeechRecognition error code onto an actionable sentence. */
			describeRecognitionError(code) {
				switch (code) {
					case 'not-allowed':
					case 'service-not-allowed':
						return '麦克风权限被拒绝：请在浏览器地址栏允许本站使用麦克风。';
					case 'audio-capture':
						return '没有检测到可用的麦克风设备。';
					case 'network':
						return '语音识别需要联网（浏览器原生识别依赖云端服务）。';
					default:
						return '语音识别出错：' + String(code);
				}
			}

			// ── recognition ──────────────────────────────────────────────────
			/** Toggle microphone capture. Stopping sends what was already heard. */
			toggleListening() {
				// `recognitionStarting` is true between `start()` and the browser's
				// `onstart`, so `state.listening` is still false during that window and
				// a cancel click would otherwise fall into the start branch and be
				// swallowed by that branch's own guard. Clicking twice must always
				// end stopped, whatever the recognizer is doing.
				if (this.state.listening) this.stopListening(true);
				else if (this.recognitionStarting) this.cancelListening();
				else this.startListening();
			}

			/**
			 * Abandon an in-flight or just-opened session without sending anything.
			 *
			 * Used for the cancel gesture. `abort()` (not `stop()`) is the right call
			 * here: it discards pending audio instead of trying to finalize it, and
			 * it fires `onend` synchronously so the button cannot stay stuck in the
			 * listening state waiting for an event that may never come.
			 */
			cancelListening() {
				this.recognitionStarting = false;
				this.clearSilenceTimer();
				this.clearEmptyTimer();
				this.pendingFinal = '';
				const recognition = this.recognition;
				if (recognition !== undefined) {
					try {
						if (typeof recognition.abort === 'function') recognition.abort();
						else recognition.stop();
					} catch {
						/* already stopped */
					}
				}
				// Patch directly rather than relying on `onend`: the UI must reflect
				// the cancel immediately.
				this.patch({ listening: false, interim: '' });
				this.syncWakeArmed();
			}

			/**
			 * Begin one recognition session.
			 * @param {boolean} [fromWake] - true when a wake word opened this session
			 *   rather than a click on the microphone button.
			 */
			startListening(fromWake = false) {
				if (this.recognition === undefined) return;
				// Self-heal a stuck flag: it is only cleared by the browser's
				// `onstart`, so a recognizer that never reports it would otherwise
				// block every future start for the rest of the session.
				if (this.recognitionStarting) {
					if (Date.now() - this.recognitionStartedAt < 3000) return;
					this.recognitionStarting = false;
				}
				this.stopSpeaking();
				// A fresh session owns a fresh buffer: leftovers from a previous
				// utterance must not be prepended to this one.
				this.clearSilenceTimer();
				this.clearEmptyTimer();
				this.pendingFinal = '';
				this.patch({ error: '', interim: '', transcript: '' });
				this.recognition.lang = this.state.language;
				try {
					this.recognition.start();
					this.recognitionStarting = true;
					this.recognitionStartedAt = Date.now();
					// Cloud recognition just took the microphone, so the wake listener
					// (if any) is no longer armed. Publish that immediately.
					this.syncWakeArmed();
					// Continuous-wake *mode*: a wake word turns it on and it stays on
					// across replies. A manual click turns it off, because that is the
					// user asking for a deliberate one-shot session rather than the
					// hands-free loop.
					this.sessionFromWake = fromWake === true;
					this.patch({ wakePending: this.wakeHandbackPending() });
					// Both entry points get the same window to start speaking. Without
					// this, a session opened by a click and then abandoned sits on the
					// microphone until the button is pressed again, which is exactly
					// the dead end the wake path already had to be rescued from.
					this.emptyTimer = window.setTimeout(() => {
						this.emptyTimer = undefined;
						void this.onNothingSaid();
					}, EMPTY_TIMEOUT_MS);
					// Hard deadline for the same window. Ambient noise makes the
					// recognizer emit interim results without the user saying anything,
					// and each result cancels the timer above — so without this, a noisy
					// room pins the session open indefinitely. The deadline is never
					// extended once armed.
					this.emptyDeadline = Date.now() + EMPTY_TIMEOUT_MS;
				} catch (error) {
					this.recognitionStarting = false;
					this.patch({ error: '无法启动语音识别：' + String(error?.message ?? error) });
				}
			}

			/**
			 * The single funnel for "the recognizer stopped, whatever the reason".
			 *
			 * The browser ends recognition on its own for reasons the plugin does not
			 * control — its own no-speech timeout, a network hiccup — and it does so
			 * on a schedule that can be shorter than the plugin's own window. Every
			 * other exit path (silence flush, empty timeout, user cancel) hands the
			 * microphone back; without this funnel that one leaves the plugin in a
			 * state where nothing is listening and nothing is armed either.
			 *
			 * The short delay exists because `onend` can fire while the browser is
			 * still tearing the session down; grabbing the microphone on the same
			 * tick makes `getUserMedia` fail on some builds.
			 */
			handleRecognitionEnd() {
				if (this.disposed) return;
				this.recognitionStarting = false;
				this.clearEmptyTimer();
				if (this.state.listening) this.patch({ listening: false });
				this.syncWakeArmed();
				// A stopped session with unsent speech is still worth sending: the
				// browser can end a session right after finalizing a phrase.
				const pending = (this.pendingFinal ?? '').trim();
				if (pending !== '') {
					void this.flushPendingTranscript();
					return;
				}
				if (this.sessionFromWake !== true) return;
				if (!this.state.wakeEnabled) return;
				if (this.state.wakeListening || this.wakeStarting) return;
				window.setTimeout(() => {
					void this.armWakeIfIdle('识别结束后恢复本地唤醒');
				}, 250);
			}

			/** Cancel the "nothing said" countdown and its hard deadline. */
			clearEmptyTimer() {
				if (this.emptyTimer !== undefined) {
					window.clearTimeout(this.emptyTimer);
					this.emptyTimer = undefined;
				}
				this.emptyDeadline = undefined;
			}

			/**
			 * Nothing was said within the window: tell the user by ear, then release
			 * the microphone rather than leaving the session pinned open.
			 *
			 * Reached from both entry points — a wake that was followed by silence,
			 * and a microphone button that was clicked and then abandoned.
			 */
			async onNothingSaid() {
				if (this.disposed) return;
				// A result landed between the timer firing and this running.
				if (this.pendingFinal !== '' || this.state.interim !== '') return;
				// Only chime when the wake feature is in play: a user who never
				// enabled it should not hear a tone they never opted into.
				if (this.state.wakeEnabled) playWakeChime('timeout');
				// Suppression is derived inside `stopListening` from how the session
				// started, so nothing extra is needed here: the re-arm below is only
				// skipped for user-initiated stops.
				this.stopListening();
				await this.armWakeIfIdle('超时后恢复本地唤醒');
			}

			/**
			 * Restart the silence countdown after a recognition result.
			 *
			 * Speech recognition with `continuous = true` finalizes on every pause,
			 * so "send on final" chops one utterance into several prompts. Instead
			 * the utterance is held until the user stops talking; this timer is what
			 * decides that they have.
			 */
			touchSilenceTimer() {
				if (this.silenceTimer !== undefined) window.clearTimeout(this.silenceTimer);
				this.silenceTimer = window.setTimeout(() => {
					this.silenceTimer = undefined;
					void this.flushPendingTranscript();
				}, SILENCE_MS);
			}

			/** Cancel a pending silence flush. */
			clearSilenceTimer() {
				if (this.silenceTimer !== undefined) {
					window.clearTimeout(this.silenceTimer);
					this.silenceTimer = undefined;
				}
			}

			/**
			 * Send whatever has been recognized so far.
			 *
			 * Reached two ways: the silence timer fired, or the user stopped the
			 * microphone themselves — in which case waiting another 1.8 s would feel
			 * broken, so stopping sends immediately.
			 * @returns whether anything was submitted.
			 */
			async flushPendingTranscript() {
				this.clearSilenceTimer();
				const text = (this.pendingFinal ?? '').trim();
				this.pendingFinal = '';
				if (text === '') {
					// Nothing to send, but capture must still be torn down. Returning
					// early here used to leave the recognizer running with the UI
					// showing idle, so the user's *next* utterance was silently
					// accumulated and then sent as a prompt they never intended to
					// send.
					if (this.state.listening) this.stopListening();
					return false;
				}
				// Stop capture first: the next `startListening` reopens it, and leaving
				// the recognizer running through the send would keep appending to a
				// buffer that has already been shipped.
				this.stopListening();
				await this.acceptTranscript(text);
				return true;
			}

			/**
			 * End microphone capture.
			 *
			 * Whether this hands the microphone back to the wake listener is derived
			 * from how the session started, not from a caller-supplied flag:
			 *  - a wake-word session always returns to wake mode, because the
			 *    conversation is continuous and the user must be able to speak again;
			 *  - a session the user opened by clicking the microphone stays stopped,
			 *    because bouncing straight back would read as the button being
			 *    ignored.
			 * @param {boolean} [flush] - submit what was heard before stopping.
			 */
			stopListening(flush = false) {
				this.recognitionStarting = false;
				this.clearEmptyTimer();
				// The `onend` that follows this stop reads the same fact, so it is left
				// in place here and consumed by whichever path re-arms.
				// Patch immediately instead of waiting for `onend`: a cancel gesture
				// that appears to do nothing until the browser gets around to firing an
				// event reads as a dead button.
				this.patch({ listening: false, interim: '' });
				this.syncWakeArmed();
				if (flush) {
					// Send on stop so a click does not silently drop the sentence.
					void this.flushPendingTranscript();
					return;
				}
				this.clearSilenceTimer();
				this.pendingFinal = '';
				if (this.recognition === undefined) return;
				try {
					this.recognition.stop();
				} catch {
					/* already stopped */
				}
			}

			/**
			 * Send one recognized utterance as the session's next queued prompt.
			 * @param {string} text - the finalized transcript.
			 */
			async acceptTranscript(text) {
				if (text === '') return;
				const sessionId = this.state.sessionId;
				if (sessionId === undefined) {
					this.patch({ error: '当前没有选中的会话，无法发送语音消息。' });
					return;
				}
				const binding = this.ctx.sessions.binding(sessionId);
				const session = binding?.session;
				if (session === undefined) {
					this.patch({ error: '会话绑定不可用，无法发送语音消息。' });
					return;
				}
				this.patch({ transcript: text, sending: true, error: '' });
				let accepted = false;
				try {
					const result = await session.prompt([{ type: 'text', text }], 'queue');
					if (result !== undefined && result.ok === false) {
						this.patch({ error: '发送失败：' + String(result.error?.message ?? result.error?.code ?? '未知错误') });
					} else {
						accepted = true;
					}
				} catch (error) {
					this.patch({ error: '发送失败：' + String(error?.message ?? error) });
				} finally {
					// A send that outlives the plugin must not touch state or reopen the
					// microphone through the re-arm below.
					if (this.disposed) return;
					this.patch({ sending: false });
					// Distinguish "sent" from "woke up" by ear: in continuous
					// conversation the user needs to know the message is away before
					// deciding whether to interrupt the reply.
					if (accepted) playWakeChime('sent');
					// Continuous conversation: once the prompt is away, go straight
					// back to waiting for the wake word instead of stranding the user
					// with no way to speak again.
					void this.armWakeIfIdle('发送后恢复本地唤醒');
				}
			}

			// ── synthesis ────────────────────────────────────────────────────
			/** Choose the SpeechSynthesisVoice for the current language and override. */
			selectVoice() {
				const synthesis = window.speechSynthesis;
				if (synthesis === undefined || synthesis === null) return undefined;
				const voices = synthesis.getVoices();
				if (voices.length === 0) return undefined;
				if (this.state.voiceURI !== '') {
					const picked = voices.find((voice) => voice.voiceURI === this.state.voiceURI);
					if (picked !== undefined) return picked;
				}
				const target = this.state.language.toLowerCase();
				const exact = voices.find((voice) => voice.lang.toLowerCase().replace('_', '-') === target);
				if (exact !== undefined) return exact;
				const prefix = target.split('-')[0];
				const sameFamily = voices.filter((voice) => voice.lang.toLowerCase().startsWith(prefix));
				if (sameFamily.length === 0) return undefined;
				const local = sameFamily.find((voice) => voice.localService === true);
				return local ?? sameFamily[0];
			}

			/**
			 * Speak text, replacing any utterance already in flight.
			 * @param {string} text - raw text; markdown is stripped before speaking.
			 */
			speak(text) {
				const speakable = toSpeakable(text);
				if (speakable === '' || !this.state.synthesisSupported) return;
				const synthesis = window.speechSynthesis;
				// `cancel()` below ends any utterance in flight, and its terminal event
				// is delivered *after* the new one is installed. Without an identity
				// check that stale event would clear `speaking` while audio is still
				// audible — and, worse, release the self-trigger guard that keeps the
				// microphone out of the assistant's own voice.
				const token = (this.speechToken ?? 0) + 1;
				this.speechToken = token;
				const current = () => this.speechToken === token && !this.disposed;
				try {
					synthesis.cancel();
					const utterance = new SpeechSynthesisUtterance(speakable);
					const voice = this.selectVoice();
					if (voice !== undefined) utterance.voice = voice;
					utterance.lang = voice?.lang ?? this.state.language;
					utterance.rate = 1;
					utterance.pitch = 1;
					utterance.onstart = () => {
						// The wake listener may have been re-armed between sending a
						// prompt and this reply arriving (continuous conversation), so
						// take the microphone away unconditionally: scoring the
						// assistant's own voice risks a self-trigger. `onend` re-arms.
						if (!current()) return;
						if (this.state.wakeListening) void this.disarmWake();
						this.patch({ speaking: true });
					};
					utterance.onend = () => {
						if (!current()) return;
						this.patch({ speaking: false });
						this.resumeWakeAfterSpeech();
					};
					utterance.onerror = () => {
						if (!current()) return;
						this.patch({ speaking: false });
						this.resumeWakeAfterSpeech();
					};
					synthesis.speak(utterance);
				} catch (error) {
					if (current()) this.patch({ error: '朗读失败：' + String(error?.message ?? error), speaking: false });
				}
			}

			/** Stop any utterance in flight, whether from a bang or a user gesture. */
			stopSpeaking() {
				const synthesis = window.speechSynthesis;
				if (synthesis === undefined || synthesis === null) return;
				try {
					synthesis.cancel();
				} catch {
					/* nothing to cancel */
				}
				if (this.state.speaking) this.patch({ speaking: false });
			}

			/** Replay the most recent assistant message of the selected session. */
			replay() {
				const text = this.state.lastAssistantText;
				if (text === '') {
					this.patch({ error: '当前会话还没有可朗读的回复。' });
					return;
				}
				this.speak(text);
			}

			// ── wake word ────────────────────────────────────────────────────
			/**
			 * Arm or disarm continuous on-device keyword spotting.
			 *
			 * The wake listener owns the microphone, so arming means the browser
			 * shows a recording indicator for as long as it stays armed. Audio is
			 * scored locally and discarded; nothing is uploaded until a detection
			 * starts a real recognition session.
			 * @param {boolean} value - the requested armed state.
			 */
			async setWakeEnabled(value) {
				const enabled = value === true;
				this.patch({ wakeEnabled: enabled, wakeError: '' });
				this.persist();
				if (!enabled) {
					await this.disarmWake();
					return;
				}
				try {
					await this.armWake();
				} catch (error) {
					this.patch({
						wakeEnabled: false,
						wakeReady: false,
						wakeListening: false,
						mode: 'idle',
						wakeError: '本地唤醒启动失败：' + String(error?.message ?? error)
					});
					return;
				}
				// Arming must never race an already-open cloud session.
				if (this.state.listening) await this.disarmWake();
			}

			/**
			 * Publish whether the wake listener actually holds the microphone.
			 *
			 * `wakeListening` tracked intent and lagged reality: `startListening`
			 * takes the microphone away without touching it, so the settings page, the
			 * status strip and the wake dot could all claim "monitoring" while capture
			 * was off — and the reverse after a missed re-arm. This field is written
			 * on every transition that changes who owns the microphone, and the UI
			 * reads only this.
			 */
			syncWakeArmed() {
				this.patch({ wakeArmed: this.wakeEngine?.running === true });
			}

			/**
			 * Build the engine on first use, then start capture.
			 *
			 * Capture always restarts, even when the engine is cached: a stream
			 * closed by {@link disarmWake} cannot be resumed, only reopened.
			 *
			 * Every suspension point re-checks {@link wakeGeneration}. Loading four
			 * models over the network takes seconds, and during that window the user
			 * can switch the feature off or the plugin can be torn down; without the
			 * re-check the continuation would open the microphone afterwards, leaving
			 * capture running while the switch reads off and no UI reflects it.
			 */
			async armWake() {
				if (this.state.wakeListening || this.wakeStarting) return;
				if (this.disposed) return;
				if (!WakeWordEngine.supported()) {
					throw new Error('当前浏览器不支持 AudioWorklet 或麦克风采集');
				}
				// A wake listener is only useful if a detection can hand the microphone
				// to cloud recognition. Without it, arming is a one-way trap: the
				// listener is disarmed on detection and nothing can re-arm it.
				if (typeof window.SpeechRecognition !== 'function' && typeof window.webkitSpeechRecognition !== 'function') {
					throw new Error('当前浏览器不支持语音识别，本地唤醒无法联动');
				}
				const generation = this.wakeGeneration;
				const stale = () => this.disposed || this.wakeGeneration !== generation;
				this.wakeStarting = true;
				try {
					// Build the confirmation-tone context here, while the caller still
					// holds the user gesture that armed wake (a click on the switch).
					// Creating it later, from a detection path, would be subject to the
					// autoplay policy and could stay suspended — a silent chime.
					ensureChimeContext();
					if (this.wakeEngine === undefined) {
						this.wakeEngine = new WakeWordEngine({
							keyword: this.state.wakeKeyword,
							threshold: this.state.wakeThreshold,
							onDetect: (event) => this.onWakeDetected(event),
							onError: (error) => this.ctx.logger?.warn?.('voice: wake engine error', error)
						});
					} else {
						this.wakeEngine.threshold = this.state.wakeThreshold;
						this.wakeEngine.keyword = this.state.wakeKeyword;
					}
					// Loading the runtime and the four models takes a moment on a cold
					// cache; surface readiness so the UI can show progress.
					await this.wakeEngine.load();
					if (stale()) return;
					this.patch({ wakeReady: true });
					await this.wakeEngine.start();
					if (stale()) {
						// Capture opened for a state that no longer wants it.
						await this.wakeEngine.stop();
						return;
					}
					this.patch({ wakeListening: true, mode: 'wake' });
					this.syncWakeArmed();
				} finally {
					this.wakeStarting = false;
				}
			}

			/** Stop capture and release the microphone. The loaded models stay cached. */
			async disarmWake() {
				// Invalidate any in-flight `armWake` first: it clears `wakeStarting`
				// below, which used to be the only in-flight guard and was therefore
				// erased by the very call that should have cancelled the arm.
				this.wakeGeneration += 1;
				this.wakeStarting = false;
				if (this.wakeRetryTimer !== undefined) {
					window.clearTimeout(this.wakeRetryTimer);
					this.wakeRetryTimer = undefined;
				}
				if (this.wakeEngine !== undefined) {
					try {
						await this.wakeEngine.stop();
					} catch (error) {
						this.ctx.logger?.warn?.('voice: wake engine stop failed', error);
					}
				}
				this.patch({ wakeListening: false, mode: 'idle' });
				this.syncWakeArmed();
			}

			/**
			 * Hand the microphone from the local listener to cloud recognition.
			 *
			 * Both consumers need the microphone and they cannot share it, so this
			 * stops the wake listener first. That ordering is the whole reason this
			 * method exists rather than calling `startListening` directly.
			 */
			async activateFromWake() {
				// A cloud session already owns the microphone — most often because the
				// user is dictating after clicking the button, and the wake engine
				// (which is the only path that never disarms itself) scored a false
				// positive on that same audio. Tearing the session down here would
				// discard the sentence they are still speaking, so the existing session
				// simply inherits the turn.
				if (this.state.listening || this.recognitionStarting) {
					this.sessionFromWake = true;
					return;
				}
				if (this.state.wakeListening) await this.disarmWake();
				// `fromWake` arms the nothing-said timeout: if the user never speaks,
				// the microphone has to come back to the wake listener on its own.
				this.startListening(true);
			}

			/** A local detection: chime, then leave wake mode and capture the prompt. */
			onWakeDetected(event) {
				// The engine can only score while capture is running, but a queued
				// frame may surface here after the feature was switched off; acting on
				// it would start cloud recognition for a disabled feature.
				if (this.disposed || !this.state.wakeEnabled) return;
				this.patch({ lastWakeAt: Date.now() });
				// Chime first. It uses its own output context, so the capture context
				// that `activateFromWake` is about to close cannot silence it.
				playWakeChime();
				void this.activateFromWake().catch((error) => {
					this.patch({ wakeError: '唤醒后启动识别失败：' + String(error?.message ?? error) });
				});
				this.ctx.logger?.info?.('voice: wake word detected', event);
			}

			/**
			 * Live engine counters for the diagnostics panel, or undefined when the
			 * local listener has never run. Read by polling, never through the store.
			 * @returns the engine's metrics object when a listener exists.
			 */
			getWakeMetrics() {
				return this.wakeEngine?.metrics;
			}

			/**
			 * Read the "continuous wake mode is active" flag.
			 *
			 * This is a *mode*, not a one-shot token — and that distinction is the
			 * whole fix. Three earlier designs treated it as consumable, and every one
			 * deadlocked the same way: an early successful arm cleared it, so when
			 * speech synthesis later took the microphone away and asked for it back,
			 * nothing was outstanding any more and the listener never returned. That
			 * is precisely the "reply finishes and wake stops working" symptom.
			 *
			 * It is set once when a wake word opens a turn, and cleared only by a
			 * manual microphone click (the user saying "one-shot, please") or by
			 * switching the feature off.
			 * @returns true while continuous wake mode is active.
			 */
			wakeHandbackPending() {
				return this.sessionFromWake === true;
			}

			/**
			 * Put the listener back into wake mode, if it is wanted but not running.
			 *
			 * Called from both ends of a turn — after a prompt is sent, and after
			 * automatic reading finishes — because the conversation is now
			 * continuous: one "hey jarvis" should not be needed per message, and the
			 * user must be able to interrupt the assistant mid-reply.
			 *
			 * Refusing to arm while `this.state.speaking` is true is the
			 * self-trigger guard: the microphone must not be listening to the
			 * assistant's own voice. The speech-ended path calls back in once the
			 * utterance is done, so the listener always comes back.
			 * @param {string} reason - short label used in the failure message.
			 */
			async armWakeIfIdle(reason) {
				if (this.disposed) return;
				if (!this.state.wakeEnabled) return;
				// The guards come first: bailing out must not discard the outstanding
				// hand-back. Guards must not clear it either: it stays set for the whole
				// continuous-wake session.
				if (this.state.wakeListening || this.wakeStarting) return;
				if (this.state.speaking) {
					// Synthesis owns the microphone right now. Announce that the
					// listener is still owed the microphone, so the strip can say
					// "restoring" rather than claiming to be idle while nothing is
					// listening.
					this.patch({ wakePending: this.wakeHandbackPending() });
					return;
				}
				if (!this.wakeHandbackPending()) return;
				// Visible in the strip while the models load, which takes seconds on a
				// cold cache. Without it a slow re-arm looks like a silent failure.
				this.patch({ wakePending: true });
				try {
					await this.armWake()
					if (this.state.wakeListening) {
						// NOTE: `sessionFromWake` is deliberately NOT cleared here. It
						// records that the session is wake-driven, which stays true for
						// as long as the conversation continues — synthesis takes the
						// microphone away and hands it back repeatedly, and each hand-back
						// needs this flag still set.
						this.wakeRetries = 0;
						this.patch({ wakePending: false });
						// Audible confirmation that the listener is back. This only runs on
						// a hand-back (`armWakeIfIdle` is never the first arming), so it
						// does not fire when the user simply switches the feature on.
						playWakeChime('resume');
					} else {
						// `armWake` can return without arming (a stale generation, a
						// guard) and the listener is still owed the microphone. Retry a
						// bounded number of times instead of stranding the feature: a
						// one-shot attempt is what let a single missed re-arm disable wake
						// for the rest of the session.
						this.scheduleWakeRetry(reason);
					}
					// Update needs the microphone and the previous capture cannot be
					// resumed, but coming back into wake mode matters more than holding
					// the cloud session open: otherwise continuous conversation dies
					// right here.
					if (this.state.listening) await this.disarmWake()
				} catch (error) {
					this.patch({
						wakeEnabled: false,
						wakeReady: false,
						wakeListening: false,
						wakePending: false,
						mode: 'idle',
						wakeError: reason + '失败：' + String(error?.message ?? error)
					})
				}
			}

			/**
			 * Try the outstanding hand-back again a moment later.
			 *
			 * Bounded, so a persistently failing arm surfaces as an error rather than
			 * an endless timer loop.
			 * @param {string} reason - label used in the failure message.
			 */
			scheduleWakeRetry(reason) {
				if (this.disposed || !this.state.wakeEnabled) return;
				if (!this.wakeHandbackPending()) return;
				if (this.wakeRetries >= 3) {
					this.patch({
						wakePending: false,
						wakeError: reason + '失败：多次尝试后仍未恢复唤醒监听，请重新开关一次开关。'
					});
					return;
				}
				this.wakeRetries += 1;
				if (this.wakeRetryTimer !== undefined) window.clearTimeout(this.wakeRetryTimer);
				this.wakeRetryTimer = window.setTimeout(() => {
					this.wakeRetryTimer = undefined;
					void this.armWakeIfIdle(reason);
				}, 800);
			}

			/**
			 * Re-arm the listener once speaking finishes.
			 *
			 * While the assistant talks the microphone belongs to synthesis, not to
			 * keyword spotting; this is the other half of that handoff.
			 */
			resumeWakeAfterSpeech() {
				// Nothing to restore: the hand-back decision is derived from the
				// session's origin token, and reaching wake mode again is the whole
				// point of the handoff.
				void this.armWakeIfIdle('恢复本地唤醒');
			}

			/** Persist the wake-word preference subset alongside the rest. */
			persistWake() {
				this.persist();
			}

			/** Set the detection threshold, clamped to a usable range. */
			setWakeThreshold(value) {
				const threshold = Math.min(0.99, Math.max(0.05, Number(value) || 0.5));
				this.patch({ wakeThreshold: threshold });
				if (this.wakeEngine !== undefined) this.wakeEngine.threshold = threshold;
				this.persist();
			}

			// ── preferences ──────────────────────────────────────────────────
			/** Flip automatic reading of settled assistant replies. */
			setAutoSpeak(value) {
				this.patch({ autoSpeak: value === true });
				this.persist();
				if (value !== true) this.stopSpeaking();
			}

			/** Switch the recognition language (and the speech default with it). */
			setLanguage(value) {
				const language = typeof value === 'string' && value !== '' ? value : 'zh-CN';
				this.patch({ language, voiceURI: '' });
				this.persist();
				if (this.recognition !== undefined) this.recognition.lang = language;
			}

			/** Pin one speech-synthesis voice by URI. */
			setVoice(uri) {
				this.patch({ voiceURI: typeof uri === 'string' ? uri : '' });
				this.persist();
			}

			/** Write the persisted preference subset. */
			persist() {
				writePreferences({
					autoSpeak: this.state.autoSpeak,
					language: this.state.language,
					voiceURI: this.state.voiceURI,
					wakeEnabled: this.state.wakeEnabled,
					wakeThreshold: this.state.wakeThreshold
				});
			}

			// ── session observation ──────────────────────────────────────────
			/**
			 * Follow one session's event window and lifecycle so settled assistant
			 * messages can be spoken and replay always targets what is on screen.
			 * @param {string|undefined} sessionId - the newly selected session.
			 */
			bindSession(sessionId) {
				if (this.sessionUnsubscribe !== undefined) this.sessionUnsubscribe();
				this.sessionUnsubscribe = undefined;
				this.sessionListener = undefined;
				this.boundSessionId = sessionId;
				this.wasRunning = false;
				this.historyLoaded = false;
				this.lastSpokenText = '';
				this.speakingTurn = 0;
				// A pending read belongs to the session being left; letting it fire
				// would speak the old session's reply over the new one.
				if (this.settleTimer !== undefined) {
					window.clearTimeout(this.settleTimer);
					this.settleTimer = undefined;
				}
				this.patch({ sessionId, lastAssistantText: '', error: '' });
				if (sessionId === undefined) return;
				const binding = this.ctx.sessions.binding(sessionId);
				if (binding === undefined) return;
				const session = binding.session;
				this.historyLoaded = session.getSnapshot().openState === 'open';
				const onEventWindow = () => this.inspectSession(session);
				this.sessionUnsubscribe = session.eventSource.subscribe(onEventWindow);
				this.sessionListener = session.subscribe(onEventWindow);
				this.inspectSession(session);
			}

			/**
			 * The single observation point: track the running bit's falling edge and
			 * remember the newest assistant prose of the selected session.
			 * @param {object} session - the bound session face.
			 */
			inspectSession(session) {
				const snapshot = session.getSnapshot();
				const entries = session.eventSource.getSnapshot().entries;
				// Scan backwards for the newest assistant prose, but remember which
				// turn produced it. The text alone is not enough to decide what to
				// read: `running` can drop to false a moment before the final
				// `assistant/message` lands in the event window, and reading "the
				// newest non-empty text" at that instant returns the *previous*
				// reply — which is why the plugin sometimes read the answer before
				// last.
				let latest = '';
				let latestTurn = 0;
				for (let index = entries.length - 1; index >= 0; index -= 1) {
					const entry = entries[index];
					if (entry.type !== 'event' || entry.event.type !== 'assistant/message') continue;
					const text = assistantText(entry.event.data?.message);
					if (text === '') continue;
					latest = text;
					const turn = entry.event.data?.turn;
					latestTurn = typeof turn === 'number' ? turn : 0;
					break;
				}
				if (latest !== this.state.lastAssistantText) this.patch({ lastAssistantText: latest });

				const running = snapshot.running === true;
				if (running) {
					this.wasRunning = true;
					if (this.settleTimer !== undefined) {
						window.clearTimeout(this.settleTimer);
						this.settleTimer = undefined;
					}
					// Highest assistant turn seen; a reply from an older turn is stale
					// by definition.
					if (latestTurn > this.speakingTurn) this.speakingTurn = latestTurn;
				} else if (this.wasRunning) {
					this.wasRunning = false;
					const settledTurn = this.speakingTurn;
					// Let the final message land before reading anything, and check the
					// turn again at that point — a short delay with a turn check is
					// what makes this reliable rather than merely likely.
					if (this.settleTimer !== undefined) window.clearTimeout(this.settleTimer);
					this.settleTimer = window.setTimeout(() => {
						this.settleTimer = undefined;
						const fresh = session.eventSource.getSnapshot().entries;
						for (let index = fresh.length - 1; index >= 0; index -= 1) {
							const entry = fresh[index];
							if (entry.type !== 'event' || entry.event.type !== 'assistant/message') continue;
							const text = assistantText(entry.event.data?.message);
							if (text === '') continue;
							const turn = entry.event.data?.turn;
							const numeric = typeof turn === 'number' ? turn : 0;
							if (settledTurn > 0 && numeric > 0 && numeric < settledTurn) break;
							this.onTurnSettled(text);
							break;
						}
					}, SPEAK_SETTLE_MS);
				}
				const opened = snapshot.openState === 'open';
				if (opened && !this.historyLoaded) {
					this.historyLoaded = true;
					this.lastSpokenText = latest;
				}
			}

			/**
			 * A turn just ended for the observed session: read the newest reply once.
			 * @param {string} latest - newest assistant prose in the event window.
			 */
			onTurnSettled(latest) {
				if (!this.state.autoSpeak) return;
				if (latest === '' || latest === this.lastSpokenText) return;
				this.lastSpokenText = latest;
				this.speak(latest);
			}
		}

		// ── React surfaces ───────────────────────────────────────────────────
		const h = React.createElement;

		/**
		 * Bind one controller snapshot to a component.
		 * @param {VoiceController} controller - the voice controller.
		 * @returns the current immutable state.
		 */
		function useVoiceState(controller) {
			return React.useSyncExternalStore(
				(callback) => controller.subscribe(callback),
				() => controller.getSnapshot(),
				() => controller.getSnapshot()
			);
		}

		 /** A 16px microphone glyph, filled while listening. */
		function MicIcon({ active }) {
			return h(
				'svg',
				{ width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
				h('path', {
					d: 'M12 3.75a3.25 3.25 0 0 0-3.25 3.25v5a3.25 3.25 0 0 0 6.5 0v-5A3.25 3.25 0 0 0 12 3.75Z',
					fill: active ? 'currentColor' : 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinejoin: 'round'
				}),
				h('path', {
					d: 'M5.75 11.5a6.25 6.25 0 0 0 12.5 0M12 17.75V21m-3 0h6',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinecap: 'round'
				})
			);
		}

		/** A 16px speaker glyph (waves drawn only while a voice is audible). */
		function SpeakerIcon({ active }) {
			return h(
				'svg',
				{ width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
				h('path', {
					d: 'M4.5 9.5h2.6L11 6.2v11.6l-3.9-3.3H4.5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z',
					fill: active ? 'currentColor' : 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinejoin: 'round'
				}),
				h('path', {
					d: active ? 'M14.6 9.2a4 4 0 0 1 0 5.6M17.2 6.8a7.5 7.5 0 0 1 0 10.4' : 'M15.4 9.4a4 4 0 0 1 0 5.2',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinecap: 'round'
				})
			);
		}

		/** One labelled switch row used by both the popover and the settings page. */
		function SwitchRow({ title, description, on, onToggle }) {
			return h(
				'div',
				{ className: 'dshVoice_row' },
				h(
					'div',
					{ className: 'dshVoice_rowText' },
					h('div', { className: 'dshVoice_title' }, title),
					description !== undefined ? h('div', { className: 'dshVoice_desc' }, description) : null
				),
				h('button', {
					type: 'button',
					className: 'dshVoice_switch',
					'data-on': on ? '1' : '0',
					role: 'switch',
					'aria-checked': on ? 'true' : 'false',
					'aria-label': title,
					onClick: () => onToggle(!on)
				})
			);
		}

		/**
		 * The composer control: click to talk, shift-click for a one-off replay, and
		 * a long-press-free gear area inside the popover for preferences. The menu
		 * opens on right-click / the caret, keeping the primary gesture a bare click.
		 */
		function VoiceButton({ controller }) {
			const state = useVoiceState(controller);
			const [menuOpen, setMenuOpen] = React.useState(false);
			const rootRef = React.useRef(null);

			React.useEffect(() => {
				if (!menuOpen) return undefined;
				const onPointerDown = (event) => {
					if (rootRef.current !== null && !rootRef.current.contains(event.target)) setMenuOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === 'Escape') setMenuOpen(false);
				};
				document.addEventListener('pointerdown', onPointerDown, true);
				document.addEventListener('keydown', onKeyDown);
				return () => {
					document.removeEventListener('pointerdown', onPointerDown, true);
					document.removeEventListener('keydown', onKeyDown);
				};
			}, [menuOpen]);

			const disabled = !state.recognitionSupported;
			const mode = state.listening ? 'listening' : state.speaking ? 'speaking' : 'idle';
			const wakeHint = state.wakeEnabled
				? state.wakeArmed
					? '（本地唤醒已开启，说 hey jarvis 即可）'
					: '（本地唤醒已开启，当前未监听）'
				: '';
			const hint =
				(disabled
					? '当前浏览器不支持语音识别（Web Speech API 不可用）'
					: state.listening
						? '正在聆听…点击结束'
						: state.speaking
							? '正在朗读回复…点击开始说话'
							: '点击开始语音输入') + wakeHint;

			// While listening, show what is already finalized plus the in-flight
			// fragment. Showing only `interim` made a paused-but-unfinished sentence
			// look like the earlier half had been dropped.
			const transcript =
				state.listening && state.interim !== ''
					? (state.transcript !== '' ? state.transcript + ' ' : '') + state.interim
					: state.transcript;

			return h(
				'div',
				{ className: 'dshVoice_root', ref: rootRef },
				menuOpen && h(VoiceMenu, { controller, state, onClose: () => setMenuOpen(false) }),
				h(
					'button',
					{
						type: 'button',
						className: 'dshVoice_btn',
						'data-state': mode,
						'data-auto': state.autoSpeak ? 'on' : 'off',
						'data-wake': state.wakeEnabled ? (state.wakeArmed ? 'on' : 'loading') : 'off',
						disabled,
						title: hint,
						'aria-label': hint,
						'aria-pressed': state.listening ? 'true' : 'false',
						onClick: () => (menuOpen ? controller.stopListening() : controller.toggleListening()),
						onContextMenu: (event) => {
							event.preventDefault();
							setMenuOpen((open) => !open);
						}
					},
					h(MicIcon, { active: state.listening }),
					h('span', { className: 'dshVoice_pulse', 'aria-hidden': true })
				),
				transcript !== '' && h('div', { className: 'dshVoice_transcript' }, transcript),
				state.error !== '' && h('div', { className: 'dshVoice_error' }, state.error)
			);
		}


		/** The preference popover anchored above the microphone control. */
		function VoiceMenu({ controller, state, onClose }) {
			// `voice.lang` is not guaranteed by every implementation, and a missing
			// value used to throw here and take the whole panel down with it.
			const family = String(state.language ?? 'zh').split('-')[0].toLowerCase()
			const supportedVoices = state.voices.filter((voice) =>
				String(voice.lang ?? '').toLowerCase().startsWith(family)
			)
			return h(
				'div',
				{ className: 'dshVoice_menu', role: 'dialog', 'aria-label': '语音对话设置' },
				h(SwitchRow, {
					title: '自动朗读回复',
					description: '每轮回复结束后自动用语音读出来',
					on: state.autoSpeak,
					onToggle: (value) => controller.setAutoSpeak(value)
				}),
				h(
					'div',
					{ className: 'dshVoice_row' },
					h(
						'div',
						{ className: 'dshVoice_rowText' },
						h('div', { className: 'dshVoice_title' }, '识别语言'),
						h('div', { className: 'dshVoice_desc' }, '浏览器原生识别的目标语言')
					),
					h(
						'select',
						{
							className: 'dshVoice_select',
							value: state.language,
							'aria-label': '识别语言',
							onChange: (event) => controller.setLanguage(event.target.value)
						},
						LANGUAGES.map((language) => h('option', { key: language.id, value: language.id }, language.label))
					)
				),
				h(SwitchRow, {
					title: '本地语音唤醒',
					description: state.wakeSupported
						? state.wakeEnabled
							? state.wakeArmed
								? '本机监听中（说 hey jarvis 唤醒），音频不出本机'
								: state.wakeReady
									? '已开启，但当前未监听（麦克风被识别或朗读占用，结束后自动恢复）'
									: '唤醒模型加载中…'
							: '开启后本机持续监听 hey jarvis，唤醒后自动开始识别'
						: '当前浏览器不支持本地唤醒',
					on: state.wakeEnabled,
					onToggle: (value) => {
						void controller.setWakeEnabled(value);
					}
				}),
				state.wakeError !== '' && h('div', { className: 'dshVoice_error' }, state.wakeError),
				state.synthesisSupported &&
					h(
						'div',
						{ className: 'dshVoice_row' },
						h(
							'div',
							{ className: 'dshVoice_rowText' },
							h('div', { className: 'dshVoice_title' }, '朗读音色'),
							h(
								'div',
								{ className: 'dshVoice_desc' },
								supportedVoices.length === 0
									? '系统未提供该语言的音色，将使用系统默认'
									: '下选框只列本语言音色，完整列表见下方语音诊断'
							)
						),
						h(
							'select',
							{
								className: 'dshVoice_select',
								value: state.voiceURI,
								'aria-label': '朗读音色',
								onChange: (event) => controller.setVoice(event.target.value)
							},
							[h('option', { key: '', value: '' }, '自动')].concat(
								supportedVoices.map((voice) => h('option', { key: voice.uri, value: voice.uri }, voice.name))
							)
						)
					),
				state.synthesisSupported && h(VoiceInventory, { controller, state }),
				h(
					'button',
					{
						type: 'button',
						className: 'dshVoice_replay',
						disabled: state.lastAssistantText === '',
						onClick: () => controller.replay()
					},
					state.speaking ? '重新朗读上一条回复' : '朗读上一条回复'
				),
				state.speaking &&
					h(
						'button',
						{
							type: 'button',
							className: 'dshVoice_replay',
							onClick: () => controller.stopSpeaking()
						},
						'停止朗读'
					),
				!state.synthesisSupported && h('div', { className: 'dshVoice_hint' }, '当前浏览器不支持语音合成，无法朗读回复。'),
				h('div', { className: 'dshVoice_hint' }, '提示：右键麦克风按钮也可以打开这个面板。'),
				h(
					'button',
					{ type: 'button', className: 'dshVoice_replay', onClick: onClose },
					'关闭'
				)
			);
		}

		/**
		 * Every voice the browser exposes, with the flag that actually matters.
		 *
		 * This exists because the select above filters to one language, which hides
		 * the question worth answering: whether a natural or cloud-backed voice is
		 * reachable at all. Narrator's neural voices (Xiaoxiao and friends) ship as
		 * separate MSIX packages and are NOT automatically visible to
		 * `speechSynthesis` — a locally installed voice still has to appear in this
		 * list before the plugin can select it.
		 */
		function VoiceInventory({ controller, state }) {
			const [open, setOpen] = React.useState(false);
			const voices = state.voices ?? [];
			const natural = voices.filter((voice) => /natural|online|neural/i.test(String(voice.name ?? '')));
			const local = voices.filter((voice) => voice.local === true);
			return h(
				'div',
				{ className: 'dshVoice_row dshVoice_wakeRow' },
				h(
					'div',
					{ className: 'dshVoice_rowText' },
					h(
						'button',
						{
							type: 'button',
							className: 'dshVoice_replay',
							onClick: () => setOpen((value) => !value),
							'aria-expanded': open ? 'true' : 'false'
						},
						'语音诊断：浏览器共识别到 ' + String(voices.length) + ' 个音色' +
							(natural.length > 0 ? '（含 ' + String(natural.length) + ' 个自然/在线）' : '（无自然语音）')
					),
					h(
						'div',
						{ className: 'dshVoice_desc' },
						open
							? '本机音色 ' + String(local.length) + ' 个。“在线/自然”音色由服务端合成，需要联网。'
							: '系统里装了晓晓/云希，但只有出现在这个列表里，插件才能选用 —— 点开查看完整清单。'
					)
				),
				open &&
					h(
						'div',
						{ className: 'dshVoice_barBody' },
						voices.length === 0
							? h('div', { className: 'dshVoice_hint' }, '浏览器没有返回任何音色。')
							: voices.map((voice, index) =>
									h(
										'div',
										{ className: 'dshVoice_diagRow', key: String(index) + voice.uri },
										h('span', null, String(voice.name ?? '?')),
										h('span', null, String(voice.lang ?? '?')),
										h(
											'span',
											{ className: voice.local ? 'dshVoice_diagOk' : undefined },
											voice.local ? '本机' : '在线'
										)
									)
								),
						h(
							'button',
							{
								type: 'button',
								className: 'dshVoice_replay',
								onClick: () => controller.speak('语音诊断测试，一二三四五。')
							},
							'用当前音色试读一句'
						)
					)
			);
		}

		/** The settings-page row, sharing the same controller as the composer control. */
		function VoiceSettingsRow({ controller }) {
			const state = useVoiceState(controller);
			const wakeDescription = !state.wakeSupported
				? '当前浏览器不支持本地唤醒（需要 AudioWorklet 与麦克风采集）。'
				: state.wakeEnabled
					? state.wakeArmed
						? '正在本机监听「hey jarvis」，全程不联网、不上传音频；唤醒后才开始云端识别。'
						: state.wakeReady
							? '已开启但当前未监听：麦克风正被语音识别或朗读占用，它们结束后会自动恢复监听。'
							: '正在加载本地唤醒模型（首次约 19 MB，之后走缓存）…'
					: '开启后麦克风会持续在本机做关键词识别，音频不出本机。';
			return h(
				'div',
				{ className: 'dshVoice_root' },
				h(SwitchRow, {
					title: '语音对话（说话输入 + 朗读回复）',
					description: state.recognitionSupported
						? '使用浏览器原生语音识别，回复可用系统音色朗读；麦克风按钮在输入框右侧。'
						: '当前浏览器不支持语音识别（Web Speech API 不可用），朗读回复仍可使用。',
					on: state.autoSpeak,
					onToggle: (value) => controller.setAutoSpeak(value)
				}),
				h(SwitchRow, {
					title: '本地语音唤醒',
					description: wakeDescription,
					on: state.wakeEnabled,
					onToggle: (value) => {
						void controller.setWakeEnabled(value);
					}
				}),
				state.wakeEnabled &&
					h(
						'div',
						{ className: 'dshVoice_row dshVoice_wakeRow' },
						h(
							'div',
							{ className: 'dshVoice_rowText' },
							h('div', { className: 'dshVoice_title' }, '唤醒灵敏度'),
							h(
								'div',
								{ className: 'dshVoice_desc' },
								'当前阈值 ' + state.wakeThreshold.toFixed(2) + '：调低更容易唤醒，调高更少误触发。'
							)
						),
						h('input', {
							type: 'range',
							className: 'dshVoice_range',
							min: '0.1',
							max: '0.9',
							step: '0.05',
							value: String(state.wakeThreshold),
							'aria-label': '唤醒灵敏度',
							onChange: (event) => controller.setWakeThreshold(event.target.value)
						})
					),
				state.wakeError !== '' && h('div', { className: 'dshVoice_error' }, state.wakeError),
				state.speaking &&
					h(
						'button',
						{ type: 'button', className: 'dshVoice_replay', onClick: () => controller.stopSpeaking() },
						'停止朗读'
					)
			);
		}

		/**
		 * Always-visible wake-word status strip, rendered below the composer card.
		 *
		 * The compact row answers the only two questions that matter while
		 * listening — is audio arriving, and how close is the score to the
		 * threshold — and the expander reveals the rest. It mounts through
		 * `conversation.composer.dock`, an ambient list slot, so it never competes
		 * with the conversation for space.
		 *
		 * Metrics are polled rather than subscribed: the classifier emits on every
		 * ~80 ms frame, and routing that through the store would re-render the
		 * conversation tree roughly twelve times a second.
		 */
		function WakeStatusBar({ controller }) {
			const state = useVoiceState(controller);
			const [open, setOpen] = React.useState(false);
			const [m, setM] = React.useState(null);

			React.useEffect(() => {
				if (!state.wakeEnabled) return undefined;
				const read = () => {
					const metrics = controller.getWakeMetrics();
					setM(metrics === undefined ? null : { ...metrics });
				};
				read();
				const timer = window.setInterval(read, 250);
				return () => window.clearInterval(timer);
			}, [controller, state.wakeEnabled]);

			if (!state.wakeEnabled) return null;

			const pct = (value) => String(Math.round(Math.max(0, Math.min(1, value)) * 100)) + '%';
			const contextOk = m !== null && m.contextState === 'running';
			// While another stage owns the microphone the keyword meter is frozen and
			// meaningless, so the row reports the stage instead. Without this the bar
			// looks stuck mid-conversation.
			const listening = state.wakeArmed;
			const stage = listening
				? undefined
				: state.sending
					? '发送中…'
					: state.listening
						? '正在识别，请说话（' + String(EMPTY_TIMEOUT_MS / 1000) + ' 秒无语音将自动返回待命）'
						: state.speaking
							? '正在朗读回复'
							: !state.wakeReady
								? '加载模型'
								: state.wakePending
									? '正在恢复唤醒监听…'
									: '未在监听唤醒词（可重新开关一次）';
			const dotClass = stage !== undefined
				? state.listening
					? 'dshVoice_dot dshVoice_dotBad'
					: 'dshVoice_dot dshVoice_dotDim'
				: contextOk
					? 'dshVoice_dot dshVoice_dotOn'
					: 'dshVoice_dot dshVoice_dotBad';

			return h(
				'div',
				{ className: 'dshVoice_bar' },
				h(
					'button',
					{
						type: 'button',
						className: 'dshVoice_barMain',
						onClick: () => setOpen((value) => !value),
						'aria-expanded': open ? 'true' : 'false',
						title: open ? '收起唤醒诊断' : '展开唤醒诊断'
					},
					h('span', { className: dotClass, 'aria-hidden': true }),
					h('span', { className: 'dshVoice_barLabel' }, stage !== undefined ? '语音对话' : '唤醒监听'),
					stage !== undefined
						? h('span', { className: 'dshVoice_barStage' }, stage)
						: h(
								'span',
								{ className: 'dshVoice_barMeter' },
								h('i', { style: { width: m === null ? '0%' : pct(m.score) } }),
								h('u', { style: { left: pct(state.wakeThreshold) } })
							),
					stage !== undefined
						? null
						: h('span', { className: 'dshVoice_barNum' }, m === null ? '—' : m.score.toFixed(3)),
					h(
						'span',
						{ className: 'dshVoice_barMeta' },
						'阈值 ' + state.wakeThreshold.toFixed(2) + ' · 命中 ' + String(m === null ? 0 : m.detections)
					),
					h('span', { className: 'dshVoice_barCaret' }, open ? '▾' : '▸')
				),
				open &&
					h(
						'div',
						{ className: 'dshVoice_barBody' },
						!contextOk &&
							h(
								'div',
								{ className: 'dshVoice_error' },
								m === null
									? '引擎尚未启动（开关打开后才会创建）。'
									: '音频上下文状态为 ' + m.contextState + ' —— 浏览器自动播放策略可能阻止了采集，点一下页面任意处再试。'
							),
						m !== null &&
							h(
								'div',
								{ className: 'dshVoice_diagRow' },
								h('span', null, '当前分 ' + m.score.toFixed(3)),
								h('span', null, '峰值 ' + m.peak.toFixed(3)),
								h('span', { className: m.speech ? 'dshVoice_diagOk' : undefined }, m.speech ? '有语音' : '静音')
							),
						m !== null &&
							h(
								'div',
								{ className: 'dshVoice_meter dshVoice_meterInput' },
								h('i', { style: { width: pct(m.level) } })
							),
						m !== null &&
							h(
								'div',
								{ className: 'dshVoice_diagRow' },
								h('span', null, '收音 ' + pct(m.level)),
								h('span', null, '帧 ' + String(m.frames)),
								h('span', null, contextOk ? '音频运行中' : m.contextState)
							),
						h(
							'div',
							{ className: 'dshVoice_hint' },
							m !== null && m.frames === 0
								? '还没收到任何音频帧：检查麦克风权限，或点一下页面让音频上下文恢复。'
								: '说 “Hey Jarvis” 时当前分应明显升高；峰值上不去就调低灵敏度阈值。'
						)
					)
			);
		}

		// ── plugin face ──────────────────────────────────────────────────────
		/** Services the browser half needs before it can mount its surfaces. */
		const inject = ['sessions', 'slots'];

		/**
		 * Client plugin body: build the controller, then contribute the composer
		 * control and the settings row.
		 * @param {object} ctx - the client root context.
		 */
		function apply(ctx) {
			const controller = new VoiceController(ctx);
			controller.start();
			ctx.effect(() => () => controller.dispose(), 'voice-dialog: controller');
			ctx.slots.inject('conversation.input.right', () =>
				ctx.slots.register(
					{
						name: 'conversation.input.right',
						id: 'voice-dialog',
						order: 5,
						inject: () => ({ controller })
					},
					VoiceButton
				)
			);
			// Ambient strip below the composer card: the live wake-word diagnostics
			// belong on the conversation page, not behind a right-click.
			ctx.slots.inject('conversation.composer.dock', () =>
				ctx.slots.register(
					{
						name: 'conversation.composer.dock',
						id: 'voice-dialog-wake',
						order: 10,
						inject: () => ({ controller })
					},
					WakeStatusBar
				)
			);
			ctx.slots.inject('settings.general.item', () =>
				ctx.slots.register(
					{
						name: 'settings.general.item',
						id: 'voice-dialog',
						order: 30,
						inject: () => ({ controller })
					},
					VoiceSettingsRow
				)
			);
		}

		const exports = { apply, inject };
		return exports;
	}
});
