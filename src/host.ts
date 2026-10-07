import type {
  AgentSpawnArgs,
  AgentSpawnResult,
  FsEntry,
  ModelCompleteRequest,
  ModelCompleteResult,
  SessionRepo,
  Timer,
} from 'claude-code'

/**
 * Everything the session logic needs from Claude Code, as plain functions.
 *
 * `hooks/register.ts` builds one from `$` in a top-level `hostOf($)`, so
 * every mods API call stays spelled out where `claude plugin validate` reads
 * it, and nothing under `src/` touches `$`. A test can hand the session a
 * fake host with a scripted clock and store.
 */
export type Host = {
  now: () => Promise<number>
  every: (ms: number, fn: () => void) => Timer
  after: (ms: number, fn: () => void) => Timer
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  storeDelete: (key: string) => Promise<void>
  /** Redraws the pane and the band (they read the tick); tool rows are left alone. */
  redraw: () => void
  classify: (text: string, labels: readonly string[]) => Promise<string | undefined>
  complete: (request: ModelCompleteRequest) => Promise<ModelCompleteResult>
  spawn: (args: AgentSpawnArgs) => Promise<AgentSpawnResult>
  cwd: () => Promise<string>
  repo: () => Promise<SessionRepo | null>
  list: (path: string) => Promise<FsEntry[]>
}
