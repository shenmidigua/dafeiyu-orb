import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { processLabel, reasoningSummary, classifyTool, deriveSummary, formatToolBody, terminalCardModel, terminalFailed, searchCardModel, webCardModel, diffCardModel, diffTotals, diffLines, processTitle, toolTitle, readCardModel, usageLabels, tokenUsageTotal, formatTokenCount } from '../assets/transcript-model.js'
import { WAVE_BARS } from '../assets/wake.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The source of one named function in the ball page, cut out by brace matching.
 *
 * The page is one big module closing over the DOM, so its functions cannot be imported and
 * called here; cutting the body out and asserting on its shape is how this file reaches them.
 * An unbalanced brace inside a string or comment would end the cut early, which fails the
 * assertions loudly instead of passing a wrong body.
 * @param shell - the page source.
 * @param name - the function to cut out.
 * @returns the text from `function name(` to its closing brace, keeping an `async` keyword.
 */
function pageFunction(shell: string, name: string): string {
  const head = shell.indexOf(`function ${name}(`)
  assert.notEqual(head, -1, `${name} is missing from the page`)
  // Keep the `async` in front: cutting from `function` alone would leave the body's `await`s
  // inside a plain function, which is a syntax error rather than a wrong answer.
  const start = shell.slice(head - 6, head) === 'async ' ? head - 6 : head
  const open = shell.indexOf('{', head)
  let depth = 0
  for (let i = open; i < shell.length; i += 1) {
    if (shell[i] === '{') depth += 1
    else if (shell[i] === '}') {
      depth -= 1
      if (depth === 0) return shell.slice(start, i + 1)
    }
  }
  throw new Error(`${name} never closes`)
}

/**
 * Every message the wake badge can show, standing in for the page's own copy.
 *
 * The values are the keys themselves, so a test can ask which branch ran without pinning
 * the wording — `wakeRecording` here means "the badge said the recording line".
 */
const PROBE_MESSAGES = {
  wakeLoading: 'wakeLoading',
  wakeListening: 'wakeListening',
  wakeDetected: 'wakeDetected',
  wakeRecording: 'wakeRecording',
  wakeTranscribing: 'wakeTranscribing',
  wakeUnavailable: 'wakeUnavailable',
  wakeFailed: 'wakeFailed:{why}',
}

/**
 * Run the page's real `syncWake` against a stubbed DOM and report what it drew.
 *
 * This executes the shipped function instead of asserting on its text: the badge's wording
 * depends on two inputs (the engine's state and the page's dictation phase) and only a run
 * can show which one won.
 * @param inputs - `wakeState` from the engine, optional `dictationPhase` from the page.
 * @returns the badge text and the body classes the function toggled.
 */
function drawWakeState(inputs: { wakeState: string; detail?: string; dictationPhase?: string; expanded?: boolean }): { text: string; hidden: boolean; classes: Record<string, boolean> } {
  const classes: Record<string, boolean> = {}
  const badge = { textContent: '', hidden: false }
  const ball = { title: '', removeAttribute() { ball.title = '' } }
  const document = {
    body: { classList: { toggle: (name: string, on: boolean) => { classes[name] = on === true } } },
    querySelector: (selector: string) => (selector === '#wake-badge' ? badge : ball),
  }
  const factory = new Function('deps', `
    const { document, messages, pageClosed, expanded, wakeState, wakeDetail, dictationPhase } = deps
    ${pageFunction(readFileSync(join(here, '../assets/shell.js'), 'utf8'), 'syncWake')}
    return syncWake
  `)
  factory({
    document,
    messages: PROBE_MESSAGES,
    pageClosed: () => false,
    expanded: inputs.expanded ?? true,
    wakeState: inputs.wakeState,
    wakeDetail: inputs.detail ?? '',
    dictationPhase: inputs.dictationPhase,
  })()
  return { text: badge.textContent, hidden: badge.hidden, classes }
}

/**
 * Run the page's real waveform functions against a stubbed SVG and report the geometry.
 *
 * The same reason as `drawWakeState`: the drawing closes over the page's module scope, so the
 * shipped bodies are executed rather than matched. The official curve is made of numbers —
 * silence as a two-unit dotted line, a full-scale level at thirty-six — and only a run pins them.
 * @returns the bars the page built, how many it appended to the svg, and its own paint calls.
 */
function drawWaveform(): {
  bars: Array<{ getAttribute(name: string): string | undefined }>
  appended: number
  page: { reset(): void; paint(levels: number[]): void }
} {
  const bars: Array<Record<string, string>> = []
  let appended = 0
  const svg = { appendChild: () => { appended += 1 } }
  const document = {
    createElementNS: () => {
      const attributes: Record<string, string> = {}
      return {
        setAttribute: (name: string, value: string) => { attributes[name] = value },
        getAttribute: (name: string) => attributes[name],
      }
    },
  }
  const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
  const factory = new Function('deps', `
    const { document, voiceWave, waveBars, WAVE_BARS } = deps
    ${pageFunction(shell, 'buildWaveform')}
    ${pageFunction(shell, 'restWaveform')}
    ${pageFunction(shell, 'paintWaveform')}
    return { buildWaveform, restWaveform, paintWaveform }
  `)
  const page = factory({ document, voiceWave: svg, waveBars: bars, WAVE_BARS }) as {
    buildWaveform(): void
    restWaveform(): void
    paintWaveform(levels: number[]): void
  }
  page.buildWaveform()
  return {
    bars,
    appended,
    page: { reset: () => page.restWaveform(), paint: (levels) => page.paintWaveform(levels) },
  }
}

/** A full window of one level, which is what the page paints from the engine. */
function flat(level: number): number[] {
  return new Array<number>(WAVE_BARS).fill(level)
}

describe('reasoning summary', () => {
  it('keeps the latest completed paragraph while streaming', () => {
    assert.equal(reasoningSummary('还在想', true), '')
    assert.equal(reasoningSummary('第一段标题\n还在写', true), '第一段标题')
    assert.equal(reasoningSummary('第一行\n第一段剩余\n\n第二行\n还在写', true), '第二行')
    assert.equal(reasoningSummary('第一行\n\n还没写完', true), '第一行')
  })

  it('uses the first line once the block has settled', () => {
    assert.equal(reasoningSummary('全文第一行\n第二行', false), '全文第一行')
    assert.equal(reasoningSummary('\n后面才有字', false), '')
  })

  it('strips bold markers from the collapsed summary', () => {
    assert.equal(reasoningSummary('**加粗**\n未完成', true), '加粗')
    assert.equal(reasoningSummary('**你好**世界\n下一行', false), '你好世界')
    assert.equal(reasoningSummary('  **标题**\n第二行', false), '  标题')
  })
})

