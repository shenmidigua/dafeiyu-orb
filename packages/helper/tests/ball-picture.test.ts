/**
 * The two ways the ball loses its picture, and the reason both are gated.
 *
 * The ball is one `<img>` that is handed a new source constantly, and an element with nothing to draw
 * paints a box of its own: a small broken-image glyph in the top-left corner, inside a white-edged
 * rectangle. Docked and peeked — the ball half out of the screen edge on a hover of the strip — that box
 * is on screen for the whole 120 ms between the peek appearing and the entrance clip landing, which is
 * the flash this file pins.
 *
 * `armBallPicture` closes the window by keeping `ball-drawn` off the body until a decode has finished,
 * and the stylesheet hides `#ball-gif` while that class is absent. The subtlety, and the whole reason
 * this file exists, is that there are two ways the picture is taken away and only one of them assigns
 * `src`:
 *
 *   * every face in `syncGif` assigns it, and the shadowed setter clears `ball-drawn` first;
 *   * the docked peek *removes* the attribute, which is not a `src` assignment at all.
 *
 * Measured in Chromium, that removal leaves `complete` true and `naturalWidth` 0 and fires **no** event,
 * so nothing ever cleared the class and the box was painted. The element here is built with the same
 * prototype split the browser has — `src` and `removeAttribute` on `HTMLImageElement.prototype`, the
 * class on `document.body` — so the shadow is exercised rather than stubbed away.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')

/** A named `function name(...) { … }` cut out by brace matching, the way the other page tests do. */
function pageFunction(name: string): string {
  const found = new RegExp(`(?:^|[^\\w$])(?:async )?function ${name}\\(`).exec(shell)
  assert.notEqual(found, null, `${name} is missing from the page`)
  const head = found.index + (found[0].startsWith('async ') ? 'async '.length : 0)
  const open = shell.indexOf('{', head)
  let depth = 0
  for (let i = open; i < shell.length; i += 1) {
    if (shell[i] === '{') depth += 1
    else if (shell[i] === '}') {
      depth -= 1
      if (depth === 0) return shell.slice(head, i + 1)
    }
  }
  throw new Error(`${name} never closes`)
}

interface Ball {
  readonly drawn: boolean
  /** `hasAttribute('src')`, which is how "the peek stripped the picture" is read. */
  readonly hasSrc: boolean
  /** The URL the element is on, or undefined while it has no source. */
  readonly shown: string | undefined
  /**
   * `removeAttribute` as the element now carries it, if `armBallPicture` installed one; `undefined`
   * means the removal would go straight to the prototype, where nothing is watching the picture.
   */
  readonly ownerRemoveAttribute: unknown
  /** Any attribute removal, the way the page and its helpers make them. */
  removeAttribute(name: string): void
  setSrc(value: string): void
  removeSrc(): void
  /** Finish the decode the last source started — the `load` event, from the engine's side. */
  finishLoad(): void
  /** Fail it — the `error` event, which is what a source that cannot be decoded produces. */
  failDecode(): void
  /** Let the events a real element queues as tasks run. */
  settle(): Promise<void>
}

/**
 * One `#ball-gif` and one `document.body`, as the page's own `armBallPicture` finds them.
 *
 * The prototype is the point: `src` is an accessor and `removeAttribute` is a method *there*, so
 * shadowing either of them on the element is what the page does rather than a convenience this test
 * invented. `complete` and `naturalWidth` follow what a decode does — they are the readings the real
 * element gives, and the ones the earlier probes used to catch the box.
 */
