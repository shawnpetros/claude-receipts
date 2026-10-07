// receipts: the values it keeps in $.state for the session.
declare module 'claude-code' {
  interface PluginState {
    receipts: {
      /** Tool rows drawn as one dim line each; milestone rows always in full. */
      cleanView: boolean
      /** Bumped to redraw the pane and band alone, not every tool row. */
      tick: number
    }
  }
}