describe('turn process label', () => {
  it('formats live seconds and minutes without padded seconds', () => {
    assert.equal(processLabel({ zh: true, running: true, elapsedMs: 200 }), '深度求索中，用时1秒')
    assert.equal(processLabel({ zh: true, running: true, elapsedMs: 5000 }), '深度求索中，用时5秒')
    assert.equal(processLabel({ zh: false, running: true, elapsedMs: 5000 }), 'Deep diving for 5s')
    assert.equal(processLabel({ zh: true, running: true, elapsedMs: 65000 }), '深度求索中，用时1分5秒')
    assert.equal(processLabel({ zh: false, running: true, elapsedMs: 65000 }), 'Deep diving for 1m 5s')
  })

  it('pads settled minutes and keeps a space before the duration', () => {
    assert.equal(processLabel({ zh: true, running: false, elapsedMs: 65000 }), '用时 1分05秒')
    assert.equal(processLabel({ zh: false, running: false, elapsedMs: 65000 }), 'Took 1m 05s')
    assert.equal(processLabel({ zh: true, running: false, elapsedMs: 3_661_000 }), '用时 1小时01分01秒')
    assert.equal(processLabel({ zh: false, running: true, elapsedMs: 3_661_000 }), 'Deep diving for 1h 01m 1s')
  })

  it('uses the Worked label when the turn has no start time', () => {
    assert.equal(processLabel({ zh: true, running: false }), '已完成工作')
    assert.equal(processLabel({ zh: false, running: false }), 'Worked')
    assert.equal(processLabel({ zh: true, running: true }), '深度求索中')
  })

  it('names stop and fail endings, and prefixes the step title', () => {
    assert.equal(processLabel({ zh: true, running: false, end: 'stopped' }), '已停止')
    assert.equal(processLabel({ zh: false, running: false, end: 'failed' }), 'Failed')
    assert.equal(processLabel({ zh: true, running: false, elapsedMs: 5000, title: '执行了命令' }), '执行了命令，用时 5秒')
    assert.equal(processLabel({ zh: false, running: false, elapsedMs: 5000, title: 'Ran commands' }), 'Ran commands, Took 5s')
  })
})

describe('tool row model', () => {
  it('classifies tools into variants and localized titles', () => {
    assert.equal(classifyTool('bash'), 'bash')
    assert.equal(classifyTool('web_fetch'), 'read')
    assert.equal(classifyTool('grep'), 'search')
    assert.equal(classifyTool('unknown_thing'), 'others')
    assert.equal(toolTitle('bash', true), '运行命令')
    assert.equal(toolTitle('web_search', true), '网页搜索')
    assert.equal(toolTitle('web_search', false), 'Search')
    assert.equal(toolTitle('todo_write', true), '更新任务清单')
  })

  it('derives summaries from arguments, appending the tool name for generic rows', () => {
    assert.equal(deriveSummary('read', JSON.stringify({ file_path: '/tmp/a.txt\nsecond' })), '/tmp/a.txt')
    assert.equal(deriveSummary('bash', JSON.stringify({ description: 'list files', command: 'ls' })), 'list files')
    assert.equal(deriveSummary('search', JSON.stringify({ queries: ['a', 'b'] })), 'a, b')
    assert.equal(deriveSummary('others', JSON.stringify({ task: 'hello' })), 'hello')
  })

  it('formats generic bodies as pretty JSON and unwraps run_code programs', () => {
    assert.equal(formatToolBody('read', '{"file_path":"a"}'), '{\n  "file_path": "a"\n}')
    assert.equal(formatToolBody('code', '{"code":"let x = 1"}'), 'let x = 1')
    assert.equal(formatToolBody('read', 'not json'), 'not json')
  })
})

describe('tool card models', () => {
  it('derives a terminal card from a bash call and exit marker', () => {
    const card = terminalCardModel('bash', JSON.stringify({ command: 'ls -la', description: 'list files' }), [
      { type: 'text', text: 'file-a\nfile-b\n[exit code: 2]' },
    ])
    assert.equal(card?.command, 'ls -la')
    assert.equal(card?.exitCode, 2)
    assert.equal(card?.output, 'file-a\nfile-b')
    assert.equal(terminalFailed(card), true)
  })

  it('treats persistent shells and non-text results as generic', () => {
    assert.equal(terminalCardModel('bash', JSON.stringify({ command: 'x' }), [{ type: 'text', text: '[exit code: 0]' }]), null)
    const noDescription = terminalCardModel('bash', JSON.stringify({ command: 'x' }), undefined)
    assert.equal(noDescription, null)
  })

  it('derives a read card from result metadata and the envelope', () => {
    const card = readCardModel({
      path: '/tmp/a.txt',
      offset: 1,
      totalLines: 2,
      lines: [{ number: 1, text: 'first' }, { number: 2, text: 'second' }],
    }, [{ type: 'text', text: '<path>/tmp/a.txt</path>\n<type>file</type>\n<content>\nfirst\nsecond\n</content>' }])
    assert.equal(card?.label, '/tmp/a.txt')
    assert.equal(card?.lines.length, 2)
    assert.equal(card?.totalLines, 2)
  })

  it('derives search and web cards from metadata', () => {
    const search = searchCardModel({
      truncated: false, total: 2, shape: 'matches',
      files: [{ path: 'a.ts', matches: [{ lineNumber: 1, line: 'x' }] }, { path: 'b.ts', matches: [{ lineNumber: 2, line: 'y' }] }],
    })
    assert.equal(search?.card.kind, 'matches')
    assert.equal(search?.card.files.length, 2)
    const web = webCardModel({ truncated: true, answer: 'an answer', sources: [{ url: 'https://a', title: 'A' }] })
    assert.equal(web?.kind, 'search')
    assert.equal(web?.sources.length, 1)
    const fetch = webCardModel({ truncated: false, url: 'https://b', statusCode: 200 })
    assert.equal(fetch?.kind, 'fetch')
    assert.equal(fetch?.statusCode, 200)
  })

  it('derives diffs from write/edit arguments and result metadata', () => {
    const intended = diffCardModel('write', JSON.stringify({ file_path: 'a.ts', content: 'new' }), false, '')
    assert.equal(intended?.diffs.length, 1)
    const applied = diffCardModel('edit', JSON.stringify({ file_path: 'a.ts', old_string: 'a\nb', new_string: 'a\nc' }), false, {
      diffs: [{ path: 'a.ts', oldText: 'a\nb', newText: 'a\nc' }],
    })
    assert.equal(applied?.diffs.length, 1)
    assert.deepEqual(diffTotals(applied.diffs), { added: 1, removed: 1 })
    const lines = diffLines(applied.diffs[0])
    assert.deepEqual(lines.map((line) => line.kind), ['context', 'del', 'add'])
    assert.equal(diffCardModel('edit', JSON.stringify({ file_path: 'a.ts', old_string: 'x', new_string: 'y' }), true, ''), null)
  })
})

describe('step process title', () => {
  it('joins the top tool categories with the Harness phrasing', () => {
    assert.equal(processTitle(['bash'], true), '执行了命令')
    assert.equal(processTitle(['bash', 'read'], false), 'Ran commands and read files')
    assert.equal(processTitle(['read', 'read', 'bash', 'grep'], true), '已读取文件，执行了命令，已搜索代码')
  })
})

