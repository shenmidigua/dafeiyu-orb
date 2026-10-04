/**
 * Floating-ball window geometry.
 * One window holds both: the ball keeps its own column and the panel card sits beside it,
 * separated by `PANEL_GAP`. The card is a plain rectangle — it no longer wraps the ball, so
 * nothing is ever drawn on top of the input box.
 */

export const BALL_SIZE = 288
export const PANEL_SIZE = { width: 420, height: 520 } as const
/** Space between the ball's column and the panel card. Mirrored by `--panel-gap` in the CSS. */
export const PANEL_GAP = 10
export const CHROME_INSET = 12
export const BALL_WINDOW_SIZE = BALL_SIZE + 2 * CHROME_INSET
export const PANEL_WINDOW_SIZE = {
  width: PANEL_SIZE.width + PANEL_GAP + BALL_SIZE + 2 * CHROME_INSET,
  height: Math.max(PANEL_SIZE.height, BALL_SIZE) + 2 * CHROME_INSET,
} as const
export const BELOW_CENTER = 0.08
/**
 * How far the ball has to hang past a display edge before a release docks it.
 * Half the ball: a fifth (the old value) docked on ordinary drags near the edge, which
 * looks exactly like "the ball did not stay where I let go of it".
 */
export const DOCK_OVERLAP = Math.round(BALL_SIZE / 2)
export const DOCK_DRAG_OFF = Math.round(BALL_SIZE / 3)
export const DOCK_TAB_WIDTH = 6
export const DOCK_GLOW = 8
export const DOCK_HOVER_MARGIN = 20
export const DOCK_HIT_WIDTH = DOCK_TAB_WIDTH + DOCK_GLOW + DOCK_HOVER_MARGIN
export const DOCK_HIT_HEIGHT = BALL_SIZE + 2 * DOCK_GLOW
export const DOCK_OFF_GAP = 2
export const DOCK_IN_PAD = 5
export const DOCK_SLIDE_OFF_MS = 250
export const DOCK_SLIDE_IN_MS = 300

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type HorizontalExpand = 'left' | 'right'
export type VerticalExpand = 'up' | 'down'
export type DockSide = 'left' | 'right'

export interface ExpandState {
  readonly expanded: boolean
  readonly horizontal: HorizontalExpand
  readonly vertical: VerticalExpand
  readonly docked: DockSide | undefined
}

export interface DockState {
  readonly docked: DockSide | undefined
}

export interface DisplayPair {
  readonly bounds: Rect
  readonly workArea: Rect
}

