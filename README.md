# Codex Bridge

Chat with [OpenAI Codex CLI](https://github.com/openai/codex) inside Claude Code. Switch the conversation to Codex and it answers in the same chat: its commands and file edits appear as native, collapsible tool rows with diffs, its questions open Claude Code's own question card, and its reasoning shows in the thinking block. Switch back to Claude at any time, and Claude can read everything Codex did.

It also hands Codex one-off tasks, opens Codex in its own window with the conversation carried over, and asks any [OpenRouter](https://openrouter.ai) model a question.

> Codex Bridge is a **mod**: a plugin with a hooks module that runs inside Claude Code. Mods are an early-access feature of Claude Code. If the commands below don't appear, see [Requirements](#requirements).

## How it differs from OpenAI's Codex plugin

OpenAI's own [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) lets Claude Code send Codex reviews and tasks. Codex Bridge is about **talking to Codex directly**: in chat mode your messages go to Codex instead of Claude, Codex keeps one conversation going across messages, and Claude spends no tokens on those turns.

## Requirements

- **Claude Code** with mods enabled. Builds that keep mods behind a flag need `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment (or in the `env` block of `~/.claude/settings.json`).
- **Codex CLI 0.160 or later**, signed in (`codex login`, with a ChatGPT plan or an OpenAI API key). Older versions reject newer models such as `gpt-6.1-sol` with a misleading "not supported" error.
- **Node.js**, which Codex CLI's npm package runs on.
- For OpenRouter features only: an OpenRouter API key.

## Install

In Claude Code:

```
/plugin install codex-bridge --marketplace eliezerord/codex-bridge
```

Or from a shell:

```bash
claude plugin marketplace add eliezerord/codex-bridge
claude plugin install codex-bridge@codex-bridge
```

The commands register when a session starts, so in a new session they appear after your first message. You can still type one in full as your first message.

## Use

### Codex chat

| Command | What it does |
| --- | --- |
| `/codex-chat [message]` | Your messages now go to Codex. With a message, Codex answers it right away. |
| `/claude` | Your messages go to Claude again. Codex keeps its conversation for next time. |
| `/codex-new` | The next Codex message starts a fresh Codex conversation. |
| `/codex-model [model]` | Show the models your Codex account offers, or pick one for this session. `default` returns to your Codex config. |
| `/codex-effort [level]` | Show the reasoning levels the model takes, or pick one for this session. `default` returns to your Codex config. |

In the desktop app and the terminal, a band above the prompt holds the same switches: **Talk to** (Claude or Codex), **Codex model** and **Effort**. **Hide** removes the band and `/codex-model` brings it back. The mobile app has no dropdowns, so use the commands there.

The first message of each Codex conversation includes the recent Claude conversation, so Codex knows what you were doing.

### One-off tasks and handoffs

| Command | What it does |
| --- | --- |
| `/codex [--fresh] [--model id] <task>` | Codex does one task with this conversation as context (`--fresh`: without it) and its answer comes back into the chat. |
| `/codex-open [what next]` | Opens Codex in its own terminal window (Windows) with a handoff note of the conversation. Elsewhere it prints the command to run. |
| `/from-codex` | Brings the newest Codex session's last answer into the chat. |
| `/codex-pane` | Opens a side pane with Codex's raw output. |

Claude can also hand Codex work itself through the `codex_run` tool (read-only unless Claude asks for write access).

### OpenRouter

| Command | What it does |
| --- | --- |
| `/or [vendor/model] [--ctx] <prompt>` | Asks an OpenRouter model, `openrouter/auto` unless you name one. `--ctx` includes the conversation. |

Claude can do the same through the `openrouter_ask` tool. Setting **Codex provider** to `openrouter` runs Codex itself against OpenRouter.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| OpenRouter API key | blank | Key for `/or`, `openrouter_ask` and Codex over OpenRouter. Stored in Claude Code's secure storage. |
| Default OpenRouter model | `openrouter/auto` | Model `/or` uses when you name none. |
| Codex provider | `codex` | `codex` uses Codex's own login; `openrouter` runs Codex through OpenRouter. |
| Codex model | blank | A fixed Codex model; blank follows your Codex config. |
| Codex sandbox for /codex | `workspace-write` | What Codex may change in chat mode and `/codex`: the project folder, or nothing (`read-only`). |

Claude Code asks for these when you install from the `/plugin` menu or with `/plugin install` in a session. To change them later, including adding your OpenRouter key, run `/plugin configure codex-bridge@codex-bridge`. The key is only ever read from this setting.

## What it runs, reads, writes and sends

Codex Bridge only acts when you use one of its commands, switches or tools, or while Codex chat is on. It collects no analytics.

### Programs it runs, and why

The commands are built at the call from your settings and your messages (model, reasoning effort, sandbox, the Codex conversation's id), so they aren't fixed text; this is the complete list.

| Program | Why | When |
| --- | --- | --- |
| `node <npm global folder>/@openai/codex/bin/codex.js exec …` (or `codex exec …` when that file isn't there; on Windows `cmd /c codex exec …`) | Runs the Codex CLI on your message, with `--json`, the sandbox setting, and `-m` / `-c model_reasoning_effort=…` when you picked a model or effort. Your message goes in on standard input. | Codex chat, `/codex`, `/codex-chat <message>`, `/codex-say`, Claude's `codex_run` tool |
| The same, as `codex exec resume <conversation id> …` | Continues the same Codex conversation. | Every Codex chat message after the first |
| `git diff --no-color -- <file>` | Shows the diff of a file Codex edited. Read-only. | When Codex reports an edited file |
| `cmd /c start "Codex from Claude" codex "<prompt>"` (Windows only) | Opens interactive Codex in its own console window, pointed at the handoff note. | `/codex-open` |

Codex itself may run commands and edit files in the session's folder, as it would if you ran it yourself, within the sandbox setting (`workspace-write` or `read-only`). Codex Bridge only shows what Codex reports. The code that tidies Codex's reported commands for display (`bareCommand`) never runs anything.

### Hosts it contacts

- **`https://openrouter.ai/api/v1/chat/completions`**, directly: the model name and the prompt of `/or` or `openrouter_ask` (plus the conversation with `--ctx`), with your OpenRouter key from the plugin's setting. Nothing else is sent there, and the key goes nowhere else.
- **OpenAI, through the Codex CLI** (Codex Bridge doesn't call it itself): your Codex messages and, for the first message of a Codex conversation (and `/codex` without `--fresh`), the recent text of the Claude conversation, with Claude Code's hidden system notes removed. With **Codex provider** set to `openrouter`, Codex sends these to OpenRouter instead, with your OpenRouter key passed to Codex in its environment.

### Files it reads

- In Codex's folder (`CODEX_HOME`, or `~/.codex`): `models_cache.json` (the models and effort levels your account offers), `config.toml` (your default model and effort), and the files in `sessions/` (`/from-codex` reads the newest one's last answer). It never reads Codex's login file.
- A file Codex created, to show it as a diff.

### Files it writes

Only temporary files in your temp folder; it never writes build, start-up, settings or instructions files.

- `codex-bridge-<time>.md`: Codex's final answer for `/codex`, written by Codex (`-o`) and read back.
- `claude-handoff-<time>.md`: the conversation so far, for `/codex-open` to hand to Codex.

### Environment variables it reads

`APPDATA`, `USERPROFILE`, `HOME`, `CODEX_HOME`, `OS`, `TEMP` and `TMPDIR`, only to find Codex, its folder and the temp folder. It reads no credentials from your environment.

### What its hooks do

| Hook | What it does |
| --- | --- |
| `session.start` | Registers the commands and tools below, and reads Codex's model list for the pickers. |
| `command.run` | Answers its own commands (`/codex`, `/codex-chat`, `/claude`, `/codex-model`, `/codex-effort`, `/codex-new`, `/codex-say`, `/codex-open`, `/from-codex`, `/codex-pane`, `/or`). Other commands pass through untouched. |
| `turn.start`, `turn.step` | While Codex chat is on, they answer the turn with Codex's reply instead of sending it to Claude: no Claude request is made for those turns. With chat mode off, every turn passes through untouched. |
| `turn.complete` | Stops a running Codex process when its turn ends early (Esc). |
| `tool.call` | Answers the plugin's own three tools: `codex_run` and `openrouter_ask`, which Claude can call, and `codex`, the internal tool whose rows show Codex's steps in chat mode (it answers with what Codex already did and refuses any call Codex didn't make). For `AskUserQuestion`, it passes the call on unchanged and only records your answer when the question came from Codex, to hand it to Codex. All other tool calls pass through untouched. |
| `ui.render` | Draws the band above the prompt (Talk to, Codex model, Effort), the Codex output pane, and file diffs inside Codex's tool rows and replies. Everything else is drawn by Claude Code as usual. |

## How chat mode works

When chat mode is on, your message enters Claude Code as a normal turn, but Codex Bridge answers that turn instead of Claude: it runs Codex with `--json` and turns each event into part of the reply. Each command or file change ends a step of the turn with a call to the plugin's internal `codex` tool, which answers at once with what Codex already did, so Claude Code draws a real tool row and nothing runs twice. A question from Codex becomes a real `AskUserQuestion` call, and your answer is sent to Codex as its next message.

## Limits

- Codex's reasoning summaries show live in the thinking block but aren't saved in the conversation.
- Question cards take 2 to 4 options; Codex is asked to keep to that, and extras are dropped. You can always type your own answer.
- File diffs for edits come from git, so outside a git repository an edit shows without its diff.
- It needs Codex on the same machine, so it does nothing in cloud sessions.

## Development

`hooks/register.tsx` is the whole mod and `types/index.d.ts` declares its session state. Run the tests with:

```bash
claude plugin test .
```

## License

[MIT](LICENSE)