describe('turn usage pill', () => {
  it('totals billed input plus output, ignoring absent cache buckets', () => {
    assert.equal(tokenUsageTotal({ inputTokens: 100, outputTokens: 40 }), 140)
    assert.equal(tokenUsageTotal({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 900 }), 1040)
    assert.equal(tokenUsageTotal({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 900 }), 900)
    assert.equal(tokenUsageTotal(undefined), null)
    assert.equal(tokenUsageTotal('nope'), null)
    assert.equal(tokenUsageTotal({ inputTokens: -5, outputTokens: 'x' }), null)
  })

  it('scales compact counts like the Harness pill', () => {
    assert.equal(formatTokenCount(999), '999')
    assert.equal(formatTokenCount(1000), '1K')
    assert.equal(formatTokenCount(1234), '1.2K')
    assert.equal(formatTokenCount(12345), '12.3K')
    assert.equal(formatTokenCount(123456), '123K')
    assert.equal(formatTokenCount(1234567), '1.2M')
    const zh = usageLabels(true)
    const en = usageLabels(false)
    assert.equal(zh.count(formatTokenCount(1234)), '1.2K tok')
    assert.equal(zh.title, '本轮用量')
    assert.equal(en.title, 'Turn usage')
  })
})

/**
 * Drive the page's real `setRunning` through a script of turn markers and count the bells.
 *
 * The finished-task frame hangs off the turn lifecycle, and the only thing that separates a
 * genuine completion from the host replaying state (or from a turn the user stopped) is the
 * transition itself — which is exactly the part a source assertion cannot check.
 * @param turns - `{ running, interrupted? }` in arrival order.
 * @returns how many times the frame was played.
 */
function ringsFor(turns: { running: boolean; interrupted?: boolean }[]): number {
  let rings = 0
  const stop = { hidden: false }
  const document = { body: { classList: { toggle: () => {} } } }
  const factory = new Function('deps', `
    const { document, stop, expanded, pageClosed, syncGif, playDoneFrame, blocks, ensureProcess, setProcessOpen, refreshProcessLabel, startProcessClock, stopProcessClock, freezeProcess } = deps
    let running = false
    let processGroup
    ${pageFunction(readFileSync(join(here, '../assets/shell.js'), 'utf8'), 'setRunning')}
    return (next, interrupted) => setRunning(next, interrupted)
  `)
  const setRunning = factory({
    document,
    stop,
    expanded: false,
    pageClosed: () => false,
    syncGif: () => {},
    playDoneFrame: () => { rings += 1 },
    blocks: new Map(),
    ensureProcess: () => ({ live: true }),
    setProcessOpen: () => {},
    refreshProcessLabel: () => {},
    startProcessClock: () => {},
    stopProcessClock: () => {},
    freezeProcess: () => {},
  })
  for (const turn of turns) setRunning(turn.running, turn.interrupted === true)
  return rings
}

describe('finished-task frame', () => {
  it('plays once for a turn that ran to its own end', () => {
    assert.equal(ringsFor([{ running: true }, { running: false }]), 1)
  })

  it('stays quiet on page load, where the host replays the turn', () => {
    // The helper forwards `turn` on every connect, so the very first marker the page sees is
    // a `running: false`. Keying off the value instead of the transition would ring the bell
    // every time the ball starts.
    assert.equal(ringsFor([{ running: false }]), 0)
    assert.equal(ringsFor([{ running: false }, { running: false }]), 0)
  })

  it('stays quiet when the user stopped the turn', () => {
    assert.equal(ringsFor([{ running: true }, { running: false, interrupted: true }]), 0)
  })

  it('plays again for the next turn', () => {
    assert.equal(ringsFor([{ running: true }, { running: false }, { running: true }, { running: false }]), 2)
  })
})

/**
 * Run the nap clock over a fixed plan, without a page.
 *
 * `napPhaseAt` says which yawn repetition or nap frame is due and `napDelay` says when to
 * look again; together they are the whole schedule. Running the real pair beats re-deriving
 * the arithmetic here, which is how a timeline drifts without anyone noticing.
 * @param yawn - one pass of the yawn and how many times the pre-roll runs, or `null`.
 * @param plan - the nap durations and how many files the config named.
 * @returns `(elapsed) => { phase, delay }`, milliseconds into the rest.
 */
function napClock(
  yawn: { ms: number; times: number } | null,
  plan: { afterMs: number; stepMs: number; count: number },
) {
  const factory = new Function('sleepInfo', `
    let yawnSrc
    const YAWN_PREFETCH_MS = 5000
    ${pageFunction(readFileSync(join(here, '../assets/shell.js'), 'utf8'), 'yawnPlan')}
    ${pageFunction(readFileSync(join(here, '../assets/shell.js'), 'utf8'), 'yawnTotalMs')}
    ${pageFunction(readFileSync(join(here, '../assets/shell.js'), 'utf8'), 'napPhaseAt')}
    ${pageFunction(readFileSync(join(here, '../assets/shell.js'), 'utf8'), 'napDelay')}
    return (elapsed) => {
      const phase = napPhaseAt(elapsed)
      return { phase, delay: napDelay(elapsed, phase) }
    }
  `)
  return factory({ ...plan, yawn }) as (elapsed: number) => {
    phase: { kind: string; index: number } | undefined
    delay: number | null
  }
}

/** The frame the page would put on screen for one nap state, with the mode that carries it. */
function napFrameAt(state: {
  phase?: { kind: string; index: number }
  yawn?: string | null
  frames?: readonly (string | undefined)[]
  onLoadYawn?: () => void
}) {
  const factory = new Function('deps', `
    const { napShown, yawnSrc, sleepFrames, loadYawn, loadSleepFrame } = deps
    ${pageFunction(readFileSync(join(here, '../assets/shell.js'), 'utf8'), 'sleepFrameAt')}
    return sleepFrameAt
  `)
  return factory({
    napShown: state.phase,
    yawnSrc: state.yawn,
    sleepFrames: state.frames ?? [],
    loadYawn: state.onLoadYawn ?? (() => {}),
    loadSleepFrame: () => {},
  })()
}

