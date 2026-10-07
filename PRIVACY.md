# Codex Bridge privacy policy

Codex Bridge is a Claude Code plugin that runs entirely on your own computer. Its author runs no server and receives no data from it: no analytics, no telemetry, no crash reports.

## What leaves your computer, and only when you ask for it

- **To OpenAI, through the Codex CLI you installed and signed in to:** the messages you send to Codex (in Codex chat, `/codex`, `/codex-chat`, `/codex-say`, or when Claude uses the `codex_run` tool) and, for the first message of a Codex conversation or `/codex` without `--fresh`, the recent text of your Claude conversation, with Claude Code's hidden system notes removed. OpenAI's handling of that data is governed by your agreement with OpenAI. With the **Codex provider** setting set to `openrouter`, these go to OpenRouter instead.
- **To OpenRouter (`openrouter.ai`):** the model name and the prompt of `/or` or the `openrouter_ask` tool (plus the conversation when you add `--ctx`), with the OpenRouter API key you entered in the plugin's settings. OpenRouter's handling of that data is governed by your agreement with OpenRouter.

Nothing is sent anywhere else.

## What stays on your computer

- Your OpenRouter API key is stored by Claude Code in its secure storage and is sent only to OpenRouter.
- The plugin reads Codex's model list, default settings and session files from Codex's folder, and the files Codex creates (to show them as diffs). It does not read Codex's login file.
- It writes only temporary files in your temp folder: Codex's final answer for `/codex`, and a handoff note for `/codex-open`.
- Your Codex model, reasoning effort and chat-mode choices last for the Claude Code session only.

## Contact

Questions or concerns: open an issue at https://github.com/eliezerord/codex-bridge/issues.
