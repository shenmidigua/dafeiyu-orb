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
  memeDone() {
    return ipcRenderer.invoke('orb:meme-done')
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