describe('nap pre-roll', () => {
  const plan = { afterMs: 1_000, stepMs: 1_000, count: 3 }

  /**
   * Run the page's `fetchSleep` against a stubbed bridge and hand back what it kept.
   *
   * `fetchSleep` rebuilds the plan field by field instead of passing it through, so this is
   * where a field the helper sends can go missing without anything else noticing.
   */
  function sleepPlanFrom(reply: unknown) {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const factory = new Function('api', `
      ${pageFunction(shell, 'readYawnPlan')}
      ${pageFunction(shell, 'fetchSleep')}
      return fetchSleep
    `)
    return factory({ memeSleep: async () => reply })() as Promise<Record<string, unknown> | null>
  }

  it('keeps the yawn the helper scheduled', async () => {
    const kept = await sleepPlanFrom({ afterMs: 1_000, stepMs: 2_000, count: 3, yawn: { ms: 4_800, times: 2 } })
    assert.deepEqual(kept, { afterMs: 1_000, stepMs: 2_000, count: 3, yawn: { ms: 4_800, times: 2 } })
    assert.equal((await sleepPlanFrom({ afterMs: 1_000, stepMs: 2_000, count: 3, yawn: null })).yawn, null)
  })

  it('drops a yawn it cannot trust and keeps the nap', async () => {
    for (const yawn of [{ ms: 'soon', times: 2 }, { ms: 0, times: 2 }, { ms: 500, times: 0 }, { ms: 500, times: 1.5 }, {}]) {
      const kept = await sleepPlanFrom({ afterMs: 1_000, stepMs: 2_000, count: 3, yawn })
      assert.equal(kept.yawn, null, JSON.stringify(yawn))
      assert.equal(kept.count, 3, 'the nap itself is still scheduled')
    }
  })

  it('yawns for its own length and then hands over to the nap', () => {
    const clock = napClock({ ms: 500, times: 2 }, plan)
    assert.equal(clock(999).phase, undefined, 'still awake')
    assert.deepEqual(clock(1_000).phase, { kind: 'yawn', index: 0 })
    assert.deepEqual(clock(1_499).phase, { kind: 'yawn', index: 0 }, 'the first pass is still running')
    assert.deepEqual(clock(1_500).phase, { kind: 'yawn', index: 1 })
    assert.deepEqual(clock(1_999).phase, { kind: 'yawn', index: 1 }, 'so is the second')
    assert.deepEqual(clock(2_000).phase, { kind: 'sleep', index: 0 })
    assert.deepEqual(clock(3_000).phase, { kind: 'sleep', index: 1 })
    assert.deepEqual(clock(4_000).phase, { kind: 'sleep', index: 2 })
    assert.deepEqual(clock(99_999).phase, { kind: 'sleep', index: 2 }, 'the last frame holds')
  })

  it('shifts the nap by exactly the length of the pre-roll', () => {
    const withYawn = napClock({ ms: 500, times: 2 }, plan)
    const without = napClock(null, plan)
    const total = 1_000
    for (let elapsed = 2_000; elapsed <= 5_000; elapsed += 100) {
      assert.deepEqual(
        withYawn(elapsed).phase,
        without(elapsed - total).phase,
        `the nap frame at ${elapsed}ms is the one without a yawn at ${elapsed - total}ms`,
      )
    }
  })

  it('wakes at every repetition, then at the handoff, then on the nap steps', () => {
    const clock = napClock({ ms: 500, times: 2 }, plan)
    assert.equal(clock(1_000).delay, 500, 'one pass of the file')
    assert.equal(clock(1_500).delay, 500, 'and the next')
    assert.equal(clock(2_000).delay, 1_000, 'then the first nap step')
    assert.equal(clock(4_000).delay, null, 'the last frame holds until the ball is used')
  })

  it('starts reading the yawn before the nap begins', () => {
    const long = { afterMs: 10_000, stepMs: 10_000, count: 2 }
    const clock = napClock({ ms: 500, times: 2 }, long)
    // The yawn dwarfs every other frame, so reading it only once it fell due would leave the
    // ball sitting on its resting loop for the length of the read.
    assert.equal(clock(0).delay, 5_000, 'the first wake is five seconds ahead of the nap')
    assert.equal(clock(5_000).delay, 5_000, 'the second is the nap itself')
    assert.equal(clock(5_000).phase, undefined)
  })

  it('goes straight to the nap when there is no yawn', () => {
    const long = { afterMs: 10_000, stepMs: 10_000, count: 2 }
    assert.equal(napClock(null, long)(0).delay, 10_000, 'nothing to read, so nothing to prefetch')
    assert.deepEqual(napClock(null, plan)(1_000).phase, { kind: 'sleep', index: 0 })
  })
})

describe('nap frames', () => {
  const YAWN = 'data:image/gif;base64,YAWN'

  it('gives every yawn pass its own mode, so the animation restarts', () => {
    const first = napFrameAt({ phase: { kind: 'yawn', index: 0 }, yawn: YAWN })
    const second = napFrameAt({ phase: { kind: 'yawn', index: 1 }, yawn: YAWN })
    assert.deepEqual(first, { mode: 'yawn-0', src: YAWN })
    assert.deepEqual(second, { mode: 'yawn-1', src: YAWN })
    // Repeating the mode would leave the image element on the loop it already had, so the
    // second pass would never start from the first frame.
    assert.notEqual(first.mode, second.mode)
  })

  it('asks for the yawn once, and gives up quietly when the read fails', () => {
    let loads = 0
    const onLoadYawn = () => { loads += 1 }
    assert.equal(napFrameAt({ phase: { kind: 'yawn', index: 0 }, onLoadYawn }), undefined)
    assert.equal(loads, 1, 'the frame is not there yet, so the resting loop stays')
    // `null` is how a failed read is remembered: the ball falls back instead of retrying.
    assert.equal(napFrameAt({ phase: { kind: 'yawn', index: 0 }, yawn: null, onLoadYawn }), undefined)
    assert.equal(loads, 1)
  })

  it('leaves the awake state and the nap frames alone', () => {
    assert.equal(napFrameAt({}), undefined)
    assert.deepEqual(
      napFrameAt({ phase: { kind: 'sleep', index: 0 }, frames: ['data:image/gif;base64,NAP'] }),
      { mode: 'sleep-0', src: 'data:image/gif;base64,NAP' },
    )
  })
})

describe('wake badge', () => {
  it('tells the user to keep talking while the ball is recording', () => {
    // The engine has already fallen back to `listening` (its detection window is seconds
    // long, a recording lasts until the speaker pauses). The badge used to follow it and ask
    // for the wake word in the middle of the user's own sentence.
    const recording = drawWakeState({ wakeState: 'listening', dictationPhase: 'recording' })
    assert.equal(recording.text, 'wakeRecording')
    assert.equal(recording.classes['wake-detected'], true, 'a live recording wears the green the ball wears on a detection')
    assert.equal(recording.classes['wake-listening'], false)
    assert.equal(recording.classes['wake-recording'], true, 'a live recording is the one phase that reveals the level meter')
  })

  it('says it is transcribing after the microphone is released', () => {
    const transcribing = drawWakeState({ wakeState: 'listening', dictationPhase: 'transcribing' })
    assert.equal(transcribing.text, 'wakeTranscribing')
    assert.equal(transcribing.classes['wake-transcribing'], true)
    assert.equal(transcribing.classes['wake-detected'], false, 'the recording glow is gone once the microphone is')
    assert.equal(transcribing.classes['wake-listening'], false, 'the badge does not go back to asking for the wake word yet')
    assert.equal(transcribing.classes['wake-recording'], false, 'no microphone left, so no meter')
  })

  it('keeps the green badge while the engine still holds a detection', () => {
    const detected = drawWakeState({ wakeState: 'detected' })
    assert.equal(detected.text, 'wakeDetected')
    assert.equal(detected.classes['wake-detected'], true)
  })

  it('lets the dictation phase outrank a stale engine state', () => {
    const both = drawWakeState({ wakeState: 'detected', dictationPhase: 'recording' })
    assert.equal(both.text, 'wakeRecording')
    const stale = drawWakeState({ wakeState: 'detected', dictationPhase: 'transcribing' })
    assert.equal(stale.text, 'wakeTranscribing')
    assert.equal(stale.classes['wake-detected'], false)
  })

  it('asks for the wake word only once no dictation is in flight', () => {
    const idle = drawWakeState({ wakeState: 'listening' })
    assert.equal(idle.text, 'wakeListening')
    assert.equal(idle.classes['wake-listening'], true)
    assert.equal(idle.classes['wake-transcribing'], false)
    const off = drawWakeState({ wakeState: 'disabled' })
    assert.equal(off.text, '', 'a disabled engine shows no badge')
  })
})

