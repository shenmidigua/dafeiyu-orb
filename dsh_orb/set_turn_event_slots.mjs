/**
 * Give the three new turn-ending slots a file each, and report the whole six.
 *
 * Empty slots would be a feature that silently does nothing — the ball would wear its resting face for an
 * approval because nobody named a picture. These three are picked to be recognisable at a glance and to say what
 * happened: fright for a turn cut short, a question mark for the agent waiting on you, an exclamation for running
 * out of room. All three are changeable from `memes.json`, and the two that share a file with another slot are
 * sharing a *picture*, not a setting — editing one leaves the other alone.
 *
 * Usage: `node dsh_orb/set_turn_event_slots.mjs`
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PACK = 'C:/Users/digua/Desktop/dsh-orb-cordis/大肥鱼表情包整合/大肥鱼表情包整合'
const CONFIG = join(homedir(), '.dsh', 'dsh-orb', 'memes.json')

/** The three the ball had no face for, with a file that says what happened. */
const WANTED = {
  interrupted: '惊吓.gif',
  approval: '问号.gif',
  maxtokens: '叹号.gif',
}

for (const [slot, file] of Object.entries(WANTED)) {
  if (!existsSync(join(PACK, file))) {
    console.error(`no such clip: ${file} (for ${slot})`)
    process.exit(1)
  }
}

const config = JSON.parse(readFileSync(CONFIG, 'utf8'))
copyFileSync(CONFIG, `${CONFIG}.bak-before-turn-events`)
for (const [slot, file] of Object.entries(WANTED)) config[slot] = { enabled: true, file }
writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

const written = JSON.parse(readFileSync(CONFIG, 'utf8'))
console.log('the six turn endings, as configured now:')
for (const [category, slot] of [['done 任务完成', 'done'], ['fail 出错/被停止', 'fail'], ['interrupted 被中断', 'interrupted'], ['approval 等待审批', 'approval'], ['ask AI 提问', 'ask'], ['maxtokens 达到上限', 'maxtokens']]) {
  const entry = written[slot]
  const file = typeof entry?.file === 'string' ? entry.file : '(未配置)'
  const off = entry?.enabled === false ? '  [已关闭]' : ''
  console.log(`  ${category.padEnd(20)} ${slot.padEnd(12)} ${file}${off}`)
}
