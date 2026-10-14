// receipts: the values it keeps in $.state for the session.
declare module 'claude-code' {
  interface PluginState {
    /** Read only: the switches a buddy mod publishes for the tools panel. */
    buddy: {
      switches: { id: string; label: string; description: string; value: boolean }[]
    }
    receipts: {
      /** How much the mod draws away: off, clean (tool rows one dim line) or quiet. */
      rows: 'off' | 'clean' | 'quiet'
      /** The level `/receipts clean` returns to from off. */
      rowsLast: 'off' | 'clean' | 'quiet'
      /** A main-loop turn is running; the quiet sites redraw at each turn edge. */
      working: boolean
      /** The tools panel is open in the band. */
      toolsOpen: boolean
      /** Quiet folds subagent hand-backs and peer messages. */
      chatter: boolean
      /** The receipt line under an answer that claims done. */
      receiptLine: boolean
      /** Receipts' switches, published for any tools panel to read. */
      switches: { id: string; label: string; description: string; value: boolean }[]
      /** Presses on other mods' switches, `{ [id]: value }`, for each owner to apply. */
      switchRequests: Record<string, boolean>
      /** The spike switch, overriding the userConfig default for the session. */
      spike: boolean
      /** Bumped to redraw the pane and band alone, not every tool row. */
      tick: number
    }
  }
}
