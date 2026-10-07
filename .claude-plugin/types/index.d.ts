// receipts: the values it keeps in $.state for the session.
declare module 'claude-code' {
  interface PluginState {
    receipts: {
      /** Tool rows drawn as one dim line each; milestone rows always in full. */
      cleanView: boolean
      /** Plain tool rows draw nothing and milestones one dim line, during the turn and after. */
      suppress: boolean
      /** The band folded to its title row. */
      collapsed: boolean
      /** The settings popover is open in the band. */
      toolsOpen: boolean
      /** The spike switch, overriding the userConfig default for the session. */
      spike: boolean
      /** Bumped to redraw the pane and band alone, not every tool row. */
      tick: number
    }
  }
}
