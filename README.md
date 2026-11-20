<p align="center"><img src="docs/assets/ball.png" width="120" alt="The dsh-orb floating ball"></p>

# dsh-orb

English | [中文](README.zh-CN.md)

An unofficial personal plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). One installable bundle that adds a floating-ball agent with Computer Use to the official dsh desktop app and `dsh web` — the official repository stays untouched, and the main window remains the official dsh Web UI.

> **Disclaimer** — This is an unofficial project maintained by an individual developer. It is **not** affiliated with, endorsed by, or connected to DeepSeek AI in any way. DeepSeek, the DeepSeek logo, and the DeepSeek avatar artwork are the property of DeepSeek AI; they appear here only as the default ball avatar shipped by the upstream project.

A floating ball rests at the right edge of your screen. Tell it what you need: quick, visible actions are executed directly in the current app through Computer Use; long-running complex tasks are dispatched to a background coding session, and the result comes back to the ball when it finishes. The main window keeps the full dsh Web UI — session management, the plugin market, and model settings — so you can still write code, edit files, and run commands in it.

There is no telemetry.

## The floating ball

On startup the plugin spawns its own helper (a pinned, verified Electron runtime in an isolated profile) and the ball appears at the right edge of the primary display, always on top.

- **Hover** floats a small card beside the ball with **the latest reply only**; it collapses when the pointer leaves, and a **click** pins it for a slower read. **Drag** moves the ball; dragging it beyond the left or right screen edge docks it into a thin sliver — hover again to slide it back.
- **Right-click** opens the menu: open the main window, floating-ball agent settings and background agent settings (each track picks its own model and thinking level), the coordinate-encoding toggle, the terse-reply toggle (its character cap is in the label), the hourly-chime toggle (its silent window is in the label), and "Disable floating ball". The ball follows the official dsh process — when the official app exits, the ball exits with it.
- The ball has no chat box any more: the conversation, history, permission chip and composer all live in the main window now, and the 320×190 card beside it is a "what did it just say" readout. The old panel's elements are still in the page — hidden, not deleted — because the page resolves every one of them by id, and a missing node would take the whole page, ball included, down at startup. To bring the old panel back, delete the last block in `floating.css`.
- One exception: when the agent asks a question in the ball's session, the card grows back to an answerable size (options / custom answer / cancel). It is the only thing left on the ball that still needs your hands — an unanswered question blocks the agent.
- Read-aloud, the wake word and voice input still work on the ball; there is just no visible composer, so a dictation is sent straight to the ball's session. Appearance still mirrors the main window (dark / light, Chinese / English, live).
- The ball avatar can be set to one of six built-in animated GIFs, or replaced with a custom GIF / PNG / WebP (2 MB cap), in main-window **Settings → Floating Ball**. The built-ins stay animated: the ball plays them whenever it is active, exactly like the shipped default.

## Terse replies

Sessions on the ball answer for the ear by default: the conclusion first, a body of at most 80 characters and three lines, no tables, no lists of links, no "by the way" addenda, and no Markdown tables, nested lists, or code blocks — none of those can be read aloud. Only an explicit "expand" / "tell me in detail" lifts the limit.

The contract is a system-prompt section, and it covers the ball's sessions only (including the background sessions it dispatches); ordinary sessions in the main window keep their normal answers. The switch and the character cap live in `orb-reply.json` in the dsh profile directory, next to `orb-speech.json` and `orb-wake.json`:

```json
{ "enabled": true, "maxReplyChars": 80 }
```

- **To turn terse mode off**: right-click the ball and uncheck **Terse replies (≤80 chars)** — the row is checked while the contract is on and its label names the cap. If you would rather edit the file, set `"enabled"` to `false`; deleting the file means the default, which is **on**. Either way the click or the edit applies to the next reply.
- `maxReplyChars` accepts 20–2000 and is clamped to that band; a missing or invalid field falls back to the default. The menu row shows the value it is enforcing; the cap itself is still set in the file.
- The file is re-read for every assembly, so an edit applies to the next reply — no dsh restart needed.

## Hourly chime

