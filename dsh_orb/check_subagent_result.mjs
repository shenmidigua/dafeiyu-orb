/**
 * Did a subagent's call settle with an error? — read out of the *parent* session's own log.
 *
 * The ball's failure face for a subagent is driven by `detail.isError` on the subagent's tool block, so
 * this is the check that the wiring has real data behind it: the `tool/result` for the `subagent` call in
 * the parent session, joined to its `tool/call` by tool-call id.
 *
 * Usage: `node dsh_orb/check_subagent_result.mjs <session.v4.jsonl.zstd> [--name subagent] [--since 0]`
 */

import { readSessionRecords } from './read_session.mjs'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: check_subagent_result.mjs <session.v4.jsonl.zstd> [--name subagent]')
  process.exit(1)
}
const nameWanted = process.argv.includes('--name') ? process.argv[process.argv.indexOf('--name') + 1] : 'subagent'

const { records, frames, skipped } = readSessionRecords(file)
console.log(`${frames} frames (${skipped} unreadable), ${records.length} records`)

/** The call id wherever this build keeps it. */
function callIdOf(record) {
  const data = record.data ?? {}
  const message = data.message ?? {}
  return String(
    message.toolCallId ?? data.toolCallId ?? message.tool_call_id ?? data.tool_call_id
    ?? message.id ?? data.id ?? message.callId ?? data.callId ?? '',
  )
}

/** The tool name wherever this build keeps it. */
function nameOf(record) {
  const data = record.data ?? {}
  const message = data.message ?? {}
  return String(message.name ?? data.name ?? message.toolName ?? data.toolName
    ?? message.tool?.name ?? data.tool?.name ?? '')
}

const calls = records.filter((record) => record.type === 'tool/call')
const results = records.filter((record) => record.type === 'tool/result')
const wanted = calls.filter((record) => nameOf(record).includes(nameWanted))
console.log(`tool/call=${calls.length} tool/result=${results.length} calls matching "${nameWanted}"=${wanted.length}\n`)

for (const call of wanted.slice(-3)) {
  const id = callIdOf(call)
  console.log(`call  id=${id || '(none)'}  name=${nameOf(call)}`)
  const match = results.find((record) => callIdOf(record) === id && id !== '')
  if (match === undefined) {
    // Without ids, fall back to the first result after the call in log order: the store is append-only.
    const after = results.slice(results.indexOf(call)).find((record) => results.indexOf(record) >= results.indexOf(call))
    const data = (after ?? {}).data ?? {}
    const message = data.message ?? {}
    console.log(`  no id join; first result after it: status=${data.status ?? message.status ?? '-'}`
      + ` isError=${message.isError ?? data.isError ?? '-'}`)
    console.log(`  keys of a result record: ${Object.keys(after ?? {}).join(', ')}`)
    console.log(`  data keys: ${Object.keys(data).join(', ')}`)
    console.log(`  raw (600): ${JSON.stringify(after ?? {}).slice(0, 600)}`)
    continue
  }
  const data = match.data ?? {}
  const message = data.message ?? {}
  const isError = message.isError ?? data.isError ?? data.status === 'error'
  console.log(`  result status=${data.status ?? message.status ?? '-'}  isError=${isError}`
    + `  error=${JSON.stringify(data.error ?? message.error ?? null).slice(0, 200)}`)
  console.log(`  content: ${JSON.stringify(message.content ?? data.content ?? null).slice(0, 300)}`)
}
