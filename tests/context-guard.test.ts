import { expect, mock, test } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { On, SessionContextBreakdown, SessionUsage, TurnCompleteInput } from 'claude-code';
import { refusalOf } from '../hooks/register';

const USAGE = 'mcp__context-guard__context_usage';
const COMPACT = 'mcp__context-guard__compact';
const WINDOW = 1_000_000;
// As a session VS Code's extension refused a mod's compaction (2.1.308).
const HEADLESS = '$.session.compact: not available in a headless (-p / SDK) session yet';

const TURN: TurnCompleteInput = {
  answer: 'done',
  durationMs: 1,
  isAborted: false,
  turnId: 't1',
  reason: 'answer',
};

// Stands for the engine: the model's window filled to `fill.percent`, which a
// compaction brings down to 5%; autocompact's window, and where it triggers
// (off when null), as /autocompact 750k left them; why the session refuses a
// mod's compaction, if it does; and what the mod showed, asked for and
// submitted. The store starts with `stored`, as earlier sessions left it.
function engine(on: On, stored: Record<string, unknown> = {}) {
  const fill = {
    percent: 10,
    autoWindow: 750_000,
    autoAt: 717_000 as number | null,
    refusal: undefined as string | undefined,
  };
  const seen = {
    toasts: [] as string[],
    compactions: [] as (string | undefined)[],
    commands: [] as string[],
    prompts: [] as string[],
  };

  on('session.usage', (_, e) => {
    const usage: SessionUsage = {
      startedAt: 0,
      context: { tokens: (fill.percent * WINDOW) / 100, window: WINDOW, percent: fill.percent },
      rateLimits: [],
    };
    if (e.breakdown !== undefined) {
      // The fields the mod reads; the rest of /context's breakdown is left out.
      usage.context.breakdown = {
        isAutoCompactEnabled: fill.autoAt !== null,
        rawMaxTokens: fill.autoWindow,
        ...(fill.autoAt === null ? {} : { autoCompactThreshold: fill.autoAt }),
      } as SessionContextBreakdown;
    }
    return { value: usage };
  });
  on('tool.register', (_, e) => ({ value: { tool: e.name } }));
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text);
    return { value: undefined };
  });
  on('ui.status', () => ({ value: undefined }));
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('tool.call', () => ({ result: {} }));
  on('prompt.submit', (_, e) => {
    if (e.origin?.kind === 'plugin') seen.prompts.push(e.text);
    return { text: e.text, context: e.context };
  });
  on('turn.complete', (_, e) => ({ text: e.answer }));
  on('command.run', (_, e) => {
    seen.commands.push(`/${e.command} ${e.args}`);
    return { text: '' };
  });
  on('session.compact', (_, e) => {
    if (fill.refusal !== undefined) throw new Error(fill.refusal);
    seen.compactions.push(e.instructions);
    const tokensBefore = (fill.percent * WINDOW) / 100;
    fill.percent = 5;
    return {
      messages: [{ role: 'user' as const, text: 'The summary.', toolUses: [] }],
      tokensBefore,
      tokensAfter: 50_000,
    };
  });

  mock.store(on, stored);

  return { fill, seen };
}

async function start($: Engine) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
}

async function bash($: Engine) {
  return (await $.tool.call({ tool: 'Bash', command: 'ls' })).context?.[0];
}

