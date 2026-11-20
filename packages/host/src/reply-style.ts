/**
 * The terse-reply contract the ball's agent answers under.
 *
 * A system-prompt section rather than a preset persona: the ball and the main window both run the
 * `computer-use` preset, so the persona cannot tell the two apart, while a section provider is
 * given the agent whose prompt is being assembled. The section renders only for a session inside
 * the orb's own `dsh_orb` workspace — the same test that pins Access on orb sessions — and returns
 * an empty string everywhere else, which the prompt renderer drops. The main window therefore keeps
 * ordinary-length answers.
 *
 * The contract is text, not truncation: the reply is streamed to the panel and read aloud, so
 * cutting it after the fact would break both. The model is told the shape instead.
 */

import type { ReplyStyleSettings } from './preferences.ts'
import { isOrbSession, type SessionLike } from './services.ts'

/** Unique section name. The `orb:` prefix keeps it out of the tool-section names. */
export const REPLY_SECTION_NAME = 'orb:reply-style'

/**
 * Late in the order on purpose — after every tool section.
 *
 * Position is part of the instruction: the output contract is the last thing the model reads
 * before answering, and sections are concatenated in ascending order.
 */
export const REPLY_SECTION_ORDER = 3_100

/** The ball's reply style, read from the profile on each assembly. */
export interface ReplyStyleSource {
  reply(): ReplyStyleSettings
}

/** One prompt-section registration, as much of the official registry as this file needs. */
export interface PromptSectionLike {
  readonly name: string
  readonly order: number
  readonly text: (context: { readonly agent?: { readonly session?: SessionLike } }) => string
}

interface ReplyStyleContext {
  readonly systemPrompt: {
    section(section: PromptSectionLike): () => void
  }
}

/**
 * Render the contract for one configured cap.
 *
 * Hard constraints only: no "prefer", no "consider". The exception is written into the contract
 * because a user who asks for detail must not have to fight the default.
 * @param settings - the enabled flag is the caller's business; only the cap is used here.
 * @returns the section text, ending with the exception that lifts it.
 */
export function replyStylePrompt(settings: ReplyStyleSettings): string {
  return [
    '## 极简回复（语音对话，硬约束）',
    '',
    '用户正在听你说，不是在读屏幕。除非用户明确要求展开，每条回复都按下面执行：',
    '',
    `1. 先给结论。正文不超过 ${String(settings.maxReplyChars)} 字、不超过 3 行。`,
    '2. 不要表格，不要罗列参考链接，不要「顺带一提」式的补充说明；说完就停。',
    '3. 只用纯文本短句：不要 Markdown 表格、多层列表或代码块，这些念不出来。',
    '4. 需要用户点头的事情，压成一句问句；不要铺垫，也不要复述用户的话。',
    '',
    '只有用户明确说「展开」「详细说说」「展开讲」时才越过上面的限制，把内容完整写出来；否则不要反问要不要详细讲。',
  ].join('\n')
}

/**
 * Register the section for the life of the plugin.
 *
 * The text provider runs once per prompt assembly, so turning `orb-reply.json` off and on takes
 * effect on the next turn rather than at restart.
 * @param ctx - host context carrying `systemPrompt`.
 * @param store - profile preferences; `reply()` is re-read per call.
 * @returns a disposer that removes the section.
 */
export function registerReplyStyle(ctx: ReplyStyleContext, store: ReplyStyleSource): () => void {
  return ctx.systemPrompt.section({
    name: REPLY_SECTION_NAME,
    order: REPLY_SECTION_ORDER,
    text: (context) => {
      const session = context.agent?.session
      // No agent, or a session outside `dsh_orb`: the main window's own answers stay as they were.
      if (session === undefined || !isOrbSession(session)) return ''
      const settings = store.reply()
      return settings.enabled ? replyStylePrompt(settings) : ''
    },
  })
}
