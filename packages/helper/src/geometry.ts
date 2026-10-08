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
/**
 * Where the ball sits inside the window: the same place in every direction, for the window's
 * whole lifetime. Mirrored by `--ball-column` / `--ball-row` in the CSS.
 *
 * This is what stops the ball jumping about while it is dragged. Its screen position is
 * `window origin + its offset inside the window`, and changing direction has to move one of those
 * by the panel's width: the origin is set by the main process, the offset by the page, in two
 * frames that can never be committed together. So while the page still wore the old direction,
 * the ball was drawn 430px away from the pointer and followed it from there — measured on the real
 * machine, not theorised. Pinning the offset and letting the window carry the whole arrangement
 * means a direction change moves neither, and becomes invisible: all it decides is which side the
 * panel card is drawn on, and the panel is hidden for the whole of a drag.
 */
export const BALL_COLUMN = CHROME_INSET + PANEL_SIZE.width + PANEL_GAP
export const BALL_ROW = CHROME_INSET + (PANEL_SIZE.height - BALL_SIZE)
/**
 * The one size this window is ever. There is no ball-sized counterpart any more: a window that
 * changes size to open its panel is what put the ball in the panel's corner for a frame, and
 * nothing about that is fixable from the page. See {@link restingWindowBounds}.
 *
 * It reaches a panel's width either side of the ball's column and a panel's height either side of
 * its row, because the direction chooses which side the card is drawn on and the card has to fit
 * on whichever side it chooses. Everything the card does not use is transparent, and click-through
 * by way of the rects the page reports — see `orb:hit-test` in the main process.
 */
export const PANEL_WINDOW_SIZE = {
  width: BALL_COLUMN + BALL_SIZE + PANEL_GAP + PANEL_SIZE.width + CHROME_INSET,
  height: BALL_ROW + PANEL_SIZE.height + CHROME_INSET,
} as const
export const BELOW_CENTER = 0.08
/**
 * How far the ball has to hang past a display edge before a release docks it.
 * A third of the ball. It used to be a half, which made docking feel out of reach; a fifth
 * (the oldest value) docked on ordinary drags near the edge, which looks exactly like
 * "the ball did not stay where I let go of it".
 */
export const DOCK_OVERLAP = Math.round(BALL_SIZE / 3)
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
/**
 * How long the ball takes to slide back out of the dock, in the pull's own gesture.
 *
 * The same 300ms as {@link DOCK_SLIDE_IN_MS}, and the same `easeOutCubic`: docking in and pulling
 * out are the same journey in opposite directions, and a pull that took a different time read as a
 * different mechanism. What differs is only who is driving — this one is abandoned the instant the
 * hand moves again, so its length is a floor on how long the ball travels rather than a delay the
 * user has to sit through.
 */
export const DOCK_SLIDE_OUT_MS = 300

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
 * A resting window is therefore bigger than the ball and mostly empty, and much of it can sit
 * outside the work area. That emptiness has to be transparent to clicks, which the page arranges
 * by reporting what the pointer is over — see `orb:hit-test` in the main process.
 *
 * The rect is deliberately *not* pulled back inside the work area, which the panel's own rect used
 * to be. Clamping moves the window, and the ball's offset inside the window is fixed by whichever
 * direction the page wears, so a clamped window leaves the ball somewhere other than where it was
 * let go — the "it did not stay where I released it" complaint, back in a new place. It is also
 * unnecessary: {@link expandDirection} already picks the side the panel opens towards by comparing
 * the ball against the middle of the work area, so a ball inside the work area always gets a panel
 * inside it. A ball hanging half off an edge may open a panel that overhangs the edge, and that is
 * the cheaper trade.
 */
function restingWindowBounds(ball: { readonly x: number; readonly y: number }): Rect {
  return overlayBoundsFromBall(ball)
}

/**
 * Which outer display edge the ball already overlaps by about a third of its width.
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

/**
 * Which side of the ball the panel card is drawn on.
 *
 * A layout decision, not a window one — the rect is the same whichever side this names, so all it
 * says is whether the card goes left or right of the ball's column and whether it is aligned to
 * the ball's top or its bottom. The side with room wins, so a ball near a display edge still gets
 * its card on screen.
 */
export function expandDirection(
  ball: { readonly x: number; readonly y: number },
  workArea: Rect,
): Direction {
  const centerX = ball.x + BALL_SIZE / 2
  const horizontal: HorizontalExpand = centerX - workArea.x > workArea.width / 2 ? 'left' : 'right'
  const vertical: VerticalExpand = ball.y - workArea.y < PANEL_SIZE.height - BALL_SIZE ? 'down' : 'up'
  return { horizontal, vertical }
}

