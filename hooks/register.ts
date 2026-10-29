import { update } from 'claude-code';
import type {
  EngineInterface,
  PluginOptions,
  PromptOrigin,
  Register,
  SessionCompactTrigger,
  SessionContextBreakdown,
} from 'claude-code';
import type { Compactor, Stats } from '../types';

const USAGE = 'context_usage';
const COMPACT = 'compact';
const USAGE_CALLED = `mcp__context-guard__${USAGE}`;
const COMPACT_CALLED = `mcp__context-guard__${COMPACT}`;

// The session's statistics and the compactions since the user last wrote, in
// $.state; the statistics of every session, in $.store.
const SESSION = { plugin: 'context-guard', key: 'session' } as const;
const SINCE_USER = { plugin: 'context-guard', key: 'sinceUser' } as const;
const TOTAL = 'statistics';

// Where the user writes from: the terminal, an SDK host such as VS Code's
// extension, Remote Control, or Slack.
const USER_ORIGINS = new Set<PromptOrigin['kind']>(['composer', 'sdk', 'bridge', 'slack-ping']);

// Who compacted, by the session.compact hook's trigger, where the mod didn't.
const COMPACTORS: Record<Exclude<SessionCompactTrigger, 'precompute'>, Compactor> = {
  manual: 'user',
  auto: 'auto',
  plugin: 'plugin',
};

// The window the warning is a share of: autocompact's where it's on (what
// /autocompact sets, capped at the model's), else the model's whole window.
type Base = { window: number; isAutoCompact: boolean };

// A compaction the model asked for: the /compact line saying how it came about,
// the step the model named to carry on with, the fill when it asked, whether
// /compact is queued, and whether its session.compact hook counted it.
type Compaction = { args: string; next: string; tokens: number | null; isQueued: boolean; isCounted: boolean };

// The setting, and what the session has been told and asked so far.
type Guard = {
  warnPercent: number;
  compactionLimit: number;
  // Read again as each turn ends, so a change of /autocompact counts from the next.
  base: Base | undefined;
  // Whether the model and the user have been told the context passed the
  // warning; it falls back with the context, so a compaction lets it come again.
  isWarned: boolean;
  // What the model has yet to read, attached to the next tool result or prompt:
  // the warning, and the note to stop past the limit, until the user writes.
  note: string | undefined;
  stop: string | undefined;
  // The compaction the model asked for, until it has run.
  compaction: Compaction | undefined;
  // The one running, so the session.compact hook knows the model asked for it.
  running: Compaction | undefined;
  // The fill at the last reading, whose drop shows a compaction no hook saw.
  reading: number | undefined;
  // A compaction counted without its tokens, read from the next lower fill.
  pending: { by: Compactor; before: number } | undefined;
  // What became of the compactions asked for, latest last, which context_usage shows.
  steps: string[];
};

// Where the count of compactions since the user last wrote stands against the
// limit: within it, past it (the model is told to stop), or a compaction past
// that (its tool calls are refused).
type LimitState = 'open' | 'stopping' | 'closed';

// The statistics as context_usage shows them: their tokens are the ones the
// compactions removed, kept as `tokens` in $.state and $.store.
type Shown = {
  compactions: number;
  removed: number;
  estimated: number;
  by: Partial<Record<Compactor, { compactions: number; removed: number }>>;
};

// What context_usage answers: the tokens used, the warning's point (`of` the
// window it's a share of), and where Claude Code compacts on its own (null
// where the session gave no breakdown to read it from), and so on.
type Fill = {
  used: number | null;
  window: number;
  percent: number | null;
  warning: { at: number; percent: number; of: number };
  autoCompact: { isEnabled: boolean; at: number | null; percent: number | null; window: number } | null;
  compaction: { isAsked: boolean; steps: string[] };
  limit: { compactions: number; sinceUser: number; state: LimitState };
  statistics: { thisSession: Shown; allSessions: Shown };
};

function guardOf(options: PluginOptions): Guard {
  return {
    warnPercent: Number(options.warnPercent ?? 80),
    compactionLimit: Number(options.compactionLimit ?? 3),
    base: undefined,
    isWarned: false,
    note: undefined,
    stop: undefined,
    compaction: undefined,
    running: undefined,
    reading: undefined,
    pending: undefined,
    steps: [],
  };
}

function step(guard: Guard, text: string) {
  guard.steps = [...guard.steps, text].slice(-12);
}

