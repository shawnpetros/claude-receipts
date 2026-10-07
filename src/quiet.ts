/**
 * The quiet level's memory of assistant text: which blocks were interim
 * (drawn as their first line, dim) and which was the turn's final answer
 * (redrawn in full when the turn completes). Keyed by the render's
 * `requestId`, the block's own id, so a redraw finds the same verdict.
 *
 * Drawing only (invariant 4): nothing here touches the stored messages, and
 * a block the mod never saw during a turn (history, a resumed session) is
 * left to Claude Code.
 */

/** Ids kept per kind before the oldest are forgotten; a long session stays small. */
const MAX_IDS = 2_000

export class QuietLog {
  private readonly turnBlocks = new Map<string, string>()
  private readonly interim = new Set<string>()
  private readonly final = new Set<string>()

  /** A block drawn while a turn runs: interim until the turn says otherwise. */
  seen(id: string, text: string): void {
    if (this.final.has(id)) return
    this.turnBlocks.set(id, text)
    this.interim.add(id)
    trim(this.interim)
  }

  /**
   * The turn ended with `answer`: the blocks whose text is part of it are the
   * final answer; failing any, the last block drawn. Returns whether any
   * verdict changed, so the caller knows to redraw.
   */
  finish(answer: string): boolean {
    const blocks = [...this.turnBlocks.entries()]
    this.turnBlocks.clear()
    const flat = answer.trim()
    let finals = blocks.filter(([, text]) => text.trim() !== '' && flat.includes(text.trim())).map(([id]) => id)
    if (finals.length === 0 && blocks.length > 0) finals = [blocks[blocks.length - 1]![0]]
    for (const id of finals) {
      this.interim.delete(id)
      this.final.add(id)
    }
    trim(this.final)
    return finals.length > 0
  }

  kindOf(id: string): 'interim' | 'final' | 'unknown' {
    if (this.final.has(id)) return 'final'
    if (this.interim.has(id)) return 'interim'
    return 'unknown'
  }
}

function trim(ids: Set<string>): void {
  while (ids.size > MAX_IDS) {
    const oldest = ids.values().next().value
    if (oldest === undefined) return
    ids.delete(oldest)
  }
}

/** The first non-empty line of a block, markdown left as is. */
export function firstLineOf(text: string): string {
  return text.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
}

/**
 * The one dim line a hand-back or notification row becomes once its turn
 * ended: `↳ message from @Explore: Found 3 mods`.
 */
export function handbackLineOf(text: string, from: string | undefined): string {
  const head = firstLineOf(text)
  const who = from ? `message from @${from}` : 'notification'
  return head ? `↳ ${who}: ${head}` : `↳ ${who}`
}
