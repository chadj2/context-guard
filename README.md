# context-guard

context-guard is a plugin for Claude Code. It lets Claude see how full its context window is, and it warns Claude as the window fills. At the warning, Claude compacts the session at a stopping point, and the plugin then gives Claude the next step to carry on with. This happens ahead of Claude Code's own autocompact. The plugin also counts the session's compactions, and it stops Claude once there have been too many of them since the user last wrote. What Claude does at the warning is for each project to say, in its CLAUDE.md ([2](#2-setting-up-a-project)).

The plugin is a mod: a plugin of function hooks, which are an early-access API of Claude Code. It was written against Claude Code 2.1.308, and the API may change between releases ([5.5](#55-what-the-api-was-found-doing)).

## Contents

- [1 Installing it](#1-installing-it)
- [2 Setting up a project](#2-setting-up-a-project)
- [3 How it works](#3-how-it-works)
  - [3.1 The warning](#31-the-warning)
  - [3.2 Compacting](#32-compacting)
  - [3.3 The limit](#33-the-limit)
  - [3.4 The statistics](#34-the-statistics)
  - [3.5 The `context_usage` tool](#35-the-context_usage-tool)
- [4 The settings](#4-the-settings)
- [5 Developing it](#5-developing-it)
  - [5.1 The files](#51-the-files)
  - [5.2 Setting up a clone](#52-setting-up-a-clone)
  - [5.3 Checking it](#53-checking-it)
  - [5.4 Releasing a change](#54-releasing-a-change)
  - [5.5 What the API was found doing](#55-what-the-api-was-found-doing)
- [6 Licence](#6-licence)

## 1 Installing it

This repository is a plugin marketplace that lists context-guard. To install the plugin, type this at the prompt of a terminal session:

```text
/plugin install context-guard --marketplace chadj2/context-guard
```

Answer `y` to add the marketplace, and then choose a scope. From a shell, the same install is `claude plugin install context-guard --marketplace chadj2/context-guard`. In the desktop app, where `/plugin` doesn't run, click + next to the prompt box, then Plugins, then Add marketplace with `chadj2/context-guard`, and then Add plugin.

The plugin's ID is `context-guard@context-guard`, which is the plugin's name followed by the marketplace's name. The commands below, and the settings ([4](#4-the-settings)), name the plugin by its ID.

The scope says where the plugin is enabled:

- **User scope,** which is the default, enables the plugin in every project on the machine.
- **Project scope** enables the plugin in one project, through the project's `.claude/settings.json`. This is the scope for a project whose CLAUDE.md relies on context-guard. Run these two commands from the project's root, and commit the settings file that they write:

  ```sh
  claude plugin marketplace add chadj2/context-guard --scope project
  claude plugin install context-guard@context-guard --scope project
  ```

  The first command declares the marketplace under `extraKnownMarketplaces`, and the second enables the plugin under `enabledPlugins`. Anyone else who works in the project is then asked, in a terminal session, to add the marketplace and install the plugin. VS Code's extension doesn't ask. So on each machine, the plugin is installed once from a terminal, either by running `claude` in the project and accepting the prompts, or by running the second command above.

Each machine runs the copy of the plugin that it installed. [5.4](#54-releasing-a-change) says how a new version reaches that copy.

## 2 Setting up a project

The plugin tells Claude to find a stopping point and compact ([3.1](#31-the-warning)). The project's CLAUDE.md says what a stopping point means there, and what to save before compacting. A paragraph like this one says it:

```markdown
- At context-guard's warning, find a stopping point. Then write down what a later session needs, in the docs or in the issue it belongs to, and commit only finished work. Then tell the user, and call context-guard's `compact` with the next step, which is what you were doing: it compacts the session as the turn ends, and then sends that step back to you. When context-guard says to stop, end the turn.
```

What the compaction's summary keeps goes in a *Compact instructions* section of CLAUDE.md, which Claude Code reads at every compaction, autocompact's included ([its docs](https://code.claude.com/docs/en/costs#manage-context-proactively)):

```markdown
## Compact instructions

A compaction's summary keeps what the docs, the issues and the commits don't hold yet: the task in progress and the step it's at, what was found and not yet written down, the commits not yet pushed, and what to check or do next.
```

## 3 How it works

The plugin gives Claude two tools: `mcp__context-guard__compact`, which compacts the session ([3.2](#32-compacting)), and `mcp__context-guard__context_usage`, which reports how full the window is and what the plugin has done ([3.5](#35-the-context_usage-tool)). The plugin acts on the main conversation only. It leaves subagents alone, because each subagent fills a window of its own.

### 3.1 The warning

The plugin reads how full the context window is at the end of each turn, and after each of the main conversation's tool calls that ran without an error.

The warning is a share of a window. While autocompact is on, the window is autocompact's window, which is `rawMaxTokens` in `/context`'s breakdown. While autocompact is off, the window is the model's whole context window.

The first time the fill passes *Warn at %* ([4](#4-the-settings)) of the window, Claude reads a note. The note comes after that tool call's result. If the turn had already ended, the note comes beside the next prompt instead. With the default setting and a 750k autocompact window, the note reads like this:

> context-guard: Based on session policy your context should not grow too far past 80% of its 750,000-token autocompact window (600,000 tokens). At your earliest convenience find a stopping point, update documentation if necessary, inform the user that you are initiating a context compaction, and invoke the compact tool (mcp__context-guard__compact) with your next step: it compacts the session when the turn ends and then sends you that step to carry on with. Autocompact will trigger at 717,000 tokens; 620,000 of 1,000,000 tokens are in use.

With autocompact off, the note names the `context window` instead, and it says `Autocompact is off` where it would otherwise say when autocompact triggers.

- **The user** sees a toast: `Context 83% of the autocompact window, past the 80% warning`. While the fill stays past the warning, the status line shows the fill too, as `context 83% of the autocompact window`.
- **The window is read again as each turn ends,** because the breakdown that it comes from is worked out over the whole conversation. So a change of `/autocompact` takes effect from the next turn.
- **The warning comes once.** It comes again only after the fill falls back below it, as it does after a compaction. A note that Claude hasn't read yet is dropped once the fill falls back.

### 3.2 Compacting

At a stopping point, Claude calls the `compact` tool with `next`, which is the step to carry on with once the session is compacted. As the turn that called the tool ends, the plugin compacts the session as `/compact` would, from the `turn.complete` hook ([5.5](#55-what-the-api-was-found-doing)). Then it sends `next` to Claude as a prompt from context-guard (`$.prompt.submit`), and that prompt starts the next turn once the session is idle. Claude asked at a stopping point, so it carries on without waiting for the user. Where Claude Code skips the compaction, the plugin still sends `next`, and says that the compaction was skipped.

- **A headless session refuses the plugin's compaction,** and VS Code's extension runs its sessions headless. There the plugin runs `/compact` as the user would type it, queued until the session is idle. It sends `next` once `/compact` has run.
- **The tool is refused** when a subagent calls it, when `next` is empty, and past the limit ([3.3](#33-the-limit)).

**The `/compact` line** is the plugin's own, and it says how the compaction came about: `context-guard: Claude asked for this compaction at a stopping point, with 620,000 tokens of its 750,000-token autocompact window in use. Once it is done, context-guard gives Claude the next step it named.` What the compaction's summary keeps is the project's to say, in its *Compact instructions* ([2](#2-setting-up-a-project)).

`context_usage` shows what became of each compaction that Claude asked for ([3.5](#35-the-context_usage-tool)).

### 3.3 The limit

Every compaction since the user last wrote counts toward *Compactions without you* ([4](#4-the-settings)), except a `/compact` that the user typed. The count starts again when the user writes a prompt in the terminal, in VS Code's panel (seen with 2.1.308, 2026-10-23), through Remote Control, or from Slack. A prompt that a plugin or a schedule sent doesn't start the count again.

Past the limit, the plugin acts in two stages:

- **At the first compaction past the limit,** Claude reads a note after the next tool call's result, or beside the next prompt. The note tells Claude not to compact again, to save what later turns need, to tell the user where things stand and what it would do next, and to end the turn. Where the compaction was Claude's own, the plugin sends that note as the prompt in place of the next step. From then on, the `compact` tool is refused. The user sees a toast.
- **At one more compaction,** such as autocompact's in a turn that Claude didn't end, the plugin refuses the main conversation's tool calls until the user writes, so the turn ends. `context_usage` is still answered, and a subagent's tool calls go on. The user sees a toast.

So with the limit at 3, the fourth compaction stops Claude, and the fifth refuses Claude's tool calls. The count is held for the session, as `statistics.thisSession` is ([3.4](#34-the-statistics)), so a reload of the plugin doesn't start it over.

### 3.4 The statistics

The plugin counts each compaction of the main conversation, and the tokens that the compaction took out of the window. It counts them in all, and by who compacted:

- `claude`: Claude, through the `compact` tool.
- `user`: the user, by typing `/compact`.
- `auto`: Claude Code's autocompact.
- `plugin`: another plugin.
- `unseen`: a compaction that no hook reported, found by the fill's fall.

A compaction is counted in one of two ways:

- **The `session.compact` hook** counts most compactions. Claude Code hands the hook the tokens before and after the compaction, where it recorded them. Where it didn't, the plugin takes the fill that it read before the compaction, less the next reading, which is lower.
- **Where that hook was skipped** ([5.5](#55-what-the-api-was-found-doing)), the plugin counts its own compaction as the compaction ends. Its tokens are the fill when Claude asked, less the next reading. Any other compaction is counted as `unseen` when the fill falls by more than half between two readings, and its tokens are that fall.

Tokens that are worked out from the readings are estimates, and `estimated` counts the compactions that they're for.

`statistics.thisSession` counts the session's compactions. Claude Code holds it for the session (`$.state`), so a reload of the plugin keeps it. `statistics.allSessions` counts every session's compactions on the machine, in the plugin's own store (`$.store`, a JSON file under `~/.claude/plugins/store/`). `context_usage` shows a compaction's tokens as `removed`, while the state and the store keep them as `tokens`.

### 3.5 The `context_usage` tool

`context_usage` costs nothing to call. It answers with JSON, pretty printed for a user who reads it in the transcript. These are its fields:

- `used`, `window` and `percent`: the tokens in the context window, the model's window, and the share in use, which is the status line's `used_percentage`.
- `warning`: the tokens at which Claude is warned (`at`), as a `percent` `of` the window ([3.1](#31-the-warning)).
- `autoCompact`: whether autocompact is on (`isEnabled`), its `window`, and the tokens that it triggers `at`, with their `percent` of the model's window. It's `null` where the session gave no breakdown to read it from.
- `compaction`: whether Claude has asked for a compaction that hasn't run yet (`isAsked`), and the `steps`, which say what became of the compactions that Claude asked for ([3.2](#32-compacting)). The last 12 steps are kept, latest last. A step is one of these:
  - `asked`, `compacted`, `skipped: <why>` or `refused: <why>`;
  - `headless: compacting by /compact`, where a headless session refused the compaction, which is the expected route there and not a fault;
  - `/compact queued`, `/compact ran` or `/compact refused: <why>`;
  - `next step sent` or `stop sent`, with what became of that prompt where it was dropped or refused;
  - `next step held: past the limit`;
  - `reading failed: <why>` or `counting failed: <why>`.
- `limit`: the limit (`compactions`), the compactions since the user last wrote (`sinceUser`), and the `state`, which is `open`, `stopping` or `closed` ([3.3](#33-the-limit)).
- `statistics`: the compactions counted, in this session (`thisSession`) and in all sessions (`allSessions`) ([3.4](#34-the-statistics)).

## 4 The settings

- ***Warn at %*** (`warnPercent`), 80 by default, is the share of the window ([3.1](#31-the-warning)) at which Claude is warned. It has to be below the point where autocompact triggers, or autocompact comes first.
- ***Compactions without you*** (`compactionLimit`), 3 by default, is how many compactions Claude goes on through before the user writes again ([3.3](#33-the-limit)). With 0, Claude stops at the first compaction.

When to autocompact is Claude Code's own setting, `/autocompact`, which the plugin only reads. On 2026-10-22, Opus 5.5 with a window of 1,000,000 tokens was compacted at 967,000 tokens with the autocompact window at 1m, and at 717,000 tokens with the autocompact window at 750k. Either way, autocompact triggered 33,000 tokens short of its window. So with a 750k autocompact window, *Warn at %* has to be below about 96%. `/autocompact auto` drops the window that was saved for the model, and goes back to the window that Claude Code tunes for it. By Claude Code's docs, that window compacts at about 967,000 tokens for a model whose native window is 1,000,000 tokens.

Each machine keeps its own settings, in `~/.claude/settings.json` under `pluginConfigs["context-guard@context-guard"]`. They're set in one of these ways:

- **As the plugin is installed:** on the screen that the install shows, or with `--config`, as in `claude plugin install context-guard@context-guard --config warnPercent=75`.
- **In a terminal session:** with `/plugin configure context-guard@context-guard`.
- **From a shell:** this is the way for VS Code's panel, where `/plugin` doesn't run. The first command below shows the settings, and the second sets them. The values are given as strings, and Claude Code says to restart to apply them.

  ```sh
  claude plugin configure context-guard@context-guard
  echo '{"warnPercent": "75", "compactionLimit": "3"}' | claude plugin configure context-guard@context-guard --values-stdin
  ```

  `claude plugin configure` needs Claude Code 2.1.308 or later, as 2.1.278 doesn't have it (2026-10-22). VS Code's extension carries its own `claude`, which may be newer than the one on the PATH. It's in `~/.vscode/extensions/anthropic.claude-code-<version>-<platform>/resources/native-binary/`.

## 5 Developing it

### 5.1 The files

- `hooks/hooks.json` names the hooks module, `hooks/register.ts`.
- `.claude-plugin/plugin.json` is the manifest, and it declares the settings.
- `.claude-plugin/marketplace.json` makes the repository a marketplace that lists the plugin.
- `types/index.d.ts` is the contract for what the plugin keeps in `$.state`. `claude plugin validate` holds the hooks module to it.
- `tests/` holds the tests, which `claude plugin test` runs.
- `tsconfig.json` extends the config that comes with the API's types ([5.2](#52-setting-up-a-clone)).
- `package.json` holds the checks ([5.3](#53-checking-it)). The plugin itself needs no npm packages.

### 5.2 Setting up a clone

After cloning, set the clone up in two steps:

1. Run `claude --plugin-dir .` in a terminal, from the repository's root. This runs the plugin from the clone, and it writes the API's types (below).
2. Run `npm install`, which installs the tools that the checks use ([5.3](#53-checking-it)).

Claude Code's API types are in `.claude-plugin/types/`, which is git-ignored. `tsconfig.json` extends the `tsconfig.json` there, so `tsc` and an editor need the types. Claude Code writes them as it loads the plugin, but only into a folder that it watches, such as a `--plugin-dir` folder in a terminal session. A newer Claude Code writes the types again, because the API may change between releases.

A session started with `claude --plugin-dir .` reloads the plugin whenever one of its files is saved. Where the plugin is also installed, disable the installed copy first, so that only one copy registers the tools. `claude plugin disable context-guard@context-guard` disables it, and `claude plugin enable context-guard@context-guard` enables it again afterwards.

VS Code's extension doesn't write the types, because its sessions don't watch plugin folders. By Claude Code's reference, a session does watch them when its environment holds `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`, but that hasn't been tried.

Without a terminal session, the types can be laid out by hand, as they were on 2026-10-22. As Claude Code's plugin-authoring skill loads, it writes the same declarations into a file and says where. Copy that file to `.claude-plugin/types/claude-code/index.d.ts`. Then write this `tsconfig.json` in `.claude-plugin/types/`, like the one that Claude Code writes, naming only `claude-code` in `types`:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "jsx": "react",
    "jsxFactory": "h",
    "jsxFragmentFactory": "Fragment",
    "typeRoots": ["."],
    "types": ["claude-code"]
  },
  "include": ["../../hooks", "../../types", "../../tests"]
}
```

### 5.3 Checking it

`npm run check` runs these checks, in this order:

- **`npm run validate`** (`claude plugin validate .`) reads the plugin as a session will, and says what a session would refuse.
- **`npm run typecheck`** (`tsc -p .`) type-checks the plugin against the API's types ([5.2](#52-setting-up-a-clone)).
- **`npm run format:check`** checks the files' layout with oxfmt. `npm run format` lays them out.
- **`npm test`** (`claude plugin test .`) runs the tests, which stand in for Claude Code beneath the plugin. It needs Claude Code 2.1.308 or later, because 2.1.278 ran the tests with the default settings, whatever a test gave (2026-10-22). It also refuses to run, saying that hooks modules are turned off, once an older Claude Code has saved their switch as off. 2.1.278 did that when it was started in a terminal. Starting a newer Claude Code with network access, even as `claude -p`, sets the switch back on.

### 5.4 Releasing a change

1. Bump `version` in `.claude-plugin/plugin.json`, and in `package.json` to match.
2. Commit, and push to `main`.
3. On each machine, fetch the marketplace again with `claude plugin marketplace update context-guard`, and then update the plugin with `claude plugin update context-guard@context-guard`.
4. Run `/reload-plugins` in a running session, or start a new session.

### 5.5 What the API was found doing

The types that Claude Code writes are the API's reference, and the API may change between releases. These findings were made with Claude Code 2.1.308, on 2026-10-22 unless a finding gives another date:

- **A tool answers with text or content blocks.** An object passes the tests but is refused in a session, so `context_usage` gives its figures as JSON text.
- **`claude plugin validate` wants each function that's handed `$` declared at the top of the file,** not inside `register`.
- **`$.session.compact` is called from the `turn.complete` hook itself.** From `prompt.submit`, the host refuses the call, because it "would compact under the turn this hook is holding; call it from a later event (turn.complete)". From a timer set in `turn.complete`, the call never ran in a session, and nothing was said.
- **A session that VS Code's extension runs refuses `$.session.compact` anyway:** "not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt)". So the plugin then runs `/compact` (`$.command.run`) without waiting on it, because the turn is waiting on the hook. The test kit doesn't refuse the compaction in a headless session, so the test for it has the engine's stand-in refuse it. The kit words that refusal its own way, so the step that a refusal makes is tested on its own (`refusalOf`). That route compacted a session that VS Code ran, from about 370,000 tokens to 72,000 (2026-10-23).
- **After that `/compact`, `$.prompt.submit` started the next turn** in a session that VS Code ran, without the user typing. Claude read the step as "The context-guard plugin sent a message", and the session went on, from about 161,000 tokens to 70,000 (2026-10-23).
- **In that same compaction, the plugin's `session.compact` hook didn't run.** Claude Code's built-in plugin `cc-plugin-sec-default`, which sits outermost for Team and Enterprise organizations, "runs first and sent the event on past it". So the warning doesn't wait on that hook. The warning, and a note that Claude hasn't read yet, go once a reading finds the fill back below the warning.
- **Nor did the hook run for a later `/compact` that the plugin queued,** after the plugin had begun to count compactions. This time Claude Code said nothing of it. The compaction was counted as `/compact` ran, and marked `estimated`. Its 133,619 tokens were the fill when Claude asked, 197,991, less the next reading, 64,372 ([3.4](#34-the-statistics)). Had the hook run, the count would have started from Claude Code's own figure, or from the reading as the turn ended, which comes a response later and is higher (2026-10-23).

## 6 Licence

MIT, as [LICENSE](LICENSE) says.
