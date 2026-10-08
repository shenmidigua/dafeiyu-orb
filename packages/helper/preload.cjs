const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshOrb', {
  move(x, y, canDock) {
    return ipcRenderer.invoke('orb:move', { x, y, canDock: canDock !== false })
  },
  clamp(canDock) {
    return ipcRenderer.invoke('orb:clamp', canDock !== false)
  },
  unsnap() {
    return ipcRenderer.invoke('orb:unsnap')
  },
  /**
   * Pull the ball back out of the dock as a leg of the drag rather than as a finished gesture.
   *
   * Same landing point as {@link unsnap}, but the main process *animates* the ball out instead of
   * snapping it to the slot, and abandons that animation the instant a move arrives. The page calls
   * this at the hand-off because the pull is still in progress: the ball should be seen travelling
   * out from the edge, not appearing at the cursor.
   */
  unsnapSmooth() {
    return ipcRenderer.invoke('orb:unsnap-smooth')
  },
  /**
   * Show the docked ball half out of its own edge, and put it back, for the strip's hover.
   *
   * Deliberately not {@link unsnapSmooth}: that one *gives up the dock*, which is the user taking
   * the ball back. This is the ball showing itself to a pointer that only rested on the strip, so
   * the dock has to survive it — the strip is still what the user drags to get the ball out, and it
   * has to still be there afterwards.
   */
  peekDock() {
    return ipcRenderer.invoke('orb:dock-peek')
  },
  unpeekDock() {
    return ipcRenderer.invoke('orb:dock-unpeek')
  },
  /**
   * Report the screen rectangles that should capture the mouse, so the main process can keep the
   * window click-through everywhere else. A `send`, not an `invoke`: it rides along with layout
   * changes and there is no reply worth waiting for.
   *
   * Geometry, not a verdict on the pointer. The window is click-through whenever the pointer is
   * off these rectangles, and a click-through window sends the renderer no mouse events at all, so
   * the page cannot be the one to notice the pointer arriving and turn capture back on.
   */
  setHitTest(regions) {
    ipcRenderer.send('orb:hit-test', Array.isArray(regions) ? regions : [])
  },
  /**
   * The corner the ball is in right now, asked once at startup so the page can wear it before it
   * draws anything. The ball is only ever positioned by the direction rules, so there is no
   * correct-looking default to fall back on.
   */
  direction() {
    return ipcRenderer.invoke('orb:direction')
  },
  /**
   * The main process saying which side of the capture line the pointer is on, and where it is in
   * the page's coordinates — or `null` for off the window. Sent on each crossing, not polled, so a
   * pointer that jumps the boundary and stops is still accounted for; see {@link setHitTest} in
   * the main process for why the page cannot work this out for itself.
   */
  onPointer(callback) {
    ipcRenderer.on('orb:pointer', (_event, point) => {
      callback(point && typeof point.x === 'number' && typeof point.y === 'number'
        ? { clientX: point.x, clientY: point.y }
        : null)
    })
  },
  setExpanded(expanded) {
    return ipcRenderer.invoke('orb:expand', Boolean(expanded))
  },
  send(text) {
    ipcRenderer.send('orb:prompt', text)
  },
  answerQuestion(id, answers) {
    ipcRenderer.send('orb:question-answer', { id, answers })
  },
  cancelQuestion(id) {
    ipcRenderer.send('orb:question-cancel', id)
  },
  requestHistory() {
    ipcRenderer.send('orb:history')
  },
  openSession(id) {
    ipcRenderer.send('orb:open', id)
  },
  newSession() {
    ipcRenderer.send('orb:new')
  },
  setPermission(preset) {
    ipcRenderer.send('orb:permission', preset)
  },
  stop() {
    ipcRenderer.send('orb:stop')
  },
  copy(text) {
    ipcRenderer.send('orb:copy', text)
  },
  openMenu() {
    return ipcRenderer.invoke('orb:menu')
  },
  openExternal(url) {
    ipcRenderer.send('orb:open-external', url)
  },
  tccStatus() {
    return ipcRenderer.invoke('orb:tcc-status')
  },
  openTcc(right) {
    return ipcRenderer.invoke('orb:tcc-open', right)
  },
  wakeConfig() {
    return ipcRenderer.invoke('orb:wake-config')
  },
  wakeEnable() {
    return ipcRenderer.invoke('orb:wake-enable')
  },
  wakeDisable() {
    return ipcRenderer.invoke('orb:wake-disable')
  },
  wakeReport(status) {
    return ipcRenderer.invoke('orb:wake-report', status)
  },
  setWakeEnabled(enabled) {
    return ipcRenderer.invoke('orb:wake-enabled', Boolean(enabled))
  },
  onWake(callback) {
    ipcRenderer.on('orb:wake', (_event, payload) => callback(payload))
  },
  dictate(payload) {
    return ipcRenderer.invoke('orb:dictate', payload)
  },
  onDictate(callback) {
    ipcRenderer.on('orb:dictate', () => callback())
  },
  onTranscript(callback) {
    ipcRenderer.on('orb:transcript', (_event, payload) => callback(payload))
  },
  memeSchedule() {
    return ipcRenderer.invoke('orb:meme-schedule')
  },
  memeIdle() {
    return ipcRenderer.invoke('orb:meme-idle')
  },
  memeHover() {
    return ipcRenderer.invoke('orb:meme-hover')
  },
  memeTyping() {
    return ipcRenderer.invoke('orb:meme-typing')
  },
  memeReply() {
    return ipcRenderer.invoke('orb:meme-reply')
  },
  memeThinking() {
    return ipcRenderer.invoke('orb:meme-thinking')
  },
  memeTool() {
    return ipcRenderer.invoke('orb:meme-tool')
  },
  /**
   * The face for one named tool, or `null` when the pack draws that call the same as every other.
   *
   * The name is the one in the transcript's tool card — `pwsh`, `edit`, `read` — because that is the only
   * thing either side knows a call by. `null` is the ordinary answer and means "wear the shared tool face".
   */
  memeToolNamed(name) {
    return ipcRenderer.invoke('orb:meme-tool-named', name)
  },
  memeSleep() {
    return ipcRenderer.invoke('orb:meme-sleep')
  },
  memeSleepFrame(index) {
    return ipcRenderer.invoke('orb:meme-sleep-frame', index)
  },
  memeYawn() {
    return ipcRenderer.invoke('orb:meme-yawn')
  },
  memeSkit() {
    return ipcRenderer.invoke('orb:meme-skit')
  },
  memeClick() {
    return ipcRenderer.invoke('orb:meme-click')
  },
  memeArrive() {
    return ipcRenderer.invoke('orb:meme-arrive')
  },
  memeDockArrive() {
    return ipcRenderer.invoke('orb:meme-dock-arrive')
  },
  memePoor() {
    return ipcRenderer.invoke('orb:meme-poor')
  },
  memeDone() {
    return ipcRenderer.invoke('orb:meme-done')
  },
  /** The acknowledgement face, shown once when the user has just sent the agent something. */
  memeNod() {
    return ipcRenderer.invoke('orb:meme-nod')
  },
  /** The interrupted face, shown once when a run ends that way. */
  memeInterrupted() {
    return ipcRenderer.invoke('orb:meme-interrupted')
  },
  /** The approval face, shown once when a run ends that way. */
  memeApproval() {
    return ipcRenderer.invoke('orb:meme-approval')
  },
  /** The maxtokens face, shown once when a run ends that way. */
  memeMaxtokens() {
    return ipcRenderer.invoke('orb:meme-maxtokens')
  },
  memeFail() {
    return ipcRenderer.invoke('orb:meme-fail')
  },
  memeAsk() {
    return ipcRenderer.invoke('orb:meme-ask')
  },
  memeWake() {
    return ipcRenderer.invoke('orb:meme-wake')
  },
  memeVoice() {
    return ipcRenderer.invoke('orb:meme-voice')
  },
  memeSpeak() {
    return ipcRenderer.invoke('orb:meme-speak')
  },
  memeDrag() {
    return ipcRenderer.invoke('orb:meme-drag')
  },
  memeDrop() {
    return ipcRenderer.invoke('orb:meme-drop')
  },
  memeFrame() {
    return ipcRenderer.invoke('orb:meme-frame')
  },
  onBlock(callback) {
    ipcRenderer.on('orb:block', (_event, block) => callback(block))
  },
  onBlockDrop(callback) {
    ipcRenderer.on('orb:block-drop', (_event, key) => callback(key))
  },
  onTurn(callback) {
    ipcRenderer.on('orb:turn', (_event, turn) => callback(turn))
  },
  /**
   * News about a turn in a conversation that is not this ball's own.
   *
   * A channel of its own rather than a `turn` message, because the two mean different things on this page:
   * `orb:turn` moves the turn state and rings the bell when a turn ends well, while this only says that
   * something is happening in the chat the user is looking at — and must leave this page's own turn, and its
   * transcript, exactly as they were.
   *
   * The payload is `{ outcome, sessionId?, tool? }`. `outcome` is `'typing'`, `'thinking'` or `'tool'` while
   * that conversation is doing it, and `'streamed'` once the attempt writing it has ended — so the face comes off
   * with the words rather than with the grace window that is only there as a fallback. `tool` rides along with
   * `'tool'` and names the tool being called, which is the only way a pack that draws a face per tool can be
   * obeyed from the window the user is typing in: the ball's own transcript is not that conversation, so this
   * page has no tool card to read the name from.
   */
  onSessionTurn(callback) {
    ipcRenderer.on('orb:session-turn', (_event, payload) => callback(payload))
  },
  onStatus(callback) {
    ipcRenderer.on('orb:status', (_event, text) => callback(text))
  },
  onSession(callback) {
    ipcRenderer.on('orb:session', (_event, sessionId) => callback(sessionId))
  },
  onQuestion(callback) {
    ipcRenderer.on('orb:question', (_event, question) => callback(question))
  },
  onQuestionClear(callback) {
    ipcRenderer.on('orb:question-clear', (_event, id) => callback(id))
  },
  onQuestionError(callback) {
    ipcRenderer.on('orb:question-error', (_event, payload) => callback(payload))
  },
  onHistory(callback) {
    ipcRenderer.on('orb:history', (_event, items) => callback(items))
  },
  onPermission(callback) {
    ipcRenderer.on('orb:permission', (_event, preset) => callback(preset))
  },
  onReset(callback) {
    ipcRenderer.on('orb:reset', () => callback())
  },
  onAvatar(callback) {
    ipcRenderer.on('orb:avatar', (_event, src) => callback(src))
  },
  onAttach(callback) {
    ipcRenderer.on('orb:attach', (_event, text) => callback(text))
  },
  onAppearance(callback) {
    ipcRenderer.on('orb:appearance', (_event, appearance) => callback(appearance))
  },
  /**
   * The account balance the host read: `{ cny, at }`, with `cny: null` for "not known".
   *
   * Pushed rather than fetched: the host reads it on its own slow cadence, and a ball that had to ask
   * would be asking a question the helper has no way to answer — the account lives on the host side.
   */
  onBalance(callback) {
    ipcRenderer.on('orb:balance', (_event, balance) => callback(balance))
  },
  /**
   * Read-aloud settings pushed from the host: `{ enabled, autoPlay, endpoint }`.
   *
   * Sent rather than fetched because the settings page writes them at any moment, including while the
   * ball is open, and a button that appears or disappears without a reload is the whole point.
   */
  onSpeech(callback) {
    ipcRenderer.on('orb:speech', (_event, settings) => callback(settings))
  },
  /**
   * Ask the main process to make sure the read-aloud service is running, starting it if needed.
   *
   * The page cannot do this itself: starting a background service is a main-process job, and the
   * page's CSP only permits reaching the local port once something is listening there.
   * Resolves to `{ ok, reason? }` once the service answers — or after it fails to.
   */
  ensureSpeech() {
    return ipcRenderer.invoke('orb:speech-ensure')
  },
})
