// Who compacted: Claude through the compact tool, the user's /compact,
// Claude Code's autocompact, another plugin, or `unseen`, a compaction only the
// fill's drop showed, its session.compact hook skipped.
export type Compactor = 'claude' | 'user' | 'auto' | 'plugin' | 'unseen';

// One kind of compaction: how many, and the tokens they took out of the window.
export type Tally = { compactions: number; tokens: number };

// The compactions counted, in all and by who compacted, and how many of them had
// their tokens estimated from the fill's readings rather than reported.
export type Stats = { compactions: number; tokens: number; estimated: number; by: Partial<Record<Compactor, Tally>> };

declare module 'claude-code' {
  interface PluginState {
    // The session's statistics, and the compactions since the user last wrote,
    // kept by the host so a reload of the mod starts neither over.
    'context-guard': { session: Stats; sinceUser: number };
  }
}
