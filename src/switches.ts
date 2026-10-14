/**
 * The tools panel's MODS section: on and off switches that our mods
 * publish for the one panel to show.
 *
 * Each mod publishes its own list in its own `$.state` key `switches`
 * (`$.store` is a file each plugin owns alone, so it cannot be shared;
 * `$.state` lets any plugin read any value, its owner alone writes it). The
 * panel reads every known mod's list. A press on another mod's switch is a
 * request written to receipts' own `switchRequests` key, `{ [id]: value }`;
 * the owner reads it and applies it. Receipts applies its own at once.
 */

export type Switch = {
  /** The mod that owns the switch. */
  mod: string
  id: string
  label: string
  description: string
  value: boolean
}

/** What a mod publishes: its switches, without the mod name. */
export type PublishedSwitch = Omit<Switch, 'mod'>

function isPublished(value: unknown): value is PublishedSwitch {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string' && typeof entry.label === 'string' && typeof entry.description === 'string' && typeof entry.value === 'boolean'
}

/**
 * Every mod's published list as one, receipts first, then the rest in the
 * order given. A malformed entry, or a mod that published nothing, is
 * skipped, never a crash in a render hook.
 */
export function switchesOf(published: readonly (readonly [mod: string, list: unknown])[]): Switch[] {
  const ordered = [...published].sort((a, b) => (a[0] === 'receipts' ? -1 : b[0] === 'receipts' ? 1 : 0))
  return ordered.flatMap(([mod, list]) => (Array.isArray(list) ? list.filter(isPublished).map(entry => ({ mod, ...entry })) : []))
}

/** Receipts' own switch: the line under an answer that claims done. */
export const RECEIPT_LINE_SWITCH = 'receipts.line'

export function receiptsSwitches(isLineOn: boolean): PublishedSwitch[] {
  return [{ id: RECEIPT_LINE_SWITCH, label: 'Receipt line', description: 'under answers that claim done', value: isLineOn }]
}