function page(options: { drawn?: boolean } = {}): Ball {
  const proto = {
    _src: undefined as string | undefined,
    complete: false,
    naturalWidth: 0,
    get src(): string | undefined {
      return this._src
    },
    set src(value: string | undefined) {
      // A real assignment resets the decode: the element is not complete until the new source has one.
      this._src = value
      this.complete = false
      this.naturalWidth = 0
    },
    removeAttribute(name: string): void {
      if (name === 'src') {
        this._src = undefined
        this.complete = true
        this.naturalWidth = 0
      }
    },
  }
  const ball = Object.create(proto) as Ball & {
    _src?: string
    complete: boolean
    naturalWidth: number
    addEventListener(type: string, listener: () => void): void
    dispatch(type: string): void
  }
  const listeners = new Map<string, (() => void)[]>()
  ball.addEventListener = (type, listener) => {
    const found = listeners.get(type) ?? []
    found.push(listener)
    listeners.set(type, found)
  }
  ball.dispatch = (type) => {
    for (const listener of listeners.get(type) ?? []) listener()
  }

  const classes = new Set<string>(options.drawn === true ? ['ball-drawn'] : [])
  const document = {
    querySelector: (selector: string) => (selector === '#ball-gif' ? ball : null),
    body: {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        contains: (name: string) => classes.has(name),
      },
    },
  }

  // The page's own function, over this element: nothing about the gate is restated here.
  new Function('document', 'setTimeout', `${pageFunction('armBallPicture')}\narmBallPicture()`)(document, setTimeout)

  return {
    get drawn() {
      return classes.has('ball-drawn')
    },
    get hasSrc() {
      return ball._src !== undefined
    },
    get shown() {
      return ball._src
    },
    get ownerRemoveAttribute() {
      return Object.getOwnPropertyDescriptor(ball, 'removeAttribute')?.value
    },
    removeAttribute: (name) => {
      ball.removeAttribute(name)
    },
    setSrc: (value) => {
      ball.src = value
    },
    removeSrc: () => {
      ball.removeAttribute('src')
    },
    finishLoad: () => {
      ball.complete = true
      ball.naturalWidth = 512
      ball.dispatch('load')
    },
    failDecode: () => {
      ball.dispatch('error')
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  }
}

describe('the ball is hidden for exactly as long as it has no picture to draw', () => {
  it('draws at once when the element already has a decoded picture', () => {
    // `complete` and a non-zero `naturalWidth` is a bitmap in hand, which is the state the page starts
    // in: the avatar was loaded with the markup, long before `armBallPicture` ran.
    const ball = page({ drawn: false })
    ball.setSrc('idle.gif')
    ball.finishLoad()
    assert.equal(ball.drawn, true, 'a decoded picture is not drawn')
  })

  it('goes undrawn the instant a new source is assigned, and drawn again when it lands', async () => {
    const ball = page()
    ball.setSrc('idle.gif')
    ball.finishLoad()
    assert.equal(ball.drawn, true)

    ball.setSrc('dock-arrive-1.gif')
    // Synchronously, in the same task as the assignment: the box exists from the moment the source
    // changes, so a hide queued behind it would be a hide one frame too late.
    assert.equal(ball.drawn, false, 'the swap left the old picture marked as drawn')

    ball.finishLoad()
    assert.equal(ball.drawn, true, 'the arrival was not shown once it had decoded')
  })

  it('goes undrawn when the source is removed, which is what the docked peek does', async () => {
    const ball = page()
    ball.setSrc('idle.gif')
    ball.finishLoad()

    // The peek's own line, from `openDockPeek`. Chromium fires no event for it, so if this is not the
    // place that clears the class, nothing does — and the broken-image box is what is painted for the
    // whole dwell, which is the flash.
    ball.removeSrc()
    assert.equal(ball.drawn, false, 'stripping the source left the element marked as drawn')
    assert.equal(ball.hasSrc, false, 'and the attribute is still gone, as every reader expects')

    await ball.settle()
    assert.equal(ball.drawn, false, 'no event arrives to correct it, so the gate has to be the removal')

    ball.setSrc('dock-arrive-1.gif')
    ball.finishLoad()
    assert.equal(ball.drawn, true, 'the entrance could not bring the picture back')
  })

  it('gates the removal on the element, and leaves a removal of anything else alone', () => {
    const ball = page()
    ball.setSrc('idle.gif')
    ball.finishLoad()

    // The shadow is on this element, over the prototype's own method, so the box is still in the page
    // and still answering `hasAttribute` the way it always did.
    assert.equal(typeof ball.ownerRemoveAttribute, 'function',
      'nothing on the element watches the picture being taken away')

    // `dataset` and `title` are removed on this page too, and neither of them is the picture.
    ball.removeAttribute('data-mode')
    ball.removeAttribute('title')
    assert.equal(ball.drawn, true, 'an unrelated attribute removal hid the ball')
  })

  it('stays undrawn for a source that fails, because there is nothing honest to paint', () => {
    const ball = page()
    ball.setSrc('idle.gif')
    ball.finishLoad()

    ball.setSrc('missing.gif')
    ball.failDecode()
    assert.equal(ball.drawn, false, 'a source that cannot decode left the ball marked as drawn')
  })
})