/**
 * Ball top-left recovered from an expanded window.
 *
 * The inverse of {@link overlayBoundsFromBall}, and a plain constant offset in both axes: the
 * window is built around the ball, in the same place, whichever direction the panel opens towards.
 */
export function ballOriginFromWindow(bounds: Rect): { x: number; y: number } {
  return {
    x: bounds.x + BALL_COLUMN,
    y: bounds.y + BALL_ROW,
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

/**
 * The window that frames a ball at `ball`, for any direction.
 *
 * Deliberately without a direction argument: the rect has to come out the same whichever way the
 * panel opens, because a rect that moved with the direction would be a rect that moved the ball —
 * the main process would shift the window by the panel's width and the page, still wearing the old
 * direction, would keep drawing the ball where it was. See {@link BALL_COLUMN}.
 */
function overlayBoundsFromBall(ball: { readonly x: number; readonly y: number }): Rect {
  return {
    x: ball.x - BALL_COLUMN,
    y: ball.y - BALL_ROW,
    width: PANEL_WINDOW_SIZE.width,
    height: PANEL_WINDOW_SIZE.height,
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

/**
 * Where a peeked ball stands: exactly half of it still past the edge it is docked to.
 *
 * Deliberately not {@link insideBallOrigin}, which is the same position with the ball wholly on
 * screen. A peek is a hint that the strip has something behind it, and a whole ball arriving to say
 * so is an offer rather than a hint — the hand is resting on a 6px bar, not reaching for anything.
 * Half a ball reads as "there is more of this behind the edge", which is what the hover is for.
 *
 * The row is `clampBallY`'s, the same one `dockedTabBounds` clamps to, so the ball comes out level
 * with the strip it came from — including on a dock a hair's width from the taskbar, where the
 * display's own bounds and the work area disagree.
 */
function peekBallOrigin(side: DockSide, ballY: number, bounds: Rect): { x: number; y: number } {
  const half = Math.round(BALL_SIZE / 2)
  return {
    x: side === 'left' ? bounds.x - half : bounds.x + bounds.width - half,
    y: clampBallY(ballY, bounds),
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
  return restingWindowBounds(initialBallOrigin(workArea))
}

/**
 * Owns expand direction and dock state for one overlay window.
 * Dock is committed on pointer-up, not while the ball is still moving.
 */
export class FloatingPlacement {
  private direction: Direction = { horizontal: 'left', vertical: 'up' }
  private docked: { side: DockSide; y: number } | undefined
  /**
   * Whether the docked ball is currently showing itself at the edge, put there by a hover on the
   * strip rather than by a hand.
   *
   * A flag of its own rather than "docked, with the window somewhere else", because the pull out of
   * the dock has to be able to tell the difference. {@link unsnap} and {@link unsnapSmooth} both
   * begin by parking the window off the edge and sliding it in; a ball that a hover has already
   * brought half way out would jump backwards off the screen and slide in from nowhere, which is
   * the one motion the peek exists *not* to have. So they ask this and start from where the peek
   * left the ball instead. {@link applyTab} is the way back to the strip, and it clears this on the
   * way.
   */
  private peeking = false
  private anim = 0
  /**
   * Whether the panel card is currently shown beside the ball.
   *
   * Tracked here rather than read back from the window rect, and now that there is one rect for
   * both states there would be nothing to read even if the sizes were exact. It used to be
   * inferred by comparing the window's size against the collapsed one, which a fractional display
   * scale broke: Windows answers a window one pixel larger than the size it was given, so a
   * collapsed ball counted as expanded, and every drag then moved the whole overlay instead of the
   * ball.
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
    // The ball's own corner is handed in rather than read back out of the window rect: a fractional
    // display scale rounds a window's size, so recovering it would start the whole lifetime a pixel
    // out and never correct it. The fallback is the one offset the window is built around, in every
    // direction — see {@link BALL_COLUMN}.
    this.origin = origin ?? ballOriginFromWindow(bounds)
    this.direction = expandDirection(this.origin, displayAt(center(bounds)).workArea)
  }

  /**
   * Open or close the panel without touching the window.
   *
   * Both states share one window rect (see {@link restingWindowBounds}), so there is nothing to
   * resize and nothing to move: the answer is the state, the direction the page should wear, and
   * whether the ball is docked. The direction is *not* re-decided here even when the ball has
   * drifted to the other side of the display since the last collapse — the card is already open
   * under the pointer, and throwing it across to the other side of the ball mid-read is worse than
   * leaving it where the reader found it. It is re-decided on the next rest instead, where nothing
   * is on screen to disturb.
   */
  setExpanded(expanded: boolean): ExpandState {
    const bounds = this.window.getBounds()
    const display = this.displayAt(center(bounds))
    if (expanded) {
      this.docked = undefined
      this.peeking = false
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
   * The corner the ball is in right now, without changing anything.
   *
   * The page has to be wearing a direction before it has drawn anything, because the ball is only
   * ever positioned by the direction rules — the base rules put it in the panel's corner. So this
   * is asked for once at startup, where {@link setExpanded} would be the wrong tool: that is a
   * request to change state, and the honest answer to "what is the state" should not be a state
   * change that happens to be idempotent.
   */
  currentDirection(): ExpandState {
    return { expanded: this.expanded, ...this.direction, docked: this.docked?.side }
  }

  /**
   * Move so the 288px ball origin follows `(x, y)`.
   * A resting ball may hang past a display edge. Dock is committed by {@link clamp}.
   */
  move(x: number, y: number, canDock = true): DockState {
    const origin = { x: Math.round(x), y: Math.round(y) }
    this.origin = origin
    // A hand placing the ball is not the strip showing it. Whatever a peek had on screen, the hand
    // is now the thing deciding where the ball is, and the two states cannot both be true.
    this.peeking = false
    const display = this.displayAt(origin)
    if (this.expanded) {
      this.window.setBounds(overlayBoundsFromBall(origin))
      return { docked: undefined }
    }
    // At rest the direction is free to change, and the window does not move for it: the rect is
    // the same one whichever way the panel opens, so re-deciding here only changes which side the
    // page draws the card on. That is what lets a drag carry the ball across the display — and
    // across this decision — without the ball shifting by a pixel.
    this.direction = expandDirection(origin, display.workArea)
    if (!canDock) {
      this.docked = undefined
      this.anim += 1
      this.window.setBounds(overlayBoundsFromBall(origin))
      return { docked: undefined }
    }
    if (this.docked && staysDocked(this.docked.side, origin.x, display.bounds)) {
      this.applyTab(this.docked.side, this.docked.y, display.bounds)
      return { docked: this.docked.side }
    }
    this.docked = undefined
    this.anim += 1
    this.window.setBounds(overlayBoundsFromBall(origin))
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
      this.window.setBounds(overlayBoundsFromBall(rest))
      return { docked: undefined }
    }
    return { docked: undefined }
  }

  /** Slide the ball back on screen from a docked tab. */
  async unsnap(): Promise<DockState> {
    if (!this.docked) return { docked: undefined }
    const display = this.displayAt(center(this.window.getBounds()))
    const side = this.docked.side
    // Out of a peek the ball is already half way out, so that is where the slide starts from —
    // parking it off the edge first would be the one frame of the gesture where the ball is
    // *further* out than the hover left it. See {@link peeking}.
    const start = this.peeking
      ? peekBallOrigin(side, this.docked.y, display.bounds)
      : offScreenBallOrigin(side, this.docked.y, display.bounds)
    const end = insideBallOrigin(side, this.docked.y, display)
    this.peeking = false
    this.docked = undefined
    this.expanded = false
    this.origin = end
    this.direction = expandDirection(end, display.workArea)
    this.window.setBounds(overlayBoundsFromBall(start))
    await this.animate(overlayBoundsFromBall(end), DOCK_SLIDE_IN_MS, easeOutCubic)
    return { docked: undefined }
  }

  /**
   * Slide the ball back on screen from the dock, the way {@link unsnap} does, but as a leg of the
   * pull that is still going on rather than as a whole gesture of its own.
   *
   * Docking slides the ball *off* the edge over 250ms, and for a long time the way back out was the
   * opposite of that in name only: the ball reappeared at the pointer, one frame, a whole ball's
   * width clear of the edge it had just left. The motion the user had been shown going in was simply
   * missing coming out, and the hand holding the strip never saw the ball travel — it was somewhere
   * behind the edge, and then it was at the cursor.
   *
   * So this is `unsnap`'s animation with the pull's own ending. It is *abandoned* the moment the
   * hand asks for anything: `this.origin` is overwritten by the very next {@link move}, and `move`
   * also bumps `this.anim`, which is the counter {@link animate} checks before every frame. The ball
   * therefore travels for as long as the hand is still — and the instant it is not, the next move
   * takes the window over from wherever the slide had reached. No frame is waited on and no move is
   * swallowed: a hand that yanks the strip sideways gets a ball that follows it immediately, and a
   * hand that nudges the strip 25px and stops gets to watch the ball come the rest of the way out.
   *
   * The landing point is {@link insideBallOrigin}, the same slot {@link unsnap} uses and the same
   * one the page computes for itself in `handDockDragToBall` — the two have to agree, since the page
   * takes over the gesture on the next move and writes its own copy of the slot as the ball's
   * position.
   */
  async unsnapSmooth(): Promise<DockState> {
    if (!this.docked) return { docked: undefined }
    const display = this.displayAt(center(this.window.getBounds()))
    const side = this.docked.side
    // The same start `unsnap` takes, and for the same reason: a pull that begins on a peeked ball
    // continues the motion the hover started, out of the place the ball is already standing.
    const start = this.peeking
      ? peekBallOrigin(side, this.docked.y, display.bounds)
      : offScreenBallOrigin(side, this.docked.y, display.bounds)
    const end = insideBallOrigin(side, this.docked.y, display)
    this.peeking = false
    this.docked = undefined
    this.expanded = false
    this.origin = end
    this.direction = expandDirection(end, display.workArea)
    this.window.setBounds(overlayBoundsFromBall(start))
    await this.animate(overlayBoundsFromBall(end), DOCK_SLIDE_OUT_MS, easeOutCubic)
    return { docked: undefined }
  }

  /**
   * Show the docked ball half out of the edge it is docked to, without giving up the dock.
   *
   * The strip is something the user *hovers*, and a hover is not a gesture. So the ball comes out
   * to {@link peekBallOrigin} — half of it on screen, the other half still past the display edge —
   * and it stays docked: the strip is still behind it, and the ball is still not the user's to
   * move. A hint rather than an offer, which is the whole of why it is half a ball and not a whole
   * one.
   *
   * Nothing is animated, on purpose. The peek is the ball's *showing*, and whatever clip it is
   * wearing is the whole of what the hover plays — sliding the window out underneath it as well
   * would be a second arrival competing with the one the user asked to watch.
   *
   * The window still has to grow for it: the ball is drawn at {@link BALL_COLUMN} inside the
   * window, and a 34px tab rect has no such column to draw it in. The page pins the strip against
   * the display edge for the same reason — see `body.docked.docked-peek #dock-tab` in
   * `floating.css`.
   */
  async peek(): Promise<DockState> {
    if (!this.docked) return { docked: undefined }
    const display = this.displayAt(center(this.window.getBounds()))
    const end = peekBallOrigin(this.docked.side, this.docked.y, display.bounds)
    this.peeking = true
    this.anim += 1
    this.window.setBounds(overlayBoundsFromBall(end))
    return { docked: this.docked.side }
  }

  /** Put a peeked ball back behind its strip. The dock itself is untouched by either one. */
  async unpeek(): Promise<DockState> {
    if (!this.docked) return { docked: undefined }
    const display = this.displayAt(center(this.window.getBounds()))
    this.applyTab(this.docked.side, this.docked.y, display.bounds)
    return { docked: this.docked.side }
  }

  /** The ball's own top-left: its docked slot while docked, otherwise the last position asked for. */
  private ballOrigin(): { x: number; y: number } {    if (this.docked) return insideBallOrigin(this.docked.side, this.docked.y, this.displayAt(center(this.window.getBounds())))
    return this.origin
  }

  private applyTab(side: DockSide, ballY: number, bounds: Rect): void {
    const y = clampBallY(ballY, bounds)
    this.docked = { side, y }
    // Back to the strip: whatever was showing at the edge goes back behind it. This is the only
    // place that ends a peek, so every path that puts the window on its tab rect — a re-clamp, a
    // collapse, {@link unpeek} — ends it too, without any of them having to remember to.
    this.peeking = false
    this.anim += 1
    this.window.setBounds(dockedTabBounds(side, y, bounds))
  }

  private async snap(side: DockSide, ballY: number, bounds: Rect): Promise<DockState> {
    const y = clampBallY(ballY, bounds)
    this.docked = { side, y }
    this.peeking = false
    // Slide to the overlay rect rather than a ball-sized one, keeping the direction the page is
    // already wearing: the ball then holds its offset inside the window for every frame of the
    // slide, which is what makes it travel instead of jumping. The window still ends on the small
    // tab rect below — docking has always resized, and it resizes once at the end of a 250ms
    // animation the user is already watching, which is not the one-frame jump this arrangement
    // exists to remove.
    await this.animate(
      overlayBoundsFromBall(offScreenBallOrigin(side, y, bounds)),
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
