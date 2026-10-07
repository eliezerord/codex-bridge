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

## What it runs, reads and sends

Codex Bridge only acts when you use one of its commands, switches or tools.

- **Runs** the Codex CLI on your machine (`codex exec`, `codex exec resume`) in the session's folder, with the sandbox above. Codex may run commands and edit files there, as it would on its own. On Windows, `/codex-open` starts Codex in a new console window. To show diffs of files Codex edited, it runs `git diff -- <file>`.
- **Sends to OpenAI, through Codex:** your Codex messages and, for the first message of a Codex conversation (and for `/codex` without `--fresh`), the recent text of the Claude conversation. Claude Code's hidden system notes are removed first.
- **Sends to OpenRouter (`openrouter.ai`):** the prompt of `/or` or `openrouter_ask` (plus the conversation with `--ctx`), with your OpenRouter key. The key comes from the setting above, or, when that is blank, from the `OPENROUTER_API_KEY` environment variable.
- **Reads locally:** Codex's model list and default model and effort (`models_cache.json`, `config.toml`) and its session files (for `/from-codex`), in `~/.codex` or `CODEX_HOME`. It never reads Codex's login file.
- **Writes locally:** a temporary file with Codex's final answer for `/codex`, and a handoff note for `/codex-open`, both in your temp folder.

It collects no analytics and talks to no other service.

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
