/**
 * Mount the composer wake switch in a real Chromium window and measure it.
 *
 * The switch is plain DOM injected beside the voice plugin's microphone, so the parts worth
 * proving are the ones a unit test cannot see: that it lands in the middle of the composer row
 * rather than at an end, that the strike-through only shows when it is off, and that a click
 * posts the opposite of what the page is showing. The composer is rebuilt here with the same
 * nesting the real one uses (editor, row, tools, trailing, activity), read out of
 * `dsh-client-ui-conversation`, and the function under test is lifted from the shipped source.
 *
 * `npx electron probe_wake_toggle.cjs` — prints JSON and exits.
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const CLIENT = path.join(ROOT, 'packages', 'client-settings', 'client.js')

/** The body of one top-level function, by brace matching — the page is not a module we can import. */
function lift(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`${name} not found`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`${name} is not closed`)
}

const source = fs.readFileSync(CLIENT, 'utf8')
const styles = [...source.matchAll(/\.dsh-orb-wake-[^{]+\{[^}]*\}/g)].map((m) => m[0]).join('\n')
  + '\n@media (min-width: 900px) { .dsh-orb-wake-label { display: inline; } }'

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
  body { margin: 0; background: #111; font: 14px system-ui; color: #eee; }
  .composer { position: fixed; inset: 40px 40px auto 40px; padding: 12px; border-radius: 12px; background: #1b1b1b; }
  .editor { min-height: 40px; }
  /* The real row is a flex line with the tools on the left and the trailing half on the right. */
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .tools, .trailing { display: flex; align-items: center; gap: 6px; }
  .activity { display: flex; align-items: center; }
  button { font: inherit; }
  ${styles}
</style></head><body>
  <div class="composer">
    <div class="editor" contenteditable="true"></div>
    <div class="row" id="row">
      <div class="tools" id="tools"><button aria-label="命令">+</button></div>
      <div class="trailing" id="trailing">
        <div class="standard"><button aria-label="选择模型">M</button></div>
        <div class="activity"><button aria-label="开始录音" id="mic">mic</button></div>
      </div>
    </div>
  </div>
</body></html>`

const injected = `
  window.__calls = []
  const copy = () => ({ wakeOn: '开', wakeOff: '关', wakeLabel: '唤醒' })
  async function request(path, options) {
    window.__calls.push({ path, method: (options && options.method) || 'GET',
      body: options && options.body ? JSON.parse(options.body) : null })
    if (options && options.method === 'POST') return { enabled: JSON.parse(options.body).enabled }
    return { enabled: true }
  }
  ${lift(source, 'wakeToggle')}
  wakeToggle()
`

function run() {
  return `
    (async () => {
      await new Promise((r) => setTimeout(r, 60))
      const row = document.getElementById('row')
      const seat = document.querySelector('.dsh-orb-wake-seat')
      const toggle = document.querySelector('.dsh-orb-wake-toggle')
      const order = [...row.children].map((node) => node.id || node.className)
      const rowBox = row.getBoundingClientRect()
      const seatBox = seat ? seat.getBoundingClientRect() : null
      const toggleBox = toggle ? toggle.getBoundingClientRect() : null
      const before = toggle ? toggle.getAttribute('aria-pressed') : null
      const slashBefore = toggle ? getComputedStyle(toggle.querySelector('.dsh-orb-wake-slash')).display : null
      if (toggle) toggle.click()
      await new Promise((r) => setTimeout(r, 60))
      const after = toggle ? toggle.getAttribute('aria-pressed') : null
      const slashAfter = toggle ? getComputedStyle(toggle.querySelector('.dsh-orb-wake-slash')).display : null
      const posts = (window.__calls || []).filter((c) => c.method === 'POST')
      return JSON.stringify({
        mounted: seat !== null && toggle !== null,
        order,
        seatBeforeTrailing: order.indexOf('dsh-orb-wake-seat') < order.indexOf('trailing'),
        centreOffset: toggleBox ? Math.round((toggleBox.left + toggleBox.width / 2) - (rowBox.left + rowBox.width / 2)) : null,
        rowWidth: Math.round(rowBox.width),
        buttonWidth: toggleBox ? Math.round(toggleBox.width) : null,
        before, after,
        slashBefore, slashAfter,
        posts,
        titleAfter: toggle ? toggle.getAttribute('title') : null,
      })
    })()
  `
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 260, show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await win.webContents.executeJavaScript(injected)
  const result = JSON.parse(await win.webContents.executeJavaScript(run()))
  console.log(JSON.stringify(result, null, 2))
  app.quit()
}).catch((error) => {
  console.log(JSON.stringify({ error: String(error && error.message ? error.message : error) }))
  app.quit()
})
