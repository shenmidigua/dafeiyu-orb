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
   * The corner the ball is about to be given, before the window grows into it. Resizes nothing:
   * the page wears the corner while the window is still ball-sized, where it costs no pixels.
   */
  expandCorner() {
    return ipcRenderer.invoke('orb:expand-corner')
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
  memeDrag() {
    return ipcRenderer.invoke('orb:meme-drag')
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
})