// 967000 as 967,000.
function counted(count: number | null) {
  return String(count ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function compactionsOf(count: number) {
  return `${count} compaction${count === 1 ? '' : 's'}`;
}

function baseOf(window: number, breakdown: SessionContextBreakdown | undefined): Base {
  return breakdown?.isAutoCompactEnabled === true
    ? { window: breakdown.rawMaxTokens, isAutoCompact: true }
    : { window, isAutoCompact: false };
}

// Reads the base from /context's breakdown, estimated locally.
async function readBase($: EngineInterface, guard: Guard) {
  const { context } = await $.session.usage({ breakdown: 'summary' });
  guard.base = baseOf(context.window, context.breakdown);

  return guard.base;
}

function warnTokensOf(guard: Guard, base: Base) {
  return Math.round((base.window * guard.warnPercent) / 100);
}

function windowName(base: Base) {
  return base.isAutoCompact ? 'autocompact window' : 'context window';
}

function statsOf(): Stats {
  return { compactions: 0, tokens: 0, estimated: 0, by: {} };
}

async function totalOf($: EngineInterface) {
  return ((await $.store.get(TOTAL)) as Stats | undefined) ?? statsOf();
}

function shownOf(stats: Stats): Shown {
  const by: Shown['by'] = {};
  for (const [who, tally] of Object.entries(stats.by)) {
    by[who as Compactor] = { compactions: tally.compactions, removed: tally.tokens };
  }

  return { compactions: stats.compactions, removed: stats.tokens, estimated: stats.estimated, by };
}

async function sinceUserOf($: EngineInterface) {
  const { value = 0 } = await $.state.get(SINCE_USER);

  return value;
}

function limitStateOf(guard: Guard, since: number): LimitState {
  if (since <= guard.compactionLimit) return 'open';

  return since === guard.compactionLimit + 1 ? 'stopping' : 'closed';
}

async function fillOf($: EngineInterface, guard: Guard): Promise<Fill> {
  const { context } = await $.session.usage({ breakdown: 'summary' });
  const breakdown = context.breakdown;
  const base = baseOf(context.window, breakdown);
  guard.base = base;
  const at = breakdown?.autoCompactThreshold ?? null;
  const since = await sinceUserOf($);
  const { value: session = statsOf() } = await $.state.get(SESSION);

  return {
    used: context.tokens ?? null,
    window: context.window,
    percent: context.percent ?? null,
    warning: { at: warnTokensOf(guard, base), percent: guard.warnPercent, of: base.window },
    autoCompact:
      breakdown === undefined
        ? null
        : {
            isEnabled: breakdown.isAutoCompactEnabled,
            at,
            percent: at === null ? null : Math.round((at / context.window) * 100),
            window: breakdown.rawMaxTokens,
          },
    compaction: { isAsked: guard.compaction !== undefined, steps: guard.steps },
    limit: { compactions: guard.compactionLimit, sinceUser: since, state: limitStateOf(guard, since) },
    statistics: { thisSession: shownOf(session), allSessions: shownOf(await totalOf($)) },
  };
}

function warningOf(fill: Fill) {
  const auto = fill.autoCompact;
  const isAuto = auto !== null && auto.isEnabled;
  const name = windowName({ window: fill.warning.of, isAutoCompact: isAuto });
  const when =
    isAuto && auto.at !== null
      ? ` Autocompact will trigger at ${counted(auto.at)} tokens;`
      : auto?.isEnabled === false
        ? ' Autocompact is off;'
        : '';

  return (
    `context-guard: Based on session policy your context should not grow too far past ${fill.warning.percent}% ` +
    `of its ${counted(fill.warning.of)}-token ${name} (${counted(fill.warning.at)} tokens). ` +
    'At your earliest convenience find a stopping point, update documentation if necessary, ' +
    'inform the user that you are initiating a context compaction, ' +
    `and invoke the compact tool (${COMPACT_CALLED}) with your next step: it compacts the session when the turn ends ` +
    `and then sends you that step to carry on with.${when} ${counted(fill.used)} of ${counted(fill.window)} tokens are in use.`
  );
}

// The /compact line, the mod's own: how the compaction came about. What the
// summary keeps is the project's, a "Compact instructions" section in CLAUDE.md.
function argsOf(fill: Fill) {
  const name = windowName({ window: fill.warning.of, isAutoCompact: fill.autoCompact?.isEnabled === true });

  return (
    `context-guard: Claude asked for this compaction at a stopping point, with ${counted(fill.used)} tokens ` +
    `of its ${counted(fill.warning.of)}-token ${name} in use. ` +
    'Once it is done, context-guard gives Claude the next step it named.'
  );
}

function pastOf(since: number, limit: number) {
  return `${compactionsOf(since)} since the user last wrote, past the limit of ${limit}`;
}

function stopOf(since: number, limit: number) {
  return (
    `context-guard: The session has had ${pastOf(since, limit)}. Don't compact again or carry on: ` +
    'at a stopping point now, save what later turns need, tell the user where things stand and what you would ' +
    'do next, and end your turn. One more compaction before they write, and context-guard refuses your tool calls.'
  );
}

// Adds a compaction to the statistics (count 1), or the tokens of one already
// counted (count 0).
function addedTo(stats: Stats, by: Compactor, count: number, tokens: number, isEstimated: boolean): Stats {
  const tally = stats.by[by] ?? { compactions: 0, tokens: 0 };

  return {
    compactions: stats.compactions + count,
    tokens: stats.tokens + tokens,
    estimated: stats.estimated + (isEstimated ? count : 0),
    by: { ...stats.by, [by]: { compactions: tally.compactions + count, tokens: tally.tokens + tokens } },
  };
}

async function tally($: EngineInterface, by: Compactor, count: number, tokens: number, isEstimated: boolean) {
  await update($, SESSION, stats => addedTo(stats ?? statsOf(), by, count, tokens, isEstimated));
  await $.store.set(TOTAL, addedTo(await totalOf($), by, count, tokens, isEstimated));
}

// Counts a compaction, with its tokens where they're known, else from the fill
// before it and the next lower reading. One not the user's counts toward the
// limit: past it the model is told to stop, and past one more its tool calls
// are refused (the tool.call hook) until the user writes.
async function countCompaction(
  $: EngineInterface,
  guard: Guard,
  by: Compactor,
  before: number | null | undefined,
  after: number | undefined,
) {
  const isKnown = before != null && after !== undefined;
  guard.reading = undefined;
  guard.pending = !isKnown && before != null ? { by, before } : undefined;
  // An unseen compaction's tokens are the fill's drop, an estimate too.
  await tally($, by, 1, isKnown ? Math.max(0, before - after) : 0, !isKnown || by === 'unseen');
  if (by === 'user') return;

  const since = (await sinceUserOf($)) + 1;
  await $.state.set(SINCE_USER, since);
  const limit = guard.compactionLimit;
  if (since === limit + 1) {
    guard.stop = stopOf(since, limit);
    $.ui.toast(
      `context-guard: ${compactionsOf(since)} without you, past the limit of ${limit}: Claude is told to stop`,
    );
  } else if (since > limit + 1) {
    $.ui.toast(`context-guard: ${compactionsOf(since)} without you: Claude's tool calls are refused until you write`);
  }
}

// Counting mustn't keep a compaction's hook, or the mod's carrying on, from finishing.
async function countSafely(
  $: EngineInterface,
  guard: Guard,
  by: Compactor,
  before: number | null | undefined,
  after: number | undefined,
) {
  try {
    await countCompaction($, guard, by, before, after);
  } catch (error) {
    step(guard, `counting failed: ${messageOf(error)}`);
  }
}

// A reading of the fill: the tokens of a compaction counted without them, once
// it reads lower; or a compaction no session.compact hook saw, when the fill
// falls by more than half between readings.
async function readFill($: EngineInterface, guard: Guard, tokens: number) {
  const { pending, reading } = guard;
  if (pending !== undefined) {
    if (tokens < pending.before) {
      guard.pending = undefined;
      await tally($, pending.by, 0, pending.before - tokens, false);
    }
  } else if (reading !== undefined && tokens < reading / 2) {
    await countCompaction($, guard, 'unseen', reading, tokens);
  }
  guard.reading = tokens;
}

// After a compaction, of any kind: the fill starts over. The session.compact
// hook isn't always reached, so check lets the warning go too.
function reset($: EngineInterface, guard: Guard) {
  guard.isWarned = false;
  guard.note = undefined;
  guard.compaction = undefined;
  $.ui.status(undefined);
}

// Reads the context's fill and, the first time it passes the warning, tells
// the user and leaves a note for the model.
async function check($: EngineInterface, guard: Guard) {
  const base = guard.base ?? (await readBase($, guard));
  const { context } = await $.session.usage();
  if (context.tokens === undefined) return;

  await readFill($, guard, context.tokens);
  const share = Math.round((context.tokens / base.window) * 100);
  const isPast = context.tokens >= warnTokensOf(guard, base);
  $.ui.status(isPast ? `context ${share}% of the ${windowName(base)}` : undefined);
  if (!isPast) {
    // Fallen back, as after a compaction, even one the session.compact hook
    // didn't see: a warning not yet read no longer holds.
    guard.isWarned = false;
    guard.note = undefined;
    return;
  }
  if (guard.isWarned) return;

  guard.isWarned = true;
  guard.note = warningOf(await fillOf($, guard));
  $.ui.toast(`Context ${share}% of the ${windowName(base)}, past the ${guard.warnPercent}% warning`);
}

// The notes the model has yet to read, taken to attach to a tool result or prompt.
function notesTaken(guard: Guard) {
  const notes = [guard.note, guard.stop].filter(note => note !== undefined);
  guard.note = undefined;
  guard.stop = undefined;

  return notes;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// The step for the session refusing the compaction. A headless session's
// refusal is the way there, not a fault, so it's shown as the route taken; any
// other's reason is shown whole. Exported for its test, as the test kit's
// stand-in can't refuse with a reason of its own.
export function refusalOf(message: string) {
  return /\bheadless\b/.test(message) ? 'headless: compacting by /compact' : `refused: ${message}`;
}

// Runs the compaction the model asked for, from the turn.complete hook, the
// event the host names for it: one from a timer set there never ran in a
// session (2.1.308), and the host refuses one from prompt.submit, which holds
// the turn about to start. Where the session refuses it, /compact is queued.
async function compactAsked($: EngineInterface, guard: Guard) {
  const asked = guard.compaction;
  if (asked === undefined || asked.isQueued) return;

  guard.running = asked;
  try {
    const done = await $.session.compact({ instructions: asked.args });
    guard.running = undefined;
    if (done.skip === undefined) {
      reset($, guard);
      step(guard, 'compacted');
      $.ui.toast('context-guard compacted the session');
      if (!asked.isCounted) await countSafely($, guard, 'claude', done.tokensBefore ?? asked.tokens, done.tokensAfter);
      await carryOn($, guard, asked, 'The session was compacted as you asked.');
    } else {
      guard.compaction = undefined;
      step(guard, `skipped: ${done.skip}`);
      $.ui.toast(`context-guard's compaction was skipped: ${done.skip}`);
      await carryOn($, guard, asked, `The compaction you asked for was skipped: ${done.skip}.`);
    }
  } catch (error) {
    step(guard, refusalOf(messageOf(error)));
    queueCompact($, guard, asked);
  }
}

// A headless session, as VS Code's extension runs, compacts only inside a turn
// of its own, a /compact prompt, so /compact runs as the user would type it,
// queued until the session is idle. The hook doesn't wait on it: the turn waits
// on the hook. The fill falling back after it lets the warning go (check).
function queueCompact($: EngineInterface, guard: Guard, asked: Compaction) {
  asked.isQueued = true;
  step(guard, '/compact queued');
  void $.command.run({ command: 'compact', args: asked.args }).then(
    async () => {
      guard.running = undefined;
      if (guard.compaction === asked) guard.compaction = undefined;
      step(guard, '/compact ran');
      // Its tokens from the next reading, where its session.compact hook was skipped.
      if (!asked.isCounted) await countSafely($, guard, 'claude', asked.tokens, undefined);
      await carryOn($, guard, asked, 'The session was compacted as you asked.');
    },
    (error: unknown) => {
      // Left asked, to be tried again as the next turn ends.
      guard.running = undefined;
      asked.isQueued = false;
      step(guard, `/compact refused: ${messageOf(error)}`);
    },
  );
}

// Starts the turn after the compaction with the step the model named, a prompt
// from the mod queued until the session is idle: the model asked at a stopping
// point, so it carries on rather than waiting on the user. Past the limit it
// starts the turn to say where things stand instead, and a compaction past
// that starts none.
async function carryOn($: EngineInterface, guard: Guard, asked: Compaction, what: string) {
  let since = 0;
  try {
    since = await sinceUserOf($);
  } catch (error) {
    step(guard, `reading failed: ${messageOf(error)}`);
  }
  const limit = guard.compactionLimit;
  if (since > limit + 1) {
    step(guard, 'next step held: past the limit');
    return;
  }

  const isPast = since > limit;
  // Said in this prompt, so not again beside a tool result.
  if (isPast) guard.stop = undefined;
  const text = isPast
    ? `context-guard: ${what} That makes ${pastOf(since, limit)}: don't carry on with the step you named ` +
      `(${asked.next}). Tell the user where things stand and what that step is, and end your turn.`
    : `context-guard: ${what} Carry on with the next step you named: ${asked.next}`;
  const sent = isPast ? 'stop sent' : 'next step sent';
  void $.prompt.submit({ text }).then(
    entered => step(guard, entered.drop === undefined ? sent : `${sent}, dropped: ${entered.drop}`),
    (error: unknown) => step(guard, `${sent}, refused: ${messageOf(error)}`),
  );
}

export const register: Register = (on, options) => {
  const guard = guardOf(options);

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: USAGE,
      description:
        "How full this session's context window is: the tokens in it, the model's window and the percentage, " +
        "the point context-guard warns at, Claude Code's autocompact (whether it's on, its window, " +
        'and the tokens and percentage it triggers at), the compactions since the user last wrote against ' +
        "context-guard's limit, and the compactions counted, this session's and every session's. Costs nothing to call.",
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    });
    await $.tool.register({
      name: COMPACT,
      description:
        'Compacts this session once the current turn ends, as /compact would, then starts the next turn with the ' +
        'step you name. Call it at a stopping point, with what later turns need already saved, when context-guard ' +
        'warns that the context is filling.',
      inputSchema: {
        type: 'object',
        properties: {
          next: {
            type: 'string',
            description: 'What to do once the session is compacted: context-guard sends it to you as the next prompt.',
          },
        },
        required: ['next'],
      },
      isDeferred: false,
    });

    return next(e);
  });

  on('tool.call', async ($, e, next) => {
    if (e.tool === USAGE_CALLED) return { result: JSON.stringify(await fillOf($, guard), null, 2) };

    // A compaction past the limit's: refused until the user writes.
    const since = e.agentId === undefined ? await sinceUserOf($) : 0;
    const limit = guard.compactionLimit;
    if (since > limit + 1) {
      return {
        deny:
          `context-guard: The session has had ${pastOf(since, limit)}, so your tool calls are refused until they ` +
          'write. Tell them where things stand and end your turn.',
      };
    }

    if (e.tool === COMPACT_CALLED) {
      if (e.agentId !== undefined) return { deny: 'context-guard: only the main conversation compacts.' };
      if (since > limit) {
        return {
          deny:
            `context-guard: The session has had ${pastOf(since, limit)}: don't compact again. ` +
            'Save what later turns need, tell the user where things stand, and end your turn.',
        };
      }

      const named = (e as { next?: unknown }).next;
      if (typeof named !== 'string' || named.trim() === '') {
        return { deny: 'context-guard: name the step to carry on with once compacted, as next.' };
      }
      const fill = await fillOf($, guard);
      guard.compaction = {
        args: argsOf(fill),
        next: named.trim(),
        tokens: fill.used,
        isQueued: false,
        isCounted: false,
      };
      step(guard, 'asked');

      return { result: 'context-guard will compact the session once this turn ends, then send you that next step.' };
    }

    const ran = await next(e);
    // A subagent's calls fill its own window, not this one.
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true) return ran;

    await check($, guard);
    const notes = notesTaken(guard);
    if (notes.length === 0) return ran;

    return { ...ran, context: [...(ran.context ?? []), ...notes] };
  });

  on('prompt.submit', async ($, e, next) => {
    // The user writing starts the count toward the limit again.
    if (e.origin !== undefined && USER_ORIGINS.has(e.origin.kind)) {
      guard.stop = undefined;
      if ((await sinceUserOf($)) > 0) await $.state.set(SINCE_USER, 0);
    }
    if (e.command !== undefined) return next(e);

    const notes = notesTaken(guard);
    if (notes.length === 0) return next(e);

    return next({ ...e, context: [...(e.context ?? []), ...notes] });
  });

  on('turn.complete', async ($, e, next) => {
    const done = await next(e);
    if (e.agentId !== undefined) return done;

    // A failed reading mustn't keep the compaction asked for from running.
    try {
      await readBase($, guard);
      await check($, guard);
    } catch (error) {
      step(guard, `reading failed: ${messageOf(error)}`);
    }
    await compactAsked($, guard);

    return done;
  });

  on('session.compact', async ($, e, next) => {
    const done = await next(e);
    if (e.agentId !== undefined || e.trigger === 'precompute' || done.skip !== undefined) return done;

    reset($, guard);
    const running = guard.running;
    if (running !== undefined) running.isCounted = true;
    await countSafely(
      $,
      guard,
      running === undefined ? COMPACTORS[e.trigger] : 'claude',
      done.tokensBefore ?? guard.reading,
      done.tokensAfter,
    );

    return done;
  });
};