interface Direction {
  horizontal: HorizontalExpand
  vertical: VerticalExpand
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * The window rect for a ball at rest, which is the overlay rect in both states.
 *
 * This window used to be the ball plus its chrome, and opening the panel resized it. That resize
 * is what put the ball in the panel's top-left corner for one frame: a window that has just grown
 * is still presenting the surface it had while small, laid at its *new* origin, and the ball sat
 * at that old surface's own top-left. No page-side change can prevent it, because the page's
 * layout was already correct on every one of those frames — measured on the real machine, the
 * ball never left its resting screen position while the pointer arrived.
 *
 * So the window is never resized. A ball's screen position is `window origin + its offset inside
 * the window`, and holding both of those fixed across a collapse means the ball cannot move and
 * there is no resize to present a stale surface. Expanding then becomes a pure repaint.
 *
 * A resting window is therefore bigger than the ball and mostly empty. That emptiness has to be
 * transparent to clicks, which the page arranges by reporting what the pointer is over — see
 * `orb:hit-test` in the main process.
 */
function restingWindowBounds(ball: { readonly x: number; readonly y: number }, workArea: Rect): Rect {
  return expandedOverlayBounds(ball, workArea)
}

function clampWindowOrigin(value: number, workOrigin: number, workSize: number, windowSize: number): number {
  return clamp(value, workOrigin - CHROME_INSET, workOrigin + workSize - windowSize + CHROME_INSET)
}

/**
 * Which outer display edge the ball already overlaps by about one fifth of its width.
 * An edge that touches another display is a seam, not a place to dock.
 */
export function dockSideForBallOrigin(
  ball: { readonly x: number; readonly y: number },
  bounds: Rect,
  displays: readonly Rect[] = [],
): DockSide | undefined {
  const leftOverlap = bounds.x - ball.x
  const rightOverlap = ball.x + BALL_SIZE - (bounds.x + bounds.width)
  let side: DockSide | undefined
  if (leftOverlap >= DOCK_OVERLAP && leftOverlap >= rightOverlap) side = 'left'
  else if (rightOverlap >= DOCK_OVERLAP) side = 'right'
  if (side === undefined || edgeTouchesDisplay(side, bounds, displays)) return undefined
  return side
}

function edgeTouchesDisplay(side: DockSide, bounds: Rect, displays: readonly Rect[]): boolean {
  const edge = side === 'left' ? bounds.x : bounds.x + bounds.width
  for (const other of displays) {
    if (sameRect(other, bounds)) continue
    const otherEdge = side === 'left' ? other.x + other.width : other.x
    if (Math.abs(otherEdge - edge) > 8) continue
    const top = Math.max(bounds.y, other.y)
    const bottom = Math.min(bounds.y + bounds.height, other.y + other.height)
    if (bottom > top) return true
  }
  return false
}

function sameRect(left: Rect, right: Rect): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
}

/** Hittable strip for a docked tab, flush with a display edge. */
export function dockedTabBounds(side: DockSide, ballY: number, bounds: Rect): Rect {
  const y = clamp(Math.round(ballY - DOCK_GLOW), bounds.y, bounds.y + bounds.height - DOCK_HIT_HEIGHT)
  return {
    x: side === 'left' ? bounds.x : bounds.x + bounds.width - DOCK_HIT_WIDTH,
    y,
    width: DOCK_HIT_WIDTH,
    height: DOCK_HIT_HEIGHT,
  }
}

/** Panel growth that keeps the expanded overlay on the open side of the ball. */
export function expandDirection(
  ball: { readonly x: number; readonly y: number },
  workArea: Rect,
): Direction {
  const centerX = ball.x + BALL_SIZE / 2
  const horizontal: HorizontalExpand = centerX - workArea.x > workArea.width / 2 ? 'left' : 'right'
  const vertical: VerticalExpand = ball.y - workArea.y < PANEL_SIZE.height - BALL_SIZE ? 'down' : 'up'
  return { horizontal, vertical }
}

/** Ball top-left recovered from an expanded window and its growth direction. */
export function ballOriginFromWindow(bounds: Rect, direction: Direction): { x: number; y: number } {
  return {
    x: direction.horizontal === 'left'
      ? bounds.x + bounds.width - CHROME_INSET - BALL_SIZE
      : bounds.x + CHROME_INSET,
    y: direction.vertical === 'up'
      ? bounds.y + bounds.height - CHROME_INSET - BALL_SIZE
      : bounds.y + CHROME_INSET,
  }
}

/** Keep a 144px ball fully inside a work area. */
export function clampedBallOrigin(
  ball: { readonly x: number; readonly y: number },
  workArea: Rect,
): { x: number; y: number } {
  return {
    x: clamp(ball.x, workArea.x, workArea.x + workArea.width - BALL_SIZE),
    y: clamp(ball.y, workArea.y, workArea.y + workArea.height - BALL_SIZE),
  }
}

/**
 * Where the ball may rest after a release: its own position, as long as most of it stays
 * reachable. The old release path forced the *whole* ball back into the work area, which
 * moved a ball let go near an edge or over the taskbar — the user's "it did not stay where
 * I released it". Only a ball that is mostly off-screen is pulled back.
 */
export function keepBallReachable(
  ball: { readonly x: number; readonly y: number },
  workArea: Rect,
): { x: number; y: number } {
  const visible = Math.round(BALL_SIZE * 0.5)
  const slack = BALL_SIZE - visible
  return {
    x: clamp(ball.x, workArea.x - slack, workArea.x + workArea.width - visible),
    y: clamp(ball.y, workArea.y - slack, workArea.y + workArea.height - visible),
  }
}

/** Collapsed origin on the work-area right edge, slightly below vertical center. */
export function defaultFloatingBallOrigin(workArea: Rect): { x: number; y: number } {
  const x = workArea.x + workArea.width - BALL_SIZE
  const centerY = workArea.y + (workArea.height - BALL_SIZE) / 2
  const y = centerY + workArea.height * BELOW_CENTER
  return clampedBallOrigin({ x: Math.round(x), y: Math.round(y) }, workArea)
}

function overlayBoundsFromBall(ball: { readonly x: number; readonly y: number }, direction: Direction): Rect {
  return {
    // Leftward: the ball keeps the right column, so the window reaches the panel's width
    // plus the gap beyond the ball's own left edge.
    x: direction.horizontal === 'left'
      ? ball.x - (PANEL_SIZE.width + PANEL_GAP) - CHROME_INSET
      : ball.x - CHROME_INSET,
    y: direction.vertical === 'up'
      ? ball.y - (PANEL_SIZE.height - BALL_SIZE) - CHROME_INSET
      : ball.y - CHROME_INSET,
    width: PANEL_WINDOW_SIZE.width,
    height: PANEL_WINDOW_SIZE.height,
  }
}

function expandedOverlayBounds(ball: { readonly x: number; readonly y: number }, workArea: Rect): Rect & Direction {
  const direction = expandDirection(ball, workArea)
  const unclamped = overlayBoundsFromBall(ball, direction)
  return {
    x: clampWindowOrigin(unclamped.x, workArea.x, workArea.width, unclamped.width),
    y: clampWindowOrigin(unclamped.y, workArea.y, workArea.height, unclamped.height),
    width: unclamped.width,
    height: unclamped.height,
    ...direction,
  }
}

function clampBallY(ballY: number, bounds: Rect): number {
  return clamp(Math.round(ballY), bounds.y, bounds.y + bounds.height - BALL_SIZE)
}

function offScreenBallOrigin(side: DockSide, ballY: number, bounds: Rect): { x: number; y: number } {
  const y = clampBallY(ballY, bounds)
  return {
    x: side === 'left'
      ? bounds.x - BALL_SIZE - DOCK_OFF_GAP
      : bounds.x + bounds.width + DOCK_OFF_GAP,
    y,
  }
}

function insideBallOrigin(
  side: DockSide,
  ballY: number,
  display: DisplayPair,
): { x: number; y: number } {
  return {
    x: side === 'left'
      ? display.bounds.x + DOCK_IN_PAD
      : display.bounds.x + display.bounds.width - BALL_SIZE - DOCK_IN_PAD,
    y: clamp(
      Math.round(ballY),
      display.workArea.y,
      display.workArea.y + display.workArea.height - BALL_SIZE,
    ),
  }
}

function staysDocked(side: DockSide, cursorX: number, bounds: Rect): boolean {
  if (side === 'right') return cursorX >= bounds.x + bounds.width - DOCK_DRAG_OFF
  return cursorX <= bounds.x + DOCK_DRAG_OFF
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3
}

function lerpRect(start: Rect, end: Rect, t: number): Rect {
  return {
    x: Math.round(start.x + (end.x - start.x) * t),
    y: Math.round(start.y + (end.y - start.y) * t),
    width: Math.round(start.width + (end.width - start.width) * t),
    height: Math.round(start.height + (end.height - start.height) * t),
  }
}

/** The ball's own position on a fresh profile, and the resting window that frames it. */
export function initialBallOrigin(workArea: Rect): { x: number; y: number } {
  return defaultFloatingBallOrigin(workArea)
}

/** Initial window, already the resting overlay rect — the same one the panel opens into. */
export function initialWindowBounds(workArea: Rect): Rect {
  return restingWindowBounds(initialBallOrigin(workArea), workArea)
}

/**
 * Owns expand direction and dock state for one overlay window.
 * Dock is committed on pointer-up, not while the ball is still moving.
 */
export class FloatingPlacement {
  private direction: Direction = { horizontal: 'left', vertical: 'up' }
  private docked: { side: DockSide; y: number } | undefined
  private anim = 0
  /**
   * Whether the window is currently showing the panel card beside the ball.
   * This is tracked here rather than read back from the window rect: a display at a
   * fractional scale factor rounds a window's size to whole DIP, so a freshly collapsed
   * window reports one pixel more than {@link BALL_WINDOW_SIZE}. Deciding the layout by
   * comparing sizes therefore called a collapsed ball "expanded" — every drag then moved
   * the whole overlay instead of the ball, and the release ended wherever that layout's
   * clamped geometry put it rather than where the pointer let go.
   */
  private expanded = false
  /**
   * The ball's own top-left, as last requested. The window rect is only ever a rounded
   * echo of it, so the ball's position lives here and is never recovered from
   * {@link getBounds}.
   */
  private origin: { x: number; y: number }

  constructor(private readonly window: {
    getBounds(): Rect
    setBounds(bounds: Rect): void
  }, private readonly displayAt: (point: { x: number; y: number }) => DisplayPair, private readonly displayBounds: () => readonly Rect[] = () => [], origin?: { x: number; y: number }) {
    const bounds = window.getBounds()
    // The ball's own corner is handed in rather than read back out of the window rect. The window
    // is the overlay rect from the very first frame, so the ball is not at its top-left any more,
    // and a fractional display scale rounds a window's size — recovering it would start the whole
    // lifetime a pixel out and never correct it.
    this.origin = origin ?? { x: bounds.x + CHROME_INSET, y: bounds.y + CHROME_INSET }
    this.direction = expandDirection(this.origin, displayAt(center(bounds)).workArea)
  }

  /**
   * Open or close the panel without touching the window.
   *
   * Both states share one window rect (see {@link restingWindowBounds}), so there is nothing to
   * resize and nothing to move: the answer is the state, the direction the page should wear, and
   * whether the ball is docked. The direction is *not* re-decided here even when the ball has
   * drifted to the other side of the display since the last collapse — moving the window under an
   * open panel is the one thing that would put the ball somewhere else for a frame, which is the
   * whole thing this arrangement exists to prevent. It is re-decided on the next rest instead.
   */
  setExpanded(expanded: boolean): ExpandState {
    const bounds = this.window.getBounds()
    const display = this.displayAt(center(bounds))
    if (expanded) {
      this.docked = undefined
      this.expanded = true
      return { expanded: true, ...this.direction, docked: undefined }
    }
    this.expanded = false
    if (this.docked) {
      this.applyTab(this.docked.side, this.docked.y, display.bounds)
      return { expanded: false, ...this.direction, docked: this.docked.side }
    }
    return { expanded: false, ...this.direction, docked: undefined }
  }

  /**
   * Move so the 288px ball origin follows `(x, y)`.
   * A resting ball may hang past a display edge. Dock is committed by {@link clamp}.
   */
  move(x: number, y: number, canDock = true): DockState {
    const origin = { x: Math.round(x), y: Math.round(y) }
    this.origin = origin
    const display = this.displayAt(origin)
    if (this.expanded) {
      this.window.setBounds(overlayBoundsFromBall(origin, this.direction))
      return { docked: undefined }
    }
    // At rest the direction is free to change. The ball's screen position is its own origin in
    // either column — the window is built around it — so re-deciding which side the window reaches
    // for moves the window without moving the ball, and costs nothing.
    this.direction = expandDirection(origin, display.workArea)
    if (!canDock) {
      this.docked = undefined
      this.anim += 1
      this.window.setBounds(overlayBoundsFromBall(origin, this.direction))
      return { docked: undefined }
    }
    if (this.docked && staysDocked(this.docked.side, origin.x, display.bounds)) {
      this.applyTab(this.docked.side, this.docked.y, display.bounds)
      return { docked: this.docked.side }
    }
    this.docked = undefined
    this.anim += 1
    this.window.setBounds(overlayBoundsFromBall(origin, this.direction))
    return { docked: undefined }
  }

  /** Pull a free ball inside the work area, or dock it when it already overlaps a side edge. */
  async clamp(canDock = true): Promise<DockState> {
    const display = this.displayAt(center(this.window.getBounds()))
    if (this.docked) {
      this.applyTab(this.docked.side, this.docked.y, display.bounds)
      return { docked: this.docked.side }
    }
    if (!this.expanded) {
      const origin = this.ballOrigin()
      if (canDock) {
        const side = dockSideForBallOrigin(origin, display.bounds, this.displayBounds())
        if (side) return this.snap(side, origin.y, display.bounds)
      }
      const rest = keepBallReachable(origin, display.workArea)
      this.origin = rest
      this.direction = expandDirection(rest, display.workArea)
      this.window.setBounds(expandedOverlayBounds(rest, display.workArea))
      return { docked: undefined }
    }
    return { docked: undefined }
  }

  /** Slide the ball back on screen from a docked tab. */
  async unsnap(): Promise<DockState> {
    if (!this.docked) return { docked: undefined }
    const display = this.displayAt(center(this.window.getBounds()))
    const start = offScreenBallOrigin(this.docked.side, this.docked.y, display.bounds)
    const end = insideBallOrigin(this.docked.side, this.docked.y, display)
    this.docked = undefined
    this.expanded = false
    this.origin = end
    this.direction = expandDirection(end, display.workArea)
    this.window.setBounds(overlayBoundsFromBall(start, this.direction))
    await this.animate(overlayBoundsFromBall(end, this.direction), DOCK_SLIDE_IN_MS, easeOutCubic)
    return { docked: undefined }
  }

  /** The ball's own top-left: its docked slot while docked, otherwise the last position asked for. */
  private ballOrigin(): { x: number; y: number } {
    if (this.docked) return insideBallOrigin(this.docked.side, this.docked.y, this.displayAt(center(this.window.getBounds())))
    return this.origin
  }

  private applyTab(side: DockSide, ballY: number, bounds: Rect): void {
    const y = clampBallY(ballY, bounds)
    this.docked = { side, y }
    this.anim += 1
    this.window.setBounds(dockedTabBounds(side, y, bounds))
  }

  private async snap(side: DockSide, ballY: number, bounds: Rect): Promise<DockState> {
    const y = clampBallY(ballY, bounds)
    this.docked = { side, y }
    await this.animate(
      collapsedWindowBounds(offScreenBallOrigin(side, y, bounds)),
      DOCK_SLIDE_OFF_MS,
      easeInOutCubic,
    )
    if (!this.docked || this.docked.side !== side) return { docked: this.docked?.side }
    this.window.setBounds(dockedTabBounds(side, y, bounds))
    return { docked: side }
  }

  private animate(end: Rect, durationMs: number, ease: (t: number) => number): Promise<void> {
    const generation = ++this.anim
    const start = this.window.getBounds()
    if (durationMs <= 0) {
      this.window.setBounds(end)
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const t0 = Date.now()
      const tick = (): void => {
        if (generation !== this.anim) {
          resolve()
          return
        }
        const t = Math.min(1, (Date.now() - t0) / durationMs)
        this.window.setBounds(lerpRect(start, end, ease(t)))
        if (t < 1) {
          setTimeout(tick, 16)
          return
        }
        resolve()
      }
      setTimeout(tick, 16)
    })
  }
}

function center(bounds: Rect): { x: number; y: number } {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}