describe('wake level waveform', () => {
  it('draws one bar per engine level across the official box', () => {
    const { bars, appended } = drawWaveform()
    // The count comes from the engine's own history length, so the two cannot drift apart and
    // leave the newest levels undrawn.
    assert.equal(bars.length, WAVE_BARS)
    assert.equal(appended, WAVE_BARS)
    assert.equal(bars[0].getAttribute('x1'), '4')
    assert.equal(bars[WAVE_BARS - 1].getAttribute('x1'), String((WAVE_BARS - 1) * 8 + 4))
    for (const bar of bars) {
      assert.equal(bar.getAttribute('x1'), bar.getAttribute('x2'), 'a bar is a vertical line')
      assert.equal(bar.getAttribute('y1'), '19')
      assert.equal(bar.getAttribute('y2'), '21')
      assert.equal(bar.getAttribute('stroke'), 'currentColor')
      assert.equal(bar.getAttribute('stroke-width'), '3')
      assert.equal(bar.getAttribute('stroke-linecap'), 'round')
    }
  })

  it('ramps the bars brighter towards the edge the newest level arrives at', () => {
    const { bars } = drawWaveform()
    assert.equal(bars[0].getAttribute('opacity'), '0.25')
    assert.equal(bars[WAVE_BARS - 1].getAttribute('opacity'), String(0.25 + (WAVE_BARS - 1) / 120))
  })

  it('plots silence as a dotted baseline and speech on the official curve', () => {
    const { bars, page } = drawWaveform()
    page.paint(flat(0))
    assert.equal(bars[0].getAttribute('y1'), '19', 'silence stays a visible baseline')
    assert.equal(bars[0].getAttribute('y2'), '21')
    // 0.1 measures 0.5 through the five-times curve: 1 + 0.5 * 17 = 9.5, so 20 -+ 9.5.
    page.paint(flat(0.1))
    assert.equal(bars[0].getAttribute('y1'), '10.5')
    assert.equal(bars[0].getAttribute('y2'), '29.5')
    // 0.2 and anything louder sit at the ceiling: 1 + 1 * 17 = 18, so 20 -+ 18.
    page.paint(flat(0.2))
    assert.equal(bars[0].getAttribute('y1'), '2')
    assert.equal(bars[0].getAttribute('y2'), '38')
    page.paint(flat(1))
    assert.equal(bars[0].getAttribute('y1'), '2', 'a full-scale level is clamped, not drawn past the box')
    assert.equal(bars[0].getAttribute('y2'), '38')
  })

  it('parks every bar on the baseline once the recording ends', () => {
    const { bars, page } = drawWaveform()
    page.paint(flat(0.5))
    assert.equal(bars[0].getAttribute('y1'), '2')
    page.reset()
    for (const bar of bars) {
      assert.equal(bar.getAttribute('y1'), '19')
      assert.equal(bar.getAttribute('y2'), '21')
    }
  })
})