test('the usage tool answers the fill, the warning, autocompact, the limit and the statistics', async ($, on) => {
  const { fill } = engine(on);
  await start($);
  fill.percent = 42;

  const ran = await $.tool.call({ tool: USAGE } as never);

  expect(JSON.parse(String(ran.result))).toEqual({
    used: 420_000,
    window: WINDOW,
    percent: 42,
    warning: { at: 600_000, percent: 80, of: 750_000 },
    autoCompact: { isEnabled: true, at: 717_000, percent: 72, window: 750_000 },
    compaction: { isAsked: false, steps: [] },
    limit: { compactions: 3, sinceUser: 0, state: 'open' },
    statistics: { thisSession: NONE, allSessions: NONE },
  });
  // Pretty printed, for the user reading it in the transcript.
  expect(String(ran.result)).toMatch(/^\{\n {2}"used": 420000,\n {2}"window": 1000000,\n/);
});

const NONE = { compactions: 0, removed: 0, estimated: 0, by: {} };

async function usageOf($: Engine) {
  return JSON.parse(String((await $.tool.call({ tool: USAGE } as never)).result));
}

async function stepsOf($: Engine) {
  return (await usageOf($)).compaction.steps;
}

test('past the share of the autocompact window, the model is told once', async ($, on) => {
  const { fill, seen } = engine(on);
  await start($);

  fill.percent = 59;
  expect(await bash($)).toBeUndefined();

  fill.percent = 62;
  expect(await bash($)).toBe(
    'context-guard: Based on session policy your context should not grow too far past 80% ' +
      'of its 750,000-token autocompact window (600,000 tokens). ' +
      'At your earliest convenience find a stopping point, update documentation if necessary, ' +
      'inform the user that you are initiating a context compaction, ' +
      `and invoke the compact tool (${COMPACT}) with your next step: it compacts the session when the turn ends ` +
      'and then sends you that step to carry on with. ' +
      'Autocompact will trigger at 717,000 tokens; 620,000 of 1,000,000 tokens are in use.',
  );
  expect(seen.toasts).toEqual(['Context 83% of the autocompact window, past the 80% warning']);

  fill.percent = 65;
  expect(await bash($)).toBeUndefined();
});

test('with autocompact off, the warning is a share of the whole window', async ($, on) => {
  const { fill } = engine(on);
  await start($);
  fill.autoAt = null;

  fill.percent = 72;
  expect(await bash($)).toBeUndefined();

  fill.percent = 82;
  const warning = await bash($);
  expect(warning).toMatch(/too far past 80% of its 1,000,000-token context window \(800,000 tokens\)\./);
  expect(warning).toMatch(/to carry on with\. Autocompact is off; 820,000 of 1,000,000 tokens are in use\.$/);
});

test('the window is read again as each turn ends', async ($, on) => {
  const { fill } = engine(on);
  await start($);
  fill.percent = 62;
  fill.autoWindow = 1_000_000;
  fill.autoAt = 967_000;

  await $.turn.complete(TURN);

  expect(await bash($)).toBeUndefined();
  fill.percent = 81;
  expect(await bash($)).toMatch(/of its 1,000,000-token autocompact window \(800,000 tokens\)/);
});

test('the warning takes its setting', { options: { warnPercent: 40 } }, async ($, on) => {
  const { fill } = engine(on);
  await start($);
  fill.percent = 42;

  expect(await bash($)).toMatch(/too far past 40% of its 750,000-token autocompact window \(300,000 tokens\)/);
});

test('a warning found as the turn ends reaches the next prompt', async ($, on) => {
  const { fill } = engine(on);
  await start($);
  fill.percent = 70;

  await $.turn.complete(TURN);
  const entered = await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } });

  expect(entered.context?.[0]).toMatch(/700,000 of 1,000,000 tokens/);
});

test('a warning not yet read goes once the fill falls back', async ($, on) => {
  const { fill } = engine(on);
  await start($);
  fill.percent = 70;
  await $.turn.complete(TURN);

  // As a compaction whose session.compact the mod didn't see leaves it.
  fill.percent = 5;
  await $.turn.complete(TURN);
  const entered = await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } });

  expect(entered.context).toBeUndefined();
});

const ARGS =
  'context-guard: Claude asked for this compaction at a stopping point, with 620,000 tokens ' +
  'of its 750,000-token autocompact window in use. Once it is done, context-guard gives Claude the next step it named.';
const CARRY_ON =
  'context-guard: The session was compacted as you asked. Carry on with the next step you named: report the steps';

test('the compact tool compacts the session as the turn ends, then carries on', async ($, on) => {
  const clock = mock.clock(on);
  const { fill, seen } = engine(on);
  await start($);
  fill.percent = 62;
  await bash($);

  const asked = await $.tool.call({ tool: COMPACT, next: ' report the steps ' } as never);
  expect(asked.result).toBe(
    'context-guard will compact the session once this turn ends, then send you that next step.',
  );
  await bash($);
  expect(seen.compactions).toEqual([]);

  await $.turn.complete(TURN);
  await clock.settle();
  expect(seen.compactions).toEqual([ARGS]);
  expect(seen.toasts).toContain('context-guard compacted the session');
  expect(seen.prompts).toEqual([CARRY_ON]);
  expect(await stepsOf($)).toEqual(['asked', 'compacted', 'next step sent']);
  const counted = {
    compactions: 1,
    removed: 570_000,
    estimated: 0,
    by: { claude: { compactions: 1, removed: 570_000 } },
  };
  expect((await usageOf($)).statistics).toEqual({ thisSession: counted, allSessions: counted });

  // The fill fell back, so the warning comes again past it.
  fill.percent = 61;
  expect(await bash($)).toMatch(/610,000 of 1,000,000 tokens/);
});

test('in a headless session, /compact is queued in its place', async ($, on) => {
  const clock = mock.clock(on);
  const { fill, seen } = engine(on);
  await start($);
  fill.percent = 62;
  fill.refusal = HEADLESS;

  await $.tool.call({ tool: COMPACT, next: 'report the steps' } as never);
  await $.turn.complete(TURN);
  await clock.settle();

  expect(seen.commands).toEqual([`/compact ${ARGS}`]);
  expect(seen.prompts).toEqual([CARRY_ON]);
  const steps = await stepsOf($);
  expect(steps[0]).toBe('asked');
  // The kit words the stand-in's refusal its own way, so the step for it is
  // refusalOf's test's.
  expect(steps[1]).toMatch(/^refused: /);
  expect(steps.slice(2)).toEqual(['/compact queued', '/compact ran', 'next step sent']);

  // Its session.compact hook didn't run, so its tokens are the fill's drop by the next reading.
  fill.percent = 6;
  await bash($);
  expect((await usageOf($)).statistics.thisSession).toEqual({
    compactions: 1,
    removed: 560_000,
    estimated: 1,
    by: { claude: { compactions: 1, removed: 560_000 } },
  });
});