On the hour, every hour, the ball says the time once — "现在是上午九点整。" — and goes quiet again. One line, one hour; it never revisits the last one or previews the next. It speaks through the ball's own read-aloud service, so it sounds like the same voice that reads replies.

- **The switch**: right-click the ball → **Hourly chime**. Checking it takes effect immediately, and **unchecking then checking it again speaks the current time on the spot** — the sample is the only way to judge the voice without waiting for an hour. With no read-aloud service configured the row reads "turn read-aloud on first" and is greyed out, because there is no voice to say anything.
- **Silent at night**: 0–7 by default. The window lives in the same file and may wrap midnight (`"quietFrom": 22, "quietTo": 6` silences 22:00 through 05:59).
- **Never talks over you**: while a reply is being read, while a dictation is in flight, or at any point in a continuous voice exchange (armed after a dictated message, waiting, or with the microphone about to open), the chime stands down and that hour is simply skipped.
- Configuration lives in `orb-chime.json` in the dsh profile directory, next to `orb-speech.json` and `orb-wake.json`; deleting the file means the default (on, silent 0–7):

```json
{ "enabled": true, "quietFrom": 0, "quietTo": 7 }
```

- The menu writes only `enabled`; the quiet window is a file edit (`quietFrom` / `quietTo`, 0–24, equal ends meaning every hour including night). Both directions apply at the next whole hour — no dsh restart needed.
- The timer recomputes from the wall clock rather than adding an hour each time, and past 90 seconds late it skips that hour entirely: it never announces a time that has already stopped being true.

## Dual-track agent architecture

The Computer Use agent inside the floating ball decides how every message is handled; there is no separate task classifier at runtime:

```mermaid
flowchart TD
    user["You speak to the floating ball"] --> orb["Computer Use Agent"]
    orb -->|"Visible GUI actions"| gui["13 GUI tools<br>executed in the current window"]
    orb -->|"Quick lookups: weather, news"| web["web_search / web_fetch<br>answered on the ball"]
    orb -->|"Dig through files, produce documents or websites"| bg["code_agent background session<br>queued, returns immediately"]
    bg -->|"Completion notice"| orb
```

- **Foreground track · Computer Use**: visible operations — opening apps, clicking buttons, filling forms, changing settings — are executed with GUI tools right in front of you, each step based on a live screenshot of the frontmost window. Quick lookups such as weather or news headlines stay on the ball too, answered directly with `web_search` / `web_fetch`.
- **Background track · Code Agent**: complex tasks — digging through files, producing documents, building a website — are dispatched through `code_agent` to a background standard session. Dispatch returns immediately; the ball tells you the background is running and you can keep chatting. When the background session ends and the ball is idle, the completion summary returns to the ball automatically, and the Computer Use agent decides the next move — keep clicking, dispatch more background work, or wrap up.

A background session is the same kind of session you create manually in the main window; it appears in the `dsh_orb` folder in the main-window sidebar, where you can open, continue, or stop it. Follow-up changes to the same deliverable go back to the same background session; unrelated new work opens another one. The conversation history, permissions, and per-track model settings are shared with the official dsh process — the ball reads and writes the same sessions as the main window.

## Computer Use

Every conversation on the ball runs Computer Use: the first message automatically attaches a screenshot of the frontmost app's visible windows, and another screenshot follows every action, including your mouse cursor, so the model always sees the latest screen state.

- While the agent operates, screenshots automatically omit the ball, the expanded panel, and the observation border, and clicks pass through the ball instead of landing on it; the observed window gets a glowing observation border marking what the agent is looking at. Outside of agent operations the ball is a normal window you can screenshot and record.
- Tool list: `click` (single/double/right click, hold modifiers), `input_text`, `scroll`, `hotkey`, `long_press`, `drag`, `wait`, `long_wait`, `screenshot` (saved to the Desktop and copied to the clipboard), `open_in_browser`, `open_in_finder`, `list_apps`, `open_app`.
- **macOS**: the first time you operate the screen, the system permission dialogs are attributed to **DeepSeek Harness** (desktop) or your terminal (`dsh web`) — authorize that process. The ball's onboarding layer walks you through Screen Recording and Accessibility.
- **Windows**: no system-permission onboarding is needed; windows running as administrator refuse to be clicked or typed into.
- Installing this plugin is the consent gate: the GUI tools never ask per click.