describe('ball page module', () => {
  it('ends a dictation in one place so no phase can outlive it', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const end = pageFunction(shell, 'endDictation')
    // The badge is only trustworthy if every ending goes through here: an empty utterance, a
    // switched-off engine, a host error, and the watchdog all have to release the recorder and
    // clear the phase together, or the badge keeps claiming a dictation that is over.
    assert.match(end, /dictationBusy = false/)
    assert.match(end, /dictationPhase = undefined/)
    assert.match(end, /syncWake\(\)/, 'the badge is redrawn as soon as the phase clears')
    for (const name of ['startDictation', 'applyTranscript']) {
      assert.match(pageFunction(shell, name), /endDictation\(\)/, `${name} finishes through endDictation`)
    }
    assert.match(pageFunction(shell, 'startDictation'), /setDictationPhase\('recording'\)/)
    assert.match(pageFunction(shell, 'startDictation'), /setDictationPhase\('transcribing'\)/)
  })

  it('releases the recorder on every dictation path that never reaches the host', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const body = pageFunction(shell, 'startDictation')
    // A dictation left "in flight" makes the guard at the top of this function swallow every
    // later wake whole: no recording, no error, not even the closing tone. Three exits used
    // to return without releasing it — the empty utterance, and the two times the engine
    // stops mid-flight — so the release has to be a single `finally` that cannot miss one.
    assert.match(body, /\} finally \{\s*\n\s*if \(!handedOff\) endDictation\(\)/, 'a `finally` releases the recorder for every non-hand-off exit')
    assert.match(body, /let handedOff = false/, 'the hand-off is tracked explicitly')
    assert.match(body, /if \(dictationBusy \|\| typeof api\.dictate !== 'function'\) return/, 'the one-at-a-time guard stays')
  })

  it('says what an empty utterance did instead of going blank', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const body = pageFunction(shell, 'startDictation')
    // The engine has already sounded the give-up cue by then; a blank line next to that tone
    // teaches the user nothing, and used to hide the stuck recorder behind it.
    assert.match(body, /if \(wav === undefined\) \{\s*\n(?:\s*\/\/[^\n]*\n)+\s*status\.textContent = messages\.dictationEmpty/, 'the nothing-heard path names itself')
  })

  it('wires the on-demand read-aloud service end to end', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const preload = readFileSync(join(here, '../preload.cjs'), 'utf8')
    const main = readFileSync(join(here, '../src/main.ts'), 'utf8')
    // Three layers, plus a fourth that is easy to leave out: the speaker has to be handed a way to
    // ask in the first place. Miss any one and the feature degrades to "the play button does
    // nothing", which is exactly how it was reported.
    assert.match(main, /ipcMain\.handle\('orb:speech-ensure'/, 'the helper answers the channel')
    assert.match(preload, /ensureSpeech\(\)\s*\{\s*\n\s*return ipcRenderer\.invoke\('orb:speech-ensure'\)/,
      'the preload exposes it')
    assert.match(shell, /ensure: \(\) => \(typeof api\?\.ensureSpeech/,
      'the speaker is given a way to ask for the service')
  })

  it('starts the service through an absolute interpreter, and notices when it cannot', () => {
    const main = readFileSync(join(here, '../src/main.ts'), 'utf8')
    // A bare `cmd.exe` resolves through PATH, which this process does not reliably have — so spawn
    // fails with ENOENT. Node delivers that as an `error` event rather than by throwing, so a
    // try/catch around spawn() catches nothing and the launch merely looks slow until it times out.
    // That was a real bug here, and it is invisible without these three assertions.
    assert.match(main, /process\.env\.ComSpec/, 'the interpreter must not depend on PATH')
    assert.match(main, /child\.on\('error'/, 'a spawn that never happened has to be reported')
    assert.match(main, /child\.on\('spawn'/, 'and a successful one confirmed, not assumed')
  })

  it('wires the finished-task frame end to end', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const preload = readFileSync(join(here, '../preload.cjs'), 'utf8')
    const main = readFileSync(join(here, '../src/main.ts'), 'utf8')
    // The slot has to be reachable from all three layers, or the page simply never gets a
    // frame and the whole feature is silently absent.
    assert.match(main, /ipcMain\.handle\('orb:meme-done'/, 'the helper answers the channel')
    assert.match(preload, /memeDone\(\)\s*\{\s*\n\s*return ipcRenderer\.invoke\('orb:meme-done'\)/, 'the preload exposes it')
    assert.match(shell, /api\.memeDone\(\)/, 'the page asks for the frame')
    assert.match(shell, /if \(doneFrame === undefined \|\| doneFrame === null\) \{/, 'the frame is loaded with the other named ones')
    assert.match(shell, /playDoneFrame\(\)/, 'something plays it')
    // One shot, prompted by the same step trick the click reaction uses.
    const play = pageFunction(shell, 'playDoneFrame')
    assert.match(play, /doneStep \+= 1/)
    assert.match(play, /Math\.max\(doneFrame\.ms, ONE_SHOT_MIN_MS\)/)
    assert.match(pageFunction(shell, 'syncGif'), /if \(doneShown !== undefined\)/, 'the pose is actually reachable from syncGif')
  })

  it('wires the nap yawn end to end', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const preload = readFileSync(join(here, '../preload.cjs'), 'utf8')
    const main = readFileSync(join(here, '../src/main.ts'), 'utf8')
    assert.match(main, /ipcMain\.handle\('orb:meme-yawn'/, 'the helper answers the channel')
    assert.match(preload, /memeYawn\(\)\s*\{\s*\n\s*return ipcRenderer\.invoke\('orb:meme-yawn'\)/, 'the preload exposes it')
    assert.match(shell, /api\.memeYawn\(\)/, 'the page asks for the frame')
    // Large enough that it must not ride along with the plan the way the skit frames do.
    assert.match(shell, /if \(napShown !== undefined && napShown\.kind === 'sleep'\) await loadSleepFrame/, 'only nap frames pre-load')
    assert.match(pageFunction(shell, 'syncSleep'), /void loadYawn\(\)/, 'the read starts before the nap does')
    assert.match(pageFunction(shell, 'syncGif'), /const nap = sleepFrameAt\(\)/, 'the yawn is reachable from syncGif')
  })

  it('wires the wake reaction end to end', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const preload = readFileSync(join(here, '../preload.cjs'), 'utf8')
    const main = readFileSync(join(here, '../src/main.ts'), 'utf8')
    // The same three layers the other one-shots go through, for the same reason: a slot that
    // is missing from any of them fails silently, and the user just sees nothing happen.
    assert.match(main, /ipcMain\.handle\('orb:meme-wake'/, 'the helper answers the channel')
    assert.match(preload, /memeWake\(\)\s*\{\s*\n\s*return ipcRenderer\.invoke\('orb:meme-wake'\)/, 'the preload exposes it')
    assert.match(shell, /api\.memeWake\(\)/, 'the page asks for the frame')
    assert.match(shell, /if \(wakeFrame === undefined \|\| wakeFrame === null\) \{/, 'the frame is loaded with the other named ones')
    const play = pageFunction(shell, 'playWakeFrame')
    assert.match(play, /wakeStep \+= 1/)
    assert.match(play, /Math\.max\(wakeFrame\.ms, ONE_SHOT_MIN_MS\)/)
    // The frame is normally prefetched, but the first wake after a restart can beat the burst
    // cycle to it. Waiting for a poll timer before acknowledging your own name is not on.
    assert.match(play, /void fetchWake\(\)\.then\(/, 'a frame that has not arrived yet is fetched on demand rather than skipped')
    const gif = pageFunction(shell, 'syncGif')
    assert.match(gif, /if \(wakeShown !== undefined\)/, 'the pose is actually reachable from syncGif')
    // Precedence is a deliberate order, not an accident of layout: a click is still what the
    // user just did with their hand, while a wake reaction has to outrank a task that happened
    // to finish in the same second — otherwise the acknowledgement they are waiting for before
    // they speak gets swallowed by the previous turn.
    assert.ok(gif.indexOf('clickShown !== undefined') < gif.indexOf('wakeShown !== undefined'), 'a click still outranks the wake reaction')
    assert.ok(gif.indexOf('wakeShown !== undefined') < gif.indexOf('doneShown !== undefined'), 'the wake reaction outranks a turn that just ended')
    // Only the wake word plays it. A frame fired from anywhere else would be answering a
    // question the user never asked.
    const status = pageFunction(shell, 'applyWakeStatus')
    const gate = status.indexOf("if (wakeState !== 'detected') return")
    assert.notEqual(gate, -1, 'the detected check is still the gate')
    assert.ok(status.indexOf('playWakeFrame()') > gate, 'it plays past the detected gate and not before it')
  })

  it('wires the dictation pose to the recording, and only to it', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const preload = readFileSync(join(here, '../preload.cjs'), 'utf8')
    const main = readFileSync(join(here, '../src/main.ts'), 'utf8')
    assert.match(main, /ipcMain\.handle\('orb:meme-voice'/, 'the helper answers the channel')
    assert.match(preload, /memeVoice\(\)\s*\{\s*\n\s*return ipcRenderer\.invoke\('orb:meme-voice'\)/, 'the preload exposes it')
    assert.match(shell, /api\.memeVoice\(\)/, 'the page asks for the frame')
    assert.match(shell, /await loadVoiceFrame\(\)/, 'the frame is loaded with the other named ones')
    // The pose is chosen from the dictation phase, so both edges of that phase have to repaint:
    // a phase that changes without one leaves the ball wearing the face it had before.
    const phase = pageFunction(shell, 'setDictationPhase')
    assert.match(phase, /syncGif\(\)/, 'every phase change repaints')
    // The opening edge is `setDictationPhase`; the closing one is `endDictation`, and that is the
    // one every ending actually travels — an empty utterance, a switched-off engine, a host that
    // never answered. It has to repaint for the same reason: clearing the phase without redrawing
    // leaves the ball nodding at a listener that has gone back to listening.
    const end = pageFunction(shell, 'endDictation')
    assert.match(end, /dictationPhase = undefined/, 'the closing edge clears the phase')
    assert.match(end, /syncGif\(\)/, 'the closing edge repaints too')
    // And the first wake after a restart can beat the prefetch timer, so recording starts it too.
    assert.match(phase, /if \(voiceSrc === undefined\) void loadVoiceFrame\(\)/, 'a wake that beats the prefetch still gets a pose')
    const gif = pageFunction(shell, 'syncGif')
    assert.match(gif, /if \(voiceSrc !== undefined && \(dictationPhase === 'recording' \|\| dictationPhase === 'transcribing'\)\)/, 'the pose is gated on the dictation itself')
    // Where it sits is a deliberate order rather than an accident of layout: below the agent's
    // own frames, so a turn still streaming keeps its face while the user dictates the next
    // message, and above the pointer, so a resting mouse cannot hide the microphone.
    assert.ok(gif.indexOf("agentState === 'thinking'") < gif.indexOf('voiceSrc !== undefined'), 'the agent keeps its face while it works')
    assert.ok(gif.indexOf('voiceSrc !== undefined') < gif.indexOf('hoverSrc !== undefined && hovering'), 'the microphone outranks the pointer')
  })

  it('gives the ball back its resting loop instead of an open panel holding the avatar', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const gif = pageFunction(shell, 'syncGif')
    // The open panel used to take the avatar face unconditionally. With `autoExpandOnWake` the
    // panel opens itself on every wake, so a profile whose avatar is a loop sat on that loop
    // forever and never reached `idle` — which is exactly what the user saw after the wake
    // animation finished. A configured loop now outranks the bare panel.
    const from = gif.indexOf('const play =')
    assert.notEqual(from, -1, 'the play branch is still there')
    const play = gif.slice(from, from + 300)
    assert.match(play, /expanded && idleSrc === undefined/, 'the open panel only falls back to the avatar when there is no loop to show')
    assert.equal(/\bexpanded \|\|/.test(play), false, 'the panel alone no longer wins')
  })

  it('asks for nothing before the panel opens, because the window no longer changes size', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const preload = readFileSync(join(here, '../preload.cjs'), 'utf8')
    const main = readFileSync(join(here, '../src/main.ts'), 'utf8')
    // The old arrangement asked for the corner first, wore it, and only then let the window grow.
    // The window is the overlay rect in both states now, so there is no resize to be one frame
    // early for, and the channel that existed only to serve it is gone.
    assert.equal(/orb:expand-corner/.test(main), false, 'the pre-resize corner channel is gone')
    assert.equal(/expandCorner/.test(preload), false, 'and so is the preload method')
    assert.equal(/expandCorner/.test(shell), false, 'and the page no longer asks for it')
    const expand = pageFunction(shell, 'setExpanded')
    // What is left has to be a plain open: state, direction, done. An extra round trip before the
    // panel appears would be a frame of delay for information nobody needs any more. Only the open
    // branch is looked at — the close has always had to call back, since it waits out the
    // animation — so the slice stops where the open stops.
    const opening = expand.slice(expand.indexOf('await api.setExpanded(true)'), expand.indexOf('if (!force'))
    assert.equal(/await api\./.test(opening.replace(/await api\.setExpanded\(true\)/, '')), false,
      'opening the panel is a single call')
    assert.match(expand, /await api\.setExpanded\(true\)/, 'which is the open itself')
    // The direction still comes back from the helper, because only the helper knows where the
    // ball ended up after a drag across displays.
    assert.match(expand, /applyDirection\(state\)/, 'and the answer still says which column to use')
  })

  it('wears the direction before anything is drawn, not just while the panel is open', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const main = readFileSync(join(here, '../src/main.ts'), 'utf8')
    const preload = readFileSync(join(here, '../preload.cjs'), 'utf8')
    // The ball is only ever positioned by the direction classes now — the resting window is the
    // overlay rect, so the base rules would put it in the panel's corner. That makes the very first
    // frame depend on them, which is why the corner is asked for as a read at startup instead of
    // being learned from the first open.
    assert.match(main, /ipcMain\.handle\('orb:direction'/, 'the helper answers the channel')
    assert.match(main, /return placement\.currentDirection\(\)/, 'and answers it from the placement')
    assert.match(preload, /direction\(\)\s*\{\s*\n\s*return ipcRenderer\.invoke\('orb:direction'\)/, 'the preload exposes it')
    const startup = shell.slice(0, shell.indexOf('let expanded = false'))
    assert.match(startup, /applyDirection\(/, 'the page wears a direction before it has any state')
    // Both sides of the round trip: a default to draw the first frame with, and the real answer
    // to correct it. The default is the corner a fresh profile starts in, so on a default profile
    // the correction changes nothing and nothing is ever drawn in the wrong column.
    assert.match(shell, /api\.direction\(\)\.then\(/, 'the real corner is asked for as well')
  })

  it('lets clicks through the empty part of the window, by polling the pointer in the helper', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const preload = readFileSync(join(here, '../preload.cjs'), 'utf8')
    const main = readFileSync(join(here, '../src/main.ts'), 'utf8')
    // The cost of a window that never resizes is that it is mostly empty space sitting over the
    // desktop, and it has to be transparent to clicks.
    //
    // Who decides is the whole design, and the obvious answer is wrong. The page knows where its
    // elements are, so it looks like the page's call: hit-test itself, report "the pointer is on
    // me", and let the helper act. That was built, and it does not work — a click-through window
    // delivers no `mousemove` to the renderer at all, `forward: true` notwithstanding, so the page
    // never learns the pointer arrived and the ball stays unclickable forever. Measured on the
    // real machine: the page's move counter sat at zero while the pointer crossed the ball.
    //
    // So the helper polls instead, and the page is asked only for geometry.
    assert.match(main, /ipcMain\.on\('orb:hit-test'/, 'the helper listens for the regions')
    assert.match(main, /setInterval\(/, 'and polls the pointer itself')
    assert.match(main, /screen\.getCursorScreenPoint\(\)/, 'which it can read whatever the window is doing')
    assert.match(main, /setIgnoreMouseEvents\(!over, \{ forward: true \}\)/, 'turning click-through on away from them')
    assert.match(main, /setHitTest\(created, false\)/, 'and the window starts transparent to clicks')
    // The regions are geometry, in the space the poll reads.
    assert.match(preload, /setHitTest\(regions\)\s*\{\s*\n\s*ipcRenderer\.send\('orb:hit-test', Array\.isArray\(regions\)/, 'the preload forwards them')
    assert.match(pageFunction(shell, 'syncHitTest'), /window\.screenX/, 'reported in screen coordinates')
    for (const element of ['ball', 'panel', 'stop', 'dockTab']) {
      assert.match(pageFunction(shell, 'syncHitTest'), new RegExp(`\\b${element}\\b`), `${element} captures over itself`)
    }
    // A drag overrides it: the window must not go transparent out from under a drag in progress,
    // or the drag stops responding exactly when the pointer outruns the ball.
    assert.match(pageFunction(shell, 'syncHitTest'), /pointer !== undefined \|\| dragging/, 'a drag widens the regions to the whole window')
    assert.match(shell, /ball\.addEventListener\('pointerdown'[\s\S]*?syncHitTest\(\)/, 'reported when the drag starts')
    assert.match(pageFunction(shell, 'finishPointer'), /syncHitTest\(\)/, 'and again when it ends')
  })

  it('tells the page when the pointer crosses the capture line, not only when it moves', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const preload = readFileSync(join(here, '../preload.cjs'), 'utf8')
    const main = readFileSync(join(here, '../src/main.ts'), 'utf8')
    // The poll moves the window between capturing and click-through, but the panel is opened and
    // closed by `pointerenter`/`pointerleave`, and those describe *movement*. A pointer that crosses
    // the line and stops — a fast flick, a tap, a touchpad jump — produces no event afterwards, so
    // the page is left holding the answer from before the crossing: the panel stays open with the
    // pointer gone, or stays shut with the pointer resting on the ball, until the user moves again.
    //
    // The helper is the only party that knows the crossing happened, because it is the one that
    // changes the window's mouse behaviour. So it says so, and it says where the pointer is.
    // Sliced to the function rather than matched loosely: `[\s\S]*?` between the two calls would
    // also match them in different functions, and would keep matching after the call is moved out.
    const setHitTest = /function setHitTest\([\s\S]*?\n\}/.exec(main)?.[0] ?? ''
    assert.notEqual(setHitTest, '', 'setHitTest is there to slice')
    assert.match(setHitTest, /setIgnoreMouseEvents\(!over, \{ forward: true \}\)/, 'it is what turns click-through on')
    assert.match(setHitTest, /sendPointer\(over\)/, 'and the crossing is announced from inside it')
    assert.match(setHitTest, /if \(hitTestOver === over\) return/, 'only on a real change, so a steady pointer is not spammed')
    assert.match(main, /win\.webContents\.send\('orb:pointer', null\)/, 'off the window is said plainly, not left to the last position')
    assert.match(main, /screen\.getCursorScreenPoint\(\)[\s\S]*?getContentBounds\(\)/,
      'and the position comes from the pointer, converted through the window the page measures in')
    assert.match(preload, /onPointer\(callback\)[\s\S]*?ipcRenderer\.on\('orb:pointer'/, 'the preload carries it across')
    // The page reuses the test it already has, so there is one answer to "is the pointer on us"
    // rather than two that can disagree about the same point.
    const handler = /api\.onPointer\(\(point\) => \{[\s\S]*?\n  \}\)/.exec(shell)?.[0] ?? ''
    assert.notEqual(handler, '', 'the page listens for it')
    assert.match(handler, /pointerOnBallOrPanel\(\)/, 'and decides with the same test the events use')
    assert.match(handler, /enterUi\(\)[\s\S]*?else leaveUi\(\)/, 'opening and closing on the same terms')
    assert.match(handler, /point === null[\s\S]*?leaveUi\(\)/, 'leaving is unconditional, since a null point is never on the ball')
  })

  it('reports the capture regions whenever the layout moves them', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    // The regions are only as good as the last report. Anything that moves or shows an element has
    // to re-report, or the helper keeps capturing over where the element used to be — which for the
    // docked case means capturing a 6px tab's worth of nothing, and for the panel means a sheet of
    // dead desktop the size of the card.
    assert.match(pageFunction(shell, 'applyDocked'), /syncHitTest\(\)/, 'docking re-reports, on both branches')
    const docked = pageFunction(shell, 'applyDocked')
    assert.equal((docked.match(/syncHitTest\(\)/g) ?? []).length, 2, 'including the undocking branch')
    const expand = pageFunction(shell, 'setExpanded')
    assert.match(expand, /syncHitTest\(\)/, 'and so does opening and closing the panel')
    // The badge sits over the ball and is a label, so it must not be what a hit test finds there.
    const floating = readFileSync(join(here, '../assets/floating.css'), 'utf8')
    assert.match(floating, /#wake-badge \{[^}]*pointer-events: none/s, 'the label over the ball is transparent to the pointer')
  })

  it('leaves nothing holding the ball across an open', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    // The previous attempt pinned the ball's screen position with a transform on every resize. It
    // could not have worked: the frame that flashed was painted from the collapsed layout before
    // that transform was so much as committed, so the ball was put right only after the wrong
    // frame had already reached the screen. Nothing needs holding now that there is no resize —
    // and a transform fighting the layout is worse than none, `move()` is the one thing allowed to
    // place the ball while a drag is in progress.
    assert.equal(/ballPin|anchorBall|pinBallToAnchor|releaseBall/.test(shell), false, 'the pin is gone')
    assert.equal(/addEventListener\('resize'/.test(shell), false, 'and so is the handler that drove it')
    const direction = pageFunction(shell, 'applyDirection')
    assert.match(direction, /classList\.toggle\('expand-left'/, 'the direction is what places the ball')
    assert.match(direction, /classList\.toggle\('expand-up'/, 'on both axes')
  })

  it('opens the panel only when the pointer is on the ball, not anywhere in the window', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    // Hover used to mean "the pointer entered the body", which was the same as "entered the ball"
    // when the resting window was the ball and its insets. Now the body is 742x544, so that test
    // would open the panel from anywhere in the rectangle — which sits over the user's desktop.
    const move = shell.slice(shell.indexOf("addEventListener('pointermove'"), shell.indexOf("addEventListener('pointerleave'"))
    assert.match(move, /pointerOnBallOrPanel\(\)/, 'the pointer move is tested against the ball, not the window')
    assert.match(move, /enterUi\(\)/, 'and only crossing onto it opens the panel')
    assert.match(move, /leaveUi\(\)/, 'while crossing off it collapses')
    // The panel counts as hovered too, or crossing the 10px gap between ball and panel would
    // collapse the panel the pointer is travelling towards.
    assert.match(pageFunction(shell, 'pointerOnBallOrPanel'), /getBoundingClientRect/, 'the open panel is part of the hover region')
    // Entering the *window* is not entering the ball. `pointerenter` on the body fires from
    // anywhere in a 742x544 rectangle, which sits over the user's desktop, so the handler has to
    // ask where the pointer actually is before opening anything.
    const enter = shell.slice(shell.indexOf("addEventListener('pointerenter'"), shell.indexOf("addEventListener('pointermove'"))
    assert.match(enter, /pointerOnBallOrPanel\(\)/, 'entering the window is not entering the ball')
    assert.match(enter, /enterUi\(\)/, 'and only the ball opens the panel')
    // This is only reachable because the helper polls the pointer and keeps the window capturing
    // over the ball. An earlier version had the page decide, and a click-through window receives no
    // enter event at all — the panel could not open, and the source looked correct throughout.
    assert.match(enter, /if \(!pointerOnBallOrPanel\(\)\) return/, 'the enter is gated rather than assumed')
  })

  it('imports the transcript model from the helper page', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const html = readFileSync(join(here, '../assets/floating.html'), 'utf8')
    assert.match(shell, /from '\.\/transcript-model\.js'/)
    assert.match(shell, /reasoningSummary\(/)
    assert.match(shell, /processLabel\(/)
    assert.match(html, /type="module" src="shell\.js"/)
  })

  it('wires message copy buttons and the usage pill into both message kinds', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const chat = readFileSync(join(here, '../assets/chat.css'), 'utf8')
    assert.match(shell, /messageCopyButton\(/)
    assert.match(shell, /className = 'user-actions'/)
    assert.match(shell, /className = 'am-actions'/)
    assert.match(shell, /usagePill\(/)
    assert.match(chat, /\.msg-copy/)
    assert.match(chat, /\.am-usage/)
    // Transcript prose stays selectable; the global sheet keeps chrome unselectable.
    const floating = readFileSync(join(here, '../assets/floating.css'), 'utf8')
    assert.match(floating, /#transcript \{[^}]*user-select: text/s)
  })
})