test("a headless session's refusal is shown as the route taken, any other's with its reason", () => {
  expect(refusalOf(`context-guard: ${HEADLESS}: compaction here runs inside a turn (a /compact prompt)`)).toBe(
    'headless: compacting by /compact',
  );
  expect(refusalOf('context-guard: the session is busy')).toBe('refused: context-guard: the session is busy');
});

test('every session adds to the total', async ($, on) => {
  // As the store keeps it, its tokens not yet shown as removed.
  const earlier = {
    compactions: 2,
    tokens: 1_000_000,
    estimated: 0,
    by: { auto: { compactions: 2, tokens: 1_000_000 } },
  };
  const { fill } = engine(on, { statistics: earlier });
  await start($);
  fill.percent = 62;
  await bash($);

  await $.tool.call({ tool: COMPACT, next: 'report the steps' } as never);
  await $.turn.complete(TURN);

  expect((await usageOf($)).statistics.allSessions).toEqual({
    compactions: 3,
    removed: 1_570_000,
    estimated: 0,
    by: { auto: { compactions: 2, removed: 1_000_000 }, claude: { compactions: 1, removed: 570_000 } },
  });
});

// A compaction whose session.compact hook was skipped, as autocompact's can be:
// the fill read before it, and after.
async function compactedUnseen($: Engine, fill: { percent: number }) {
  fill.percent = 70;
  await bash($);
  fill.percent = 7;
  return bash($);
}

test('a fall of the fill by more than half is a compaction', async ($, on) => {
  const { fill } = engine(on);
  await start($);

  await compactedUnseen($, fill);

  expect((await usageOf($)).statistics.thisSession).toEqual({
    compactions: 1,
    removed: 630_000,
    estimated: 1,
    by: { unseen: { compactions: 1, removed: 630_000 } },
  });
  expect((await usageOf($)).limit).toEqual({ compactions: 3, sinceUser: 1, state: 'open' });
});

test(
  'past the limit the model is told to stop, and past one more refused',
  { options: { compactionLimit: 1 } },
  async ($, on) => {
    const { fill, seen } = engine(on);
    await start($);

    expect(await compactedUnseen($, fill)).toBeUndefined();
    const stop = await compactedUnseen($, fill);
    expect(stop).toMatch(
      /^context-guard: The session has had 2 compactions since the user last wrote, past the limit of 1\. Don't compact again/,
    );
    expect(seen.toasts).toContain(
      'context-guard: 2 compactions without you, past the limit of 1: Claude is told to stop',
    );

    const asked = await $.tool.call({ tool: COMPACT, next: 'report the steps' } as never);
    expect(JSON.stringify(asked)).toMatch(/past the limit of 1: don't compact again\./);
    expect((await usageOf($)).limit.state).toBe('stopping');

    await compactedUnseen($, fill);
    const refused = await $.tool.call({ tool: 'Bash', command: 'ls' });
    expect(JSON.stringify(refused)).toMatch(
      /3 compactions since the user last wrote, past the limit of 1, so your tool calls are refused/,
    );

    // The user writing opens it again.
    await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } });
    expect((await usageOf($)).limit).toEqual({ compactions: 1, sinceUser: 0, state: 'open' });
    expect(await bash($)).toBeUndefined();
  },
);

test(
  'a compaction past the limit sends no next step but the stop',
  { options: { compactionLimit: 0 } },
  async ($, on) => {
    const clock = mock.clock(on);
    const { fill, seen } = engine(on);
    await start($);
    fill.percent = 62;
    await bash($);

    await $.tool.call({ tool: COMPACT, next: 'report the steps' } as never);
    await $.turn.complete(TURN);
    await clock.settle();

    expect(seen.prompts).toEqual([
      'context-guard: The session was compacted as you asked. That makes 1 compaction since the user last wrote, ' +
        "past the limit of 0: don't carry on with the step you named (report the steps). " +
        'Tell the user where things stand and what that step is, and end your turn.',
    ]);
    expect((await stepsOf($)).at(-1)).toBe('stop sent');
  },
);

test('the compact tool wants the next step', async ($, on) => {
  const { seen } = engine(on);
  await start($);

  await $.tool.call({ tool: COMPACT, next: ' ' } as never);
  await $.turn.complete(TURN);

  expect(seen.compactions).toEqual([]);
  expect(await stepsOf($)).toEqual([]);
});

test('nothing is compacted unless the model asks', async ($, on) => {
  const { fill, seen } = engine(on);
  await start($);
  fill.percent = 99;

  await $.turn.complete(TURN);

  expect(seen.compactions).toEqual([]);
});
