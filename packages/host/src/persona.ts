/**
 * The persona that belongs to a cloned voice.
 *
 * A voice is a person: when the ball reads with 德拉曼's timbre, answering in the plugin's own
 * neutral tone is a mismatch the user hears immediately. The mapping is therefore voice → persona
 * text, kept in `orb-persona.json` next to the other profile files, and applied as a prompt section
 * rather than through the preset: the ball and the main window share one preset, so only a section
 * provider is told which agent it is assembling for.
 *
 * Nothing here is specific to one character. The file decides who the ball is while it speaks in a
 * given voice; a profile without that file gets no section at all.
 *
 * Like the reply contract, the text is read from disk on every assembly: switching voices in the
 * ball's menu has to change the next answer, not the one after a restart.
 */

import { isOrbSession, type SessionLike } from './services.ts'

/** Unique section name. The `orb:` prefix keeps it out of the tool-section names. */
export const PERSONA_SECTION_NAME = 'orb:persona'

/**
 * Before the reply contract, which stays last.
 *
 * The terse-reply section says why it sits at the end of the order: it is the shape of the answer,
 * the last thing read before writing one. A persona describes who is answering, so it comes before
 * that shape rather than after it.
 */
export const PERSONA_SECTION_ORDER = 3_050

/** Where the persona text and the current voice come from. */
export interface PersonaSource {
  /** Read-aloud settings; only `voice` is used, and only to choose the persona. */
  speech(): { readonly voice: string }
  /** The persona written for that voice, or `''` when the profile has none. */
  personaFor(voice: string): string
}

/** One prompt-section registration, as much of the official registry as this file needs. */
export interface PromptSectionLike {
  readonly name: string
  readonly order: number
  readonly text: (context: { readonly agent?: { readonly session?: SessionLike } }) => string
}

interface PersonaContext {
  readonly systemPrompt: {
    section(section: PromptSectionLike): () => void
  }
}

/**
 * Register the section for the life of the plugin.
 * @param ctx - host context carrying `systemPrompt`.
 * @param source - profile preferences; both calls are re-read per assembly.
 * @returns a disposer that removes the section.
 */
export function registerPersona(ctx: PersonaContext, source: PersonaSource): () => void {
  return ctx.systemPrompt.section({
    name: PERSONA_SECTION_NAME,
    order: PERSONA_SECTION_ORDER,
    text: (context) => {
      const session = context.agent?.session
      // Outside the ball's own workspace the answer is the main window's, in nobody's character:
      // the user did not choose a voice for that window and cannot see which one is selected.
      if (session === undefined || !isOrbSession(session)) return ''
      return source.personaFor(source.speech().voice)
    },
  })
}
