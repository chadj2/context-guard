# CLAUDE.md

This file guides Claude Code in this repository. What the plugin does, how it's checked and how a change is released are in README.md, which is imported here:

@README.md

## Working on it

- Run `npm run check` before each commit. It validates the plugin, type-checks it, checks its layout and runs its tests ([README.md §5.3](README.md#53-checking-it)).
- A change to what the plugin does changes the README in the same commit. [README.md §5.5](README.md#55-what-the-api-was-found-doing) records what the API was found doing, with Claude Code's version and the date.
- A change that should reach the machines that installed the plugin bumps its version ([README.md §5.4](README.md#54-releasing-a-change)).
- Push only when the user asks.

## Writing

Write the README, commit messages and code comments in plain, complete sentences. Give each clause its verb, keep "that" and "which", put one idea in each sentence, and call a thing by the same name each time. A reader new to the code should understand each sentence on one reading. The messages that the plugin sends to Claude call the person at the keyboard "the user".
