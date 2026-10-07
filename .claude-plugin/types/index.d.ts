// receipts: the values it keeps in $.state for the session.
declare module 'claude-code' {
  interface PluginState {
    receipts: {
      /** How much the mod draws away: off, clean (tool rows one dim line) or quiet. */
      rows: 'off' | 'clean' | 'quiet'
      /** The level `/receipts clean` returns to from off. */
      rowsLast: 'off' | 'clean' | 'quiet'
      /** A main-loop turn is running; the quiet sites redraw at each turn edge. */
      working: boolean
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