## How it works

```
DeepSeek Harness (official, unmodified)
└─ Electron shell (main window, dsh://open, single instance)
     └─ Host, spawned as a plain Node process (ELECTRON_RUN_AS_NODE=1)
          └─ dsh-orb plugin
               ├─ host — sessions, permissions, models, web routes, helper lifecycle
               ├─ computer-use — 13 GUI tools + code_agent (Computer Use preset)
               └─ client-settings — the "Floating Ball" section in main-window settings

Helper (its own downloaded Electron, isolated userData)
├─ ball window, observation border
└─ data requests → authenticated loopback URL of the official Host
```

- One package to install: the `dsh-orb` bundle assembles the host, the Computer Use plugin, the helper, and the settings page into itself at build time.
- The helper runtime is a stock Electron release pinned by SHA-256 (darwin/win32, arm64/x64), downloaded on first use and verified against the pinned hashes; it runs in its own `userData`, separate from the official app.
- The helper talks to the host over a loopback-only NDJSON socket authenticated with a random 32-byte token generated per launch, passed by environment variable — never argv, never written to disk. Authenticated URLs with official credentials never reach the helper.
- Watchdog: the helper exits when it loses the socket; the host restarts it at most three times. Computer Use in the main window keeps working even if the ball cannot start.

## Requirements

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the desktop app, or `dsh web` from the CLI. Built against dsh `0.1.7-rc.2`; the declared compatibility range is `>=0.1.7-rc.2 <0.3.0-0`.
- macOS (Apple Silicon / Intel) or Windows x64. Linux loads the plugin but does not create a ball — background code sessions still work.
- Node.js `^22.19.0 || >=24.0.0` and pnpm `11.7.0` (only for building from source).

## Install

### From a release

Once published to npm, install by package name:

- **Desktop app**: in the app, open the plugin page and add the package name `dsh-orb`.
- **CLI** (`dsh web`): `dsh plugin add dsh-orb`.

### From a local build

```sh
pnpm install
pnpm build
pnpm --filter dsh-orb pack        # produces ./dsh-orb-0.0.0.tgz
```

Then either add the tarball in the desktop app's plugin page, or:

```sh
dsh plugin add ./dsh-orb-0.0.0.tgz
```

After the first installation the helper's Electron runtime is downloaded on first use of the ball, then cached.

## Development

```sh
pnpm typecheck   # tsc over all packages
pnpm test        # node:test suites + vitest suites (computer-use)
pnpm build       # build every package and assemble the bundle
```

The design documents this plugin was built from live in [docs/](docs/) — feasibility analysis, architecture, phased plan, and the running addendum of post-design revisions.

## Status and known limitations

- The **selection toolbar** (search / translate / send-to-agent on text selection) is temporarily disabled while a defect is fixed; its code ships but every entry point is removed and the feature is forced off in preferences.
- Built and tested against dsh `0.1.7-rc.2`; newer dsh versions within the compatibility range may require re-verification.
- No floating ball on Linux; headless environments can still run background code sessions.
- The macOS permission dialogs name DeepSeek Harness or your terminal, not this plugin — that is how the OS attributes permissions to the process that hosts the agent.

## Relationship to DeepSeek Harness

This repository is an unofficial derivative work built on top of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), dsh's open-source everything-is-a-plugin agent harness; sessions, plugins, tools, and the Web UI are all driven by it. This project modifies no upstream code — it installs like any third-party dsh plugin. To go deeper:

- [docs/01-analysis.md](docs/01-analysis.md) — feasibility and product decisions
- [docs/02-architecture.md](docs/02-architecture.md) — processes, packages, communication, security
- [packages/computer-use/README.md](packages/computer-use/README.md) — the GUI tools, coordinate encoding, and permission details

## License

[MIT](LICENSE). Upstream-derived code and assets are disclosed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
