import { atom, read, update } from 'claude-code'
import type { CommandSpec, EngineInterface, PluginOptions, Register } from 'claude-code'

import type { CodexLine } from '../types'

const PANE = 'codex-bridge'
const lines = atom({ plugin: 'codex-bridge', key: 'lines' } as const, [] as CodexLine[])
const running = atom({ plugin: 'codex-bridge', key: 'running' } as const, '')
const sessionModel = atom({ plugin: 'codex-bridge', key: 'model' } as const, '')
const models = atom({ plugin: 'codex-bridge', key: 'models' } as const, [] as string[])
const configModel = atom({ plugin: 'codex-bridge', key: 'configModel' } as const, '')
const isPickerHidden = atom({ plugin: 'codex-bridge', key: 'isPickerHidden' } as const, false)
const isCodexChat = atom({ plugin: 'codex-bridge', key: 'isCodexChat' } as const, false)
const thread = atom({ plugin: 'codex-bridge', key: 'thread' } as const, '')
const sessionEffort = atom({ plugin: 'codex-bridge', key: 'effort' } as const, '')
const efforts = atom({ plugin: 'codex-bridge', key: 'efforts' } as const, {} as Record<string, string[]>)
const configEffort = atom({ plugin: 'codex-bridge', key: 'configEffort' } as const, '')
const CONFIG_CHOICE = '__config__'
/** The tool whose rows show Codex's steps in a chat reply; only codex-bridge calls it. */
const STEP_TOOL = 'mcp__codex-bridge__codex'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1'
const MAX_RESULT = 20000
const MODEL_ID = /^[\w.-]+\/[\w.:-]+$/

type Sandbox = 'read-only' | 'workspace-write'
type Answer = { ok: boolean; text: string; sessionId?: string }

const clip = (text: string, max = MAX_RESULT) =>
  text.length > max ? `${text.slice(0, max)}\n\n[... cut ${text.length - max} chars]` : text

const join = (dir: string, ...parts: string[]) =>
  [dir.replace(/[\\/]+$/, ''), ...parts].join(dir.includes('/') && !dir.includes('\\') ? '/' : '\\')

/** Splits a leading `vendor/model` token off the args. */
export function splitModel(args: string): { model?: string; rest: string } {
  const trimmed = args.trim()
  const [first = '', ...others] = trimmed.split(/\s+/)
  return MODEL_ID.test(first) ? { model: first, rest: others.join(' ') } : { rest: trimmed }
}

/** Pulls `--flag` switches out of the args. */
export function takeFlag(args: string, flag: string): { on: boolean; rest: string } {
  const pattern = new RegExp(`(^|\\s)${flag}(?=\\s|$)`)
  return pattern.test(args)
    ? { on: true, rest: args.replace(pattern, ' ').trim() }
    : { on: false, rest: args.trim() }
}

/** Pulls `--name value` out of the args. */
export function takeOption(args: string, name: string): { value?: string; rest: string } {
  const pattern = new RegExp(`(^|\\s)${name}(?:\\s+|=)(\\S+)`)
  const found = pattern.exec(args)
  return found ? { value: found[2], rest: args.replace(pattern, ' ').trim() } : { rest: args.trim() }
}

type CodexModels = { list: string[]; efforts: Record<string, string[]> }

/** Codex's own folder: `CODEX_HOME` when set, else `.codex` in the home folder; '' when neither is known. */
async function codexHome($: EngineInterface): Promise<string> {
  const own = (await $.env.get('CODEX_HOME'))?.trim()
  if (own) return own
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home ? join(home, '.codex') : ''
}

/** The models Codex lists for this account, and each one's reasoning efforts, from its own cache. */
async function codexModels($: EngineInterface): Promise<CodexModels> {
  const none: CodexModels = { list: [], efforts: {} }
  const home = await codexHome($)
  if (!home) return none
  const file = join(home, 'models_cache.json')
  if (!(await $.fs.exists(file))) return none
  try {
    const data = JSON.parse(String(await $.fs.read(file))) as {
      models?: { slug?: string; visibility?: string; supported_reasoning_levels?: { effort?: string }[] }[]
    }
    const shown = (data.models ?? []).filter(model => model.slug && model.visibility !== 'hide')
    return {
      list: shown.map(model => String(model.slug)),
      efforts: Object.fromEntries(
        shown.map(model => [
          String(model.slug),
          (model.supported_reasoning_levels ?? []).map(level => level.effort ?? '').filter(Boolean),
        ]),
      ),
    }
  } catch {
    return none
  }
}

/** The top-level `model` and `model_reasoning_effort` of ~/.codex/config.toml ('' for one it sets none of). */
async function codexConfig($: EngineInterface): Promise<{ model: string; effort: string }> {
  const found = { model: '', effort: '' }
  const home = await codexHome($)
  if (!home) return found
  const file = join(home, 'config.toml')
  if (!(await $.fs.exists(file))) return found
  for (const row of String(await $.fs.read(file)).split(/\r?\n/)) {
    if (row.trim().startsWith('[')) break
    const model = /^\s*model\s*=\s*"([^"]+)"/.exec(row)?.[1]
    const effort = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/.exec(row)?.[1]
    if (model) found.model = model
    if (effort) found.effort = effort
  }
  return found
}

/** Re-reads what Codex offers into state, for the pickers above the prompt. */
async function refreshModels($: EngineInterface) {
  const [offered, configured] = await Promise.all([codexModels($), codexConfig($)])
  await update($, models, () => offered.list)
  await update($, efforts, () => offered.efforts)
  await update($, configModel, () => configured.model)
  await update($, configEffort, () => configured.effort)
}

/** A message's text without the host's hidden notes (`<system-reminder>` and kin), which are not the conversation. */
export function visibleText(text: string): string {
  return text
    .replace(/<(system-reminder|local-command-caveat|local-command-stdout|command-message|command-args)>[\s\S]*?<\/\1>/g, '')
    .trim()
}

/** The recent conversation, newest last, as a handoff note for another agent. */
async function brief($: EngineInterface, maxChars = 8000): Promise<string> {
  const messages = await $.session.messages()
  const parts: string[] = []
  let size = 0
  for (const message of [...messages].reverse()) {
    const text = visibleText(message.text)
    if (!text) continue
    const piece = `${message.role === 'user' ? 'User' : 'Claude'}: ${text}`
    if (size + piece.length > maxChars) break
    parts.unshift(piece)
    size += piece.length
  }
  return parts.join('\n\n')
}

/** The OpenRouter key the user gave this plugin (its sensitive setting); '' when none. */
function openrouterKey(options: PluginOptions): string {
  return String(options.openrouterApiKey ?? '').trim()
}

const NO_KEY =
  'No OpenRouter key. Add one with /plugin configure codex-bridge@codex-bridge (it is kept in secure storage).'

/** The chat-completions request body OpenRouter gets: the model and the one prompt, nothing else. */
export function openRouterBody(model: string, prompt: string): string {
  return JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] })
}

/** What OpenRouter's answer says, for the person: the reply under the model that wrote it, or why there is none. */
export function readOpenRouterReply(response: { status: number; ok: boolean; text: string }, model: string): Answer {
  if (!response.ok) {
    return { ok: false, text: `OpenRouter answered ${response.status}: ${response.text.slice(0, 600)}` }
  }
  try {
    const data = JSON.parse(response.text) as {
      model?: string
      choices?: { message?: { content?: string } }[]
    }
    const content = data.choices?.[0]?.message?.content ?? ''
    return { ok: true, text: `[${data.model ?? model}]\n\n${content || '(empty reply)'}` }
  } catch {
    return { ok: false, text: `OpenRouter sent something that is not JSON: ${response.text.slice(0, 300)}` }
  }
}

async function askOpenRouter(
  $: EngineInterface,
  options: PluginOptions,
  model: string,
  prompt: string,
): Promise<Answer> {
  const key = openrouterKey(options)
  if (!key) return { ok: false, text: NO_KEY }
  const response = await $.http.fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-Title': 'Claude Code codex-bridge',
    },
    body: openRouterBody(model, prompt),
  })
  return readOpenRouterReply(response, model)
}

/** How to start Codex: its npm entry through node, else the shim through cmd. */
async function codexCommand($: EngineInterface): Promise<string[]> {
  const appData = await $.env.get('APPDATA')
  if (appData) {
    const script = join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    if (await $.fs.exists(script)) return ['node', script]
  }
  return (await $.env.get('OS')) === 'Windows_NT' ? ['cmd', '/c', 'codex'] : ['codex']
}

async function tempDir($: EngineInterface) {
  return (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? ((await $.env.get('OS')) === 'Windows_NT' ? '.' : '/tmp')
}

async function log($: EngineInterface, stream: CodexLine['stream'], text: string) {
  const fresh = text
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .map(line => ({ stream, text: line }))
  if (fresh.length > 0) await update($, lines, list => [...(list ?? []), ...fresh].slice(-400))
}

type CodexSetup = { env: Record<string, string>; provider: string[]; model: string } | { error: string }

/** The provider flags, environment and model one Codex run uses. */
async function codexSetup($: EngineInterface, options: PluginOptions, override = ''): Promise<CodexSetup> {
  const isOpenRouter = options.codexProvider === 'openrouter'
  const env: Record<string, string> = {}
  const provider: string[] = []
  if (isOpenRouter) {
    const key = openrouterKey(options)
    if (!key) return { error: NO_KEY }
    env.OPENROUTER_API_KEY = key
    provider.push(
      '-c', 'model_provider=openrouter',
      '-c', 'model_providers.openrouter.name=OpenRouter',
      '-c', `model_providers.openrouter.base_url=${OPENROUTER_URL}`,
      '-c', 'model_providers.openrouter.env_key=OPENROUTER_API_KEY',
      '-c', 'model_providers.openrouter.wire_api=responses',
    )
  }
  const model =
    override.trim() ||
    (await read($, sessionModel)) ||
    String(options.codexModel ?? '').trim() ||
    (isOpenRouter ? String(options.openrouterModel ?? '').trim() : '')
  // the session's effort rides with the provider flags; left unset, Codex's config decides
  const effort = await read($, sessionEffort)
  if (effort) provider.push('-c', `model_reasoning_effort=${effort}`)
  return { env, provider, model }
}

/** Runs `codex exec` on a task (or resumes a thread), streaming into the pane; answers its final message. */
async function runCodex(
  $: EngineInterface,
  options: PluginOptions,
  task: string,
  sandbox: Sandbox,
  handoff: string,
  override = '',
  resumeId = '',
): Promise<Answer> {
  const setup = await codexSetup($, options, override)
  if ('error' in setup) return { ok: false, text: setup.error }
  const { env, provider, model } = setup
  const out = join(await tempDir($), `codex-bridge-${Date.now()}.md`)
  const argv = resumeId
    ? [
        ...(await codexCommand($)),
        'exec', 'resume', '--skip-git-repo-check',
        '-c', `sandbox_mode=${sandbox}`, '-o', out,
        ...provider,
        ...(model ? ['-m', model] : []),
        resumeId, '-',
      ]
    : [
        ...(await codexCommand($)),
        'exec', '--skip-git-repo-check', '--color', 'never',
        '-s', sandbox, '-o', out,
        ...provider,
        ...(model ? ['-m', model] : []),
        '-',
      ]
  const prompt = handoff
    ? `You are picking up work from Claude Code in the same folder.\n\n<handoff>\n${handoff}\n</handoff>\n\nTask: ${task}`
    : task

  await update($, lines, () => [{ stream: 'info', text: `$ codex exec ${resumeId ? `resume ${resumeId.slice(0, 8)}… ` : ''}-s ${sandbox}${model ? ` -m ${model}` : ''}` }, { stream: 'info', text: `task: ${task}` }])
  await update($, running, () => task.slice(0, 60))
  $.ui.status(`Codex: ${task.slice(0, 40)}`)

  let stdout = ''
  let stderr = ''
  let code: number | null = null
  try {
    const child = $.process.spawn({ argv, input: prompt, env })
    let step = await child.next()
    while (!step.done) {
      const { stream, text } = step.value
      if (stream === 'stdout') stdout += text
      else stderr += text
      await log($, stream, text)
      step = await child.next()
    }
    code = step.value.code
  } catch (error) {
    await update($, running, () => '')
    $.ui.status(undefined)
    return { ok: false, text: `Codex did not start: ${error instanceof Error ? error.message : String(error)}` }
  }

  let final = ''
  if (await $.fs.exists(out)) final = String(await $.fs.read(out)).trim()
  final ||= stdout.trim()
  const sessionId = /session id: ([0-9a-f-]{36})/.exec(stderr)?.[1] ?? (resumeId || undefined)
  await log($, 'info', `exit ${code}`)
  await update($, running, () => '')
  $.ui.status(undefined)

  if (code !== 0) {
    const tail = stderr.trim().split(/\r?\n/).slice(-15).join('\n')
    return { ok: false, text: `Codex exited ${code}.\n\n${clip(final || tail, 4000)}`, sessionId }
  }
  return { ok: true, text: clip(final || '(Codex finished without a final message)'), sessionId }
}

/** The newest Codex session's last answer, for bringing Codex work back to Claude. */
async function lastCodexAnswer($: EngineInterface): Promise<Answer> {
  const home = await codexHome($)
  if (!home) return { ok: false, text: 'Could not find your home folder.' }
  let dir = join(home, 'sessions')
  for (let depth = 0; depth < 3; depth++) {
    if (!(await $.fs.exists(dir))) return { ok: false, text: 'No Codex sessions found.' }
    const newest = (await $.fs.list(dir))
      .filter(entry => entry.kind === 'dir')
      .map(entry => entry.name)
      .sort()
      .at(-1)
    if (!newest) return { ok: false, text: 'No Codex sessions found.' }
    dir = join(dir, newest)
  }
  const file = (await $.fs.list(dir))
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  if (!file) return { ok: false, text: 'No Codex sessions found.' }

  let cwd = ''
  let answer = ''
  let error = ''
  for (const row of String(await $.fs.read(join(dir, file.name))).split('\n')) {
    if (!row.includes('"session_meta"') && !row.includes('"task_complete"')) continue
    try {
      const parsed = JSON.parse(row) as {
        type?: string
        payload?: { type?: string; cwd?: string; last_agent_message?: string | null; error?: { message?: string } }
      }
      if (parsed.type === 'session_meta') cwd = parsed.payload?.cwd ?? cwd
      if (parsed.payload?.type === 'task_complete') {
        if (parsed.payload.last_agent_message) answer = parsed.payload.last_agent_message
        if (parsed.payload.error?.message) error = parsed.payload.error.message
      }
    } catch {
      // a row cut mid-write: skip it
    }
  }
  if (!answer) {
    return { ok: false, text: `The newest Codex session (${file.name}) has no answer yet.${error ? `\n\nIts last error: ${error.slice(0, 400)}` : ''}` }
  }
  return { ok: true, text: `From Codex session ${file.name}${cwd ? ` in ${cwd}` : ''}:\n\n${clip(answer)}` }
}

/**
 * What a chat reply shows as Codex works: its words (`text`), its reasoning
 * (`thinking`), a diff (`diff`), a live note for the status line (`status`), or
 * one finished step (`step`): a tool row whose `input` and `output` say what
 * Codex did, with `text` the same step written out for places that draw no rows.
 */
type CodexPiece =
  | { kind: 'text' | 'thinking' | 'diff' | 'status'; text: string }
  | { kind: 'step'; input: Record<string, string>; output: string; text: string }
  | { kind: 'ask'; ask: CodexAsk; text: string }

/** A choice Codex wants the user to make, as its reply's `<ask_user>` block states it. */
type CodexAsk = { question: string; header: string; options: string[]; multiSelect: boolean }

/** Told to Codex when a conversation starts, so a question comes as a block the app can ask natively. */
const ASK_NOTE =
  'When you need the user to choose before you can go on, end your reply with one block, exactly:\n' +
  '<ask_user>{"question": "…?", "header": "≤12 chars", "options": ["…", "…"], "multiSelect": false}</ask_user>\n' +
  'Give 2 to 4 options (the user can always type their own answer) and do not repeat them in your prose.'

/** Splits an `<ask_user>` block off Codex's words: what to show, and the question when the block parses. */
export function takeAsk(text: string): { text: string; ask?: CodexAsk } {
  const found = /<ask_user>([\s\S]*?)<\/ask_user>/.exec(text)
  if (!found) return { text }
  const rest = (text.slice(0, found.index) + text.slice(found.index + found[0].length)).trim()
  try {
    const raw = JSON.parse(found[1] ?? '') as Partial<{ question: string; header: string; options: unknown[]; multiSelect: boolean }>
    const options = [...new Set((raw.options ?? []).map(String).map(option => option.trim()).filter(Boolean))].slice(0, 4)
    if (!raw.question || options.length < 2) return { text: rest }
    return {
      text: rest,
      ask: {
        question: raw.question.trim(),
        header: (raw.header ?? 'Codex').trim().slice(0, 12) || 'Codex',
        options,
        multiSelect: raw.multiSelect === true,
      },
    }
  } catch {
    return { text: rest }
  }
}

type CodexItem = {
  type?: string
  text?: string
  command?: string
  aggregated_output?: string
  exit_code?: number | null
  changes?: { path?: string; kind?: string }[]
  server?: string
  tool?: string
  query?: string
  message?: string
}

/**
 * The text of a command Codex reports, for display only: when Codex's report has
 * the form `<program> <flags> '<command>'`, the quoted command alone.
 */
export function bareCommand(command: string): string {
  const quoted = /^\s*(?:"[^"]+"|\S+)(?:\s+-\w+)+\s+(['"])([\s\S]*)\1\s*$/.exec(command)
  return (quoted?.[2] ?? command).trim()
}

const oneLine = (text: string, max = 100) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** The reply's line for one finished Codex step, in the transcript's own style. */
export function describeItem(item: CodexItem): string | undefined {
  switch (item.type) {
    case 'command_execution': {
      const output = (item.aggregated_output ?? '').trim().split(/\r?\n/).filter(Boolean)
      const failed = item.exit_code !== undefined && item.exit_code !== null && item.exit_code !== 0
      const tail = failed
        ? `exit ${item.exit_code}${output.length ? `: ${oneLine(output.at(-1) ?? '', 80)}` : ''}`
        : output.length === 0 ? 'no output' : output.length === 1 ? oneLine(output[0] ?? '', 80) : `${output.length} lines`
      return `● **Ran** \`${oneLine(bareCommand(item.command ?? ''), 90)}\`  \n  ⎿ ${tail}`
    }
    case 'file_change': {
      const files = (item.changes ?? []).map(change => `${change.kind === 'add' ? 'Created' : change.kind === 'delete' ? 'Deleted' : 'Edited'} \`${change.path ?? '?'}\``)
      return files.length ? `● ${files.join(', ')}` : undefined
    }
    case 'mcp_tool_call':
      return `● **Used** \`${item.server ?? 'mcp'}.${item.tool ?? 'tool'}\``
    case 'web_search':
      return `● **Searched** ${oneLine(item.query ?? '', 80)}`
    case 'error':
      return `● **Error** ${oneLine(item.message ?? '', 120)}`
    default:
      return undefined
  }
}

const DIFF_FENCE = '````diff'
const MAX_DIFF = 9000

/**
 * A markdown link target the desktop app opens in its own file view: the path
 * relative to the session folder, as Claude's own links are; else the path itself.
 */
export function fileHref(path: string, cwd: string): string {
  const slashed = path.replace(/\\/g, '/')
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const isInside = root !== '' && slashed.toLowerCase().startsWith(`${root.toLowerCase()}/`)
  const href = isInside ? slashed.slice(root.length + 1) : slashed
  return /[\s()<>]/.test(href) ? `<${href}>` : href
}

/** A whole new file as a unified diff of added lines, cut to what a Code element draws. */
export function additionDiff(text: string): { diff: string; added: number } {
  const all = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const kept: string[] = []
  let size = 0
  for (const line of all) {
    if (size + line.length + 2 > MAX_DIFF) break
    kept.push(`+${line}`)
    size += line.length + 2
  }
  return { diff: `@@ -0,0 +1,${kept.length} @@\n${kept.join('\n')}`, added: all.length }
}

/** The hunks of `git diff` output (headers dropped), cut at a hunk boundary to fit a Code element. */
export function gitHunks(output: string): { diff: string; added: number; removed: number } | undefined {
  const lines = output.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(line => line.startsWith('@@'))
  if (start < 0) return undefined
  const body = lines.slice(start)
  const added = body.filter(line => line.startsWith('+')).length
  const removed = body.filter(line => line.startsWith('-')).length
  let kept: string[] = []
  let size = 0
  let hunk: string[] = []
  for (const line of [...body, '@@']) {
    if (line.startsWith('@@') && hunk.length) {
      const length = hunk.join('\n').length + 1
      if (size + length > MAX_DIFF) break
      kept = [...kept, ...hunk]
      size += length
      hunk = []
    }
    hunk.push(line)
  }
  const diff = kept.join('\n').replace(/\n+$/, '')
  return diff ? { diff, added, removed } : undefined
}

/** The step a finished Codex item was, as a tool row shows it; undefined for words and reasoning. */
export function itemStep(item: CodexItem): Extract<CodexPiece, { kind: 'step' }> | undefined {
  const text = describeItem(item)
  if (text === undefined) return undefined
  const out = (item.aggregated_output ?? '').replace(/\r\n/g, '\n').trim()
  switch (item.type) {
    case 'command_execution': {
      const exit = item.exit_code !== undefined && item.exit_code !== null && item.exit_code !== 0 ? `\n(exit ${item.exit_code})` : ''
      return { kind: 'step', input: { step: 'Ran', command: bareCommand(item.command ?? '') }, output: `${clip(out || '(no output)', 8000)}${exit}`, text }
    }
    case 'mcp_tool_call':
      return { kind: 'step', input: { step: 'Used', tool: `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}` }, output: 'done', text }
    case 'web_search':
      return { kind: 'step', input: { step: 'Searched', query: item.query ?? '' }, output: 'done', text }
    case 'error':
      return { kind: 'step', input: { step: 'Error' }, output: item.message ?? 'unknown error', text }
    default:
      return undefined
  }
}

/**
 * One step per file a Codex change touched: the file as the row's input, its
 * diff as the output, and a header with a link plus the diff for `text`.
 */
async function fileChangePieces(
  $: EngineInterface,
  changes: NonNullable<CodexItem['changes']>,
  cwd: string,
): Promise<CodexPiece[]> {
  const parts: CodexPiece[] = []
  for (const change of changes) {
    const path = change.path ?? ''
    if (!path) continue
    const name = path.split(/[\\/]/).at(-1) ?? path
    const href = fileHref(path, cwd)
    const link = `[${name}](${href})`
    const file = href.replace(/^<|>$/g, '')
    if (change.kind === 'delete') {
      parts.push({ kind: 'step', input: { step: 'Deleted', file }, output: 'deleted', text: `\n\n● **Deleted** ${link}` })
      continue
    }
    let diff: { diff: string; added: number; removed: number } | undefined
    try {
      if (change.kind === 'add') {
        const made = additionDiff(String(await $.fs.read(path)))
        diff = { diff: made.diff, added: made.added, removed: 0 }
      } else {
        const ran = await $.process.run(['git', 'diff', '--no-color', '--', path], { timeoutMs: 10000 })
        if (ran.exitCode === 0) diff = gitHunks(ran.stdout)
      }
    } catch {
      // no diff to show: the header and link still say what changed
    }
    const verb = change.kind === 'add' ? 'Created' : 'Edited'
    const counts = diff ? ` \`+${diff.added} -${diff.removed}\`` : ''
    const fence = diff ? `\n\n${DIFF_FENCE} ${name}\n${diff.diff}\n\`\`\`\`` : ''
    parts.push({
      kind: 'step',
      input: { step: verb, file, ...(diff ? { lines: `+${diff.added} -${diff.removed}` } : {}) },
      output: diff ? diff.diff : '(no diff: not a git repository)',
      text: `\n\n● **${verb}** ${link}${counts}${fence}`,
    })
  }
  return parts
}

/**
 * Markdown with its relative links made `file:` URLs under `cwd`: a plugin's
 * Markdown element draws only http, https and file links as links.
 */
export function absoluteLinks(text: string, cwd: string): string {
  if (!cwd) return text
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return text.replace(/\]\((<[^>]+>|[^)\s]+)\)/g, (whole, target: string) => {
    const href = target.replace(/^<|>$/g, '')
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return whole
    return `](${`file:///${root.replace(/^\/+/, '')}/${href}`.replace(/ /g, '%20')})`
  })
}

/** Splits a Codex reply into prose and the diff blocks fileChangePieces wrote. */
export function replyParts(text: string): ({ kind: 'prose'; text: string } | { kind: 'diff'; name: string; diff: string })[] {
  const parts: ({ kind: 'prose'; text: string } | { kind: 'diff'; name: string; diff: string })[] = []
  const pattern = /````diff ([^\n]*)\n([\s\S]*?)\n````/g
  let last = 0
  for (const found of text.matchAll(pattern)) {
    const before = text.slice(last, found.index).trim()
    if (before) parts.push({ kind: 'prose', text: before })
    parts.push({ kind: 'diff', name: found[1] ?? '', diff: found[2] ?? '' })
    last = (found.index ?? 0) + found[0].length
  }
  const rest = text.slice(last).trim()
  if (rest) parts.push({ kind: 'prose', text: rest })
  return parts
}

/** One message in the Codex conversation, streamed as Codex works (`codex exec --json`). */
async function* codexEvents(
  $: EngineInterface,
  options: PluginOptions,
  message: string,
  cwd: string,
): AsyncGenerator<CodexPiece> {
  const setup = await codexSetup($, options)
  if ('error' in setup) {
    yield { kind: 'text', text: setup.error }
    return
  }
  const sandbox: Sandbox = options.codexSandbox === 'read-only' ? 'read-only' : 'workspace-write'
  const resumeId = await read($, thread)
  const handoff = resumeId ? '' : await brief($)
  const shared = ['--json', '--skip-git-repo-check', '-c', 'model_reasoning_summary=auto', ...setup.provider, ...(setup.model ? ['-m', setup.model] : [])]
  const argv = resumeId
    ? [...(await codexCommand($)), 'exec', 'resume', '-c', `sandbox_mode=${sandbox}`, ...shared, resumeId, '-']
    : [...(await codexCommand($)), 'exec', '-s', sandbox, ...shared, '-']
  // a new conversation learns how to ask (ASK_NOTE) along with what Claude was doing
  const prompt = resumeId
    ? message
    : `You are working in Claude Code's chat, in the same folder.\n\n${ASK_NOTE}${handoff ? `\n\n<handoff>\n${handoff}\n</handoff>` : ''}\n\nTask: ${message}`

  $.ui.status(`Codex: ${oneLine(message, 40)}`)
  let buffer = ''
  let stderr = ''
  let hasAnswered = false
  let pendingAsk: CodexAsk | undefined
  try {
    const child = $.process.spawn({ argv, input: prompt, env: setup.env })
    let step = await child.next()
    while (!step.done) {
      const { stream, text } = step.value
      if (stream === 'stderr') stderr += text
      else buffer += text
      const rows = buffer.split('\n')
      buffer = rows.pop() ?? ''
      for (const row of rows) {
        let event: { type?: string; thread_id?: string; item?: CodexItem; error?: { message?: string }; message?: string }
        try {
          event = JSON.parse(row)
        } catch {
          continue
        }
        if (event.type === 'thread.started' && event.thread_id) {
          await update($, thread, () => event.thread_id ?? '')
        } else if (event.type === 'item.started' && event.item?.type === 'command_execution') {
          yield { kind: 'status', text: `running ${oneLine(bareCommand(event.item.command ?? ''), 60)}` }
        } else if (event.type === 'item.completed' && event.item) {
          const item = event.item
          if (item.type === 'reasoning' && item.text) {
            yield { kind: 'thinking', text: `${item.text.trim()}\n\n` }
          } else if (item.type === 'agent_message' && item.text) {
            hasAnswered = true
            const { text, ask } = takeAsk(item.text)
            if (ask) pendingAsk = ask
            if (text) yield { kind: 'text', text: `\n\n${text}` }
          } else if (item.type === 'file_change' && item.changes?.length) {
            for (const piece of await fileChangePieces($, item.changes, cwd)) yield piece
          } else {
            const step = itemStep(item)
            if (step) yield step
          }
        } else if (event.type === 'turn.failed' || event.type === 'error') {
          hasAnswered = true
          yield { kind: 'text', text: `\n\n**Codex failed:** ${event.error?.message ?? event.message ?? 'unknown error'}` }
        }
      }
      step = await child.next()
    }
    if (step.value.code !== 0 && !hasAnswered) {
      const tail = stderr.trim().split(/\r?\n/).slice(-6).join('\n')
      yield { kind: 'text', text: `\n\n**Codex exited ${step.value.code}.**\n\n${tail}` }
    }
    // a question comes last, once Codex has stopped: the answer starts its next message
    if (pendingAsk) {
      const choices = pendingAsk.options.map(option => `- ${option}`).join('\n')
      yield { kind: 'ask', ask: pendingAsk, text: `\n\n**${pendingAsk.question}**\n${choices}` }
    }
  } catch (error) {
    yield { kind: 'text', text: `\n\n**Codex did not start:** ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    $.ui.status(undefined)
  }
}

/** A tool_use id in the API's own shape, for a step row. */
function stepId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return `toolu_${[...bytes].map(byte => alphabet[byte % alphabet.length]).join('')}`
}

/** One message in the ongoing Codex conversation (a new one carries Claude's context). */
async function say($: EngineInterface, options: PluginOptions, message: string): Promise<Answer> {
  void $.ui.open({ id: PANE, title: 'Codex' }).catch(() => undefined)
  const sandbox: Sandbox = options.codexSandbox === 'read-only' ? 'read-only' : 'workspace-write'
  const current = await read($, thread)
  const answer = await runCodex($, options, message, sandbox, current ? '' : await brief($), '', current)
  if (answer.sessionId) await update($, thread, () => answer.sessionId ?? '')
  return answer
}

export const register: Register = (on, options) => {
  // the session's folder, which Codex works in and file links are relative to
  let sessionCwd = ''

  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    // a command the person also keeps as a file (~/.claude/commands, listed before the
    // session starts) stays theirs: the command.run hooks below answer it either way
    const existing = new Set(
      (await $.command.list().catch(() => [])).map(command => command.name),
    )
    const offer = async (spec: CommandSpec) => {
      if (!existing.has(spec.name)) await $.command.register(spec)
    }
    await offer({
      name: 'codex',
      description: 'Hand a task to Codex CLI with this conversation as context (--fresh: no context)',
      argumentHint: '[--fresh] [--model id] <task>',
    })
    await offer({
      name: 'codex-model',
      description: 'Pick the Codex model for this session (no args: list them; "default": use your Codex config)',
      argumentHint: '[model | default]',
    })
    await offer({
      name: 'codex-open',
      description: 'Jump to interactive Codex in a new window, carrying this conversation over',
      argumentHint: '[what to do next]',
    })
    await offer({
      name: 'codex-effort',
      description: 'Pick how hard Codex reasons this session (no args: show the levels; "default": your Codex config)',
      argumentHint: '[low | medium | high | xhigh | max | default]',
    })
    await offer({
      name: 'codex-chat',
      description: 'Talk to Codex: your messages go to Codex until /claude',
      argumentHint: '[first message]',
    })
    await offer({
      name: 'claude',
      description: 'Back to Claude: your messages go to Claude again',
    })
    await offer({
      name: 'codex-say',
      description: 'Send one message to the current Codex conversation',
      argumentHint: '<message>',
    })
    await offer({
      name: 'codex-new',
      description: 'Start a fresh Codex conversation (Codex forgets this one)',
    })
    await offer({
      name: 'from-codex',
      description: "Bring the newest Codex session's last answer back into Claude",
    })
    await offer({
      name: 'codex-pane',
      description: 'Show the live Codex output pane',
    })
    await offer({
      name: 'or',
      description: 'Ask an OpenRouter model (--ctx: include this conversation)',
      argumentHint: '[vendor/model] [--ctx] <prompt>',
    })
    await $.tool.register({
      name: 'codex',
      description:
        'Internal to Codex chat: each call is a step Codex already took (a command it ran, a file it changed), ' +
        'shown as a row. Never call it yourself; use codex_run to hand Codex a task.',
      inputSchema: {
        type: 'object',
        properties: {
          step: { type: 'string' },
          command: { type: 'string' },
          file: { type: 'string' },
          lines: { type: 'string' },
          tool: { type: 'string' },
          query: { type: 'string' },
        },
        required: ['step'],
      },
    })
    await $.tool.register({
      name: 'codex_run',
      description:
        'Delegate a self-contained task to OpenAI Codex CLI running in the current folder and get its final answer. ' +
        'Use for a second implementation, an independent review, or work the user asked Codex to do. ' +
        'Read-only unless sandbox is "workspace-write".',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Full instructions for Codex; it cannot see this conversation.' },
          sandbox: { type: 'string', enum: ['read-only', 'workspace-write'], default: 'read-only' },
          model: { type: 'string', description: "Codex model id; omit for the session's choice." },
        },
        required: ['task'],
      },
    })
    await $.tool.register({
      name: 'openrouter_ask',
      description:
        'Ask a model on OpenRouter one question and get its reply, e.g. for a second opinion from another model. ' +
        'The model sees only the prompt you send.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          model: { type: 'string', description: 'OpenRouter model id like openai/gpt-5; omit for the default.' },
        },
        required: ['prompt'],
      },
    })
    try {
      await refreshModels($)
    } catch {
      // no model list: the picker offers the config default alone
    }
    return next(e)
  })

  on('command.run', { command: 'codex' }, async ($, e) => {
    const { value: model, rest: args } = takeOption(e.args, '--model')
    const { on: isFresh, rest: task } = takeFlag(args, '--fresh')
    if (!task) return { text: 'Usage: /codex [--fresh] [--model id] <task>' }
    void $.ui.open({ id: PANE, title: 'Codex' }).catch(() => undefined)
    const sandbox: Sandbox = options.codexSandbox === 'read-only' ? 'read-only' : 'workspace-write'
    const answer = await runCodex($, options, task, sandbox, isFresh ? '' : await brief($), model)
    if (answer.sessionId) await update($, thread, () => answer.sessionId ?? '')
    return { text: answer.ok ? `Codex says:\n\n${answer.text}` : answer.text }
  })

  on('command.run', { command: 'codex-open' }, async ($, e) => {
    const note = await brief($, 20000)
    const file = join(await tempDir($), `claude-handoff-${Date.now()}.md`)
    const next = e.args.trim()
    await $.fs.write(
      file,
      `# Handoff from Claude Code\n\n## Conversation so far\n\n${note || '(nothing yet)'}\n\n## Next\n\n${next || 'Continue from here.'}\n`,
    )
    const prompt = `Read the handoff note at ${file} and continue the work it describes.`
    if ((await $.env.get('OS')) !== 'Windows_NT') {
      return { text: `Handoff written to ${file}. Start Codex in a terminal with:\n\ncodex "${prompt}"` }
    }
    const opened = await $.process.run(['cmd', '/c', 'start', 'Codex from Claude', 'codex', prompt])
    return opened.exitCode === 0
      ? { text: `Opened Codex in a new window with the handoff (${file}). Use /from-codex to bring its answer back.` }
      : { text: `Could not open a window (${opened.stderr.trim() || `exit ${opened.exitCode}`}). Handoff is at ${file}.` }
  })

  on('command.run', { command: 'codex-model' }, async ($, e) => {
    const wanted = e.args.trim()
    await refreshModels($)
    await update($, isPickerHidden, () => false)
    const available = await read($, models)
    const current = await read($, sessionModel)
    const fallback = String(options.codexModel ?? '').trim() || (await read($, configModel)) || 'your Codex config default'
    if (!wanted) {
      const using = current || fallback
      const list = available.length > 0
        ? available.map(model => `${model === using ? '* ' : '  '}${model}`).join('\n')
        : '  (no model list found in ~/.codex/models_cache.json)'
      return {
        text: `Codex model this session: ${using}\n\nAvailable:\n${list}\n\nSet one with /codex-model <id>, /codex-model default, or the picker above the prompt.`,
      }
    }
    if (wanted === 'default' || wanted === 'reset') {
      await update($, sessionModel, () => '')
      return { text: `Codex model reset to ${fallback}.` }
    }
    await update($, sessionModel, () => wanted)
    const isKnown = available.length === 0 || available.includes(wanted)
    return {
      text: `Codex model for this session: ${wanted}${isKnown ? '' : " (not in Codex's model list; it may be rejected)"}`,
    }
  })

  on('command.run', { command: 'codex-effort' }, async ($, e) => {
    const wanted = e.args.trim().toLowerCase()
    await refreshModels($)
    const model = (await read($, sessionModel)) || String(options.codexModel ?? '').trim() || (await read($, configModel))
    const levels = (await read($, efforts))[model] ?? []
    const configured = (await read($, configEffort)) || 'Codex default'
    if (!wanted) {
      const current = (await read($, sessionEffort)) || `default (${configured})`
      return { text: `Codex effort this session: ${current}\n\n${model || 'This model'} takes: ${levels.join(', ') || 'unknown'}` }
    }
    if (wanted === 'default' || wanted === 'reset') {
      await update($, sessionEffort, () => '')
      return { text: `Codex effort reset to ${configured}.` }
    }
    await update($, sessionEffort, () => wanted)
    const isKnown = levels.length === 0 || levels.includes(wanted)
    return { text: `Codex effort for this session: ${wanted}${isKnown ? '' : ` (${model} lists ${levels.join(', ')}; it may be rejected)`}` }
  })

  on('command.run', { command: 'codex-say' }, async ($, e) => {
    const message = e.args.trim()
    if (!message) return { text: 'Usage: /codex-say <message>' }
    const answer = await say($, options, message)
    return { text: answer.ok ? `Codex: ${answer.text}` : answer.text }
  })

  on('command.run', { command: 'codex-chat' }, async ($, e) => {
    await update($, isCodexChat, () => true)
    await update($, isPickerHidden, () => false)
    const isOnText = 'Codex chat is on: your messages now go to Codex. /claude switches back.'
    const first = e.args.trim()
    if (!first) return { text: isOnText }
    // the first message rides the command itself: Codex answers it here, in the command's output
    const model = (await read($, sessionModel)) || String(options.codexModel ?? '').trim() || (await read($, configModel))
    let reply = ''
    for await (const piece of codexEvents($, options, first, sessionCwd)) {
      // a command's output row draws no tool rows: each step is written out instead
      if (piece.kind === 'status') $.ui.status(`Codex: ${piece.text}`)
      else if (piece.kind !== 'thinking') reply += piece.kind === 'diff' ? `\n\n${piece.text}` : piece.text
    }
    return { text: `${isOnText}\n\n**Codex**${model ? ` (${model})` : ''}${reply}` }
  })

  on('command.run', { command: 'claude' }, async $ => {
    await update($, isCodexChat, () => false)
    return { text: 'Back to Claude. Codex keeps its conversation for next time (/codex-new forgets it).' }
  })

  on('command.run', { command: 'codex-new' }, async $ => {
    await update($, thread, () => '')
    return { text: 'Next Codex message starts a fresh conversation.' }
  })

  // Codex chat: the message enters as a normal turn, and Codex (not Claude)
  // writes that turn's reply, so no Claude request is made at all.
  const codexTurns = new Map<string, string>()
  const stepResults = new Map<string, string>()

  on('turn.start', async ($, e, next) => {
    if (e.text.trim() && (await read($, isCodexChat))) codexTurns.set(e.turnId, e.text.trim())
    return next(e)
  })

  // One Codex run spans the turn's steps: each step Codex took ends a step of
  // the turn with a call to the step tool (a real, collapsible tool row), and the
  // engine's next step picks the same run up where it stopped.
  const runs = new Map<string, AsyncGenerator<CodexPiece>>()
  // a question Codex asked, by turn: the AskUserQuestion call's id, then its answer by that id
  const asks = new Map<string, string>()
  const answers = new Map<string, string>()

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    let run = runs.get(e.turnId)
    const asked = asks.get(e.turnId)
    if (asked !== undefined) {
      // the user answered (or dismissed) Codex's question: that is Codex's next message
      asks.delete(e.turnId)
      const answer = answers.get(asked)
      answers.delete(asked)
      run = codexEvents($, options, answer ? `The user answered your question. ${answer}` : 'The user dismissed your question without answering.', sessionCwd)
      runs.set(e.turnId, run)
    }
    if (run === undefined) {
      const message = codexTurns.get(e.turnId)
      if (message === undefined || e.index !== 0) return yield* next(e)
      codexTurns.delete(e.turnId)
      run = codexEvents($, options, message, sessionCwd)
      runs.set(e.turnId, run)
    }
    const model = (await read($, sessionModel)) || String(options.codexModel ?? '').trim() || (await read($, configModel))
    // a step's response is shaped as a model's: reasoning, then words, then the tool call
    let thinking = ''
    let words = e.index === 0 ? `**Codex**${model ? ` (${model})` : ''}` : ''
    for (;;) {
      const got = await run.next()
      if (got.done) break
      const piece = got.value
      if (piece.kind === 'status') {
        $.ui.status(`Codex: ${piece.text}`)
      } else if (piece.kind === 'thinking') {
        thinking += piece.text
      } else if (piece.kind === 'text') {
        words += piece.text
      } else if (piece.kind === 'diff') {
        words += `\n\n${piece.text}`
      } else if (piece.kind === 'step') {
        const id = stepId()
        stepResults.set(id, piece.output)
        let block = 0
        if (thinking) yield { kind: 'thinking', index: block++, text: thinking.trim() }
        if (words.trim()) yield { kind: 'text', index: block++, text: words.trim() }
        yield { kind: 'tool', index: block, id, name: STEP_TOOL }
        yield { kind: 'input', index: block, json: JSON.stringify(piece.input) }
        yield { kind: 'stop', stopReason: 'tool_use', usage: null }
        return { turnId: e.turnId, index: e.index, answer: words.trim(), toolUses: [{ name: STEP_TOOL, input: piece.input }], stopReason: 'tool_use', usage: null }
      } else if (piece.kind === 'ask') {
        // Codex's question as the app's own question card: a real AskUserQuestion call
        const id = stepId()
        asks.set(e.turnId, id)
        runs.delete(e.turnId)
        const input = {
          questions: [
            {
              question: piece.ask.question,
              header: piece.ask.header,
              options: piece.ask.options.map(label => ({ label, description: '' })),
              multiSelect: piece.ask.multiSelect,
            },
          ],
        }
        let block = 0
        if (thinking) yield { kind: 'thinking', index: block++, text: thinking.trim() }
        if (words.trim()) yield { kind: 'text', index: block++, text: words.trim() }
        yield { kind: 'tool', index: block, id, name: 'AskUserQuestion' }
        yield { kind: 'input', index: block, json: JSON.stringify(input) }
        yield { kind: 'stop', stopReason: 'tool_use', usage: null }
        return { turnId: e.turnId, index: e.index, answer: words.trim(), toolUses: [{ name: 'AskUserQuestion', input }], stopReason: 'tool_use', usage: null }
      }
    }
    runs.delete(e.turnId)
    $.ui.status(undefined)
    let block = 0
    if (thinking) yield { kind: 'thinking', index: block++, text: thinking.trim() }
    if (words.trim()) yield { kind: 'text', index: block, text: words.trim() }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: words.trim(), toolUses: [], stopReason: 'end_turn', usage: null }
  })

  // a turn that ends early (Esc) stops its Codex run
  on('turn.complete', async ($, e, next) => {
    const run = runs.get(e.turnId)
    if (run !== undefined) {
      runs.delete(e.turnId)
      void run.return(undefined).catch(() => undefined)
      $.ui.status(undefined)
    }
    return next(e)
  })

  // the answer to a question Codex asked, kept for the turn's next step to hand Codex
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const ran = await next(e)
    const id = e.tool_use_id ?? ''
    if ([...asks.values()].includes(id) && ran.deny === undefined && ran.isError !== true) {
      answers.set(id, ran.text ?? JSON.stringify(ran.result))
    }
    return ran
  })

  // the step tool's rows answer from what Codex already did; nothing runs again
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const output = stepResults.get(e.tool_use_id ?? '')
    if (output === undefined) return { deny: 'This tool only records steps Codex already took in Codex chat; it does nothing when called.' }
    stepResults.delete(e.tool_use_id ?? '')
    return { result: output }
  })

  on('command.run', { command: 'from-codex' }, async $ => {
    const answer = await lastCodexAnswer($)
    return { text: answer.text }
  })

  on('command.run', { command: 'codex-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Codex' })
    return { text: 'Codex pane opened.' }
  })

  on('command.run', { command: 'or' }, async ($, e) => {
    const { on: withContext, rest } = takeFlag(e.args, '--ctx')
    const { model, rest: question } = splitModel(rest)
    if (!question) return { text: 'Usage: /or [vendor/model] [--ctx] <prompt>' }
    const chosen = model ?? (String(options.openrouterModel ?? '').trim() || 'openrouter/auto')
    const prompt = withContext ? `Conversation so far:\n\n${await brief($)}\n\n---\n\n${question}` : question
    $.ui.status(`OpenRouter: ${chosen}`)
    const answer = await askOpenRouter($, options, chosen, prompt)
    $.ui.status(undefined)
    return { text: answer.text }
  })

  on('tool.call', { tool: 'mcp__codex-bridge__codex_run' }, async ($, e) => {
    // the tool's own arguments ride on `e` itself, beside `tool` and `tool_use_id`
    const input = e as { task?: string; sandbox?: string; model?: string }
    if (!input.task) return { deny: 'codex_run needs a task.' }
    void $.ui.open({ id: PANE, title: 'Codex' }).catch(() => undefined)
    const sandbox: Sandbox = input.sandbox === 'workspace-write' ? 'workspace-write' : 'read-only'
    const answer = await runCodex($, options, input.task, sandbox, '', input.model ?? '')
    return { result: answer.ok ? answer.text : `Error: ${answer.text}` }
  })

  on('tool.call', { tool: 'mcp__codex-bridge__openrouter_ask' }, async ($, e) => {
    const input = e as { prompt?: string; model?: string }
    if (!input.prompt) return { deny: 'openrouter_ask needs a prompt.' }
    const model = input.model?.trim() || String(options.openrouterModel ?? '').trim() || 'openrouter/auto'
    const answer = await askOpenRouter($, options, model, input.prompt)
    return { result: answer.ok ? answer.text : `Error: ${answer.text}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isPickerHidden))) return next(e)
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const { Box, Button, Select } = $.ui.resolve(e)
    const isChat = await read($, isCodexChat)
    const current = await read($, sessionModel)
    const available = await read($, models)
    const fallback = String(options.codexModel ?? '').trim() || (await read($, configModel))
    const choices = [
      { value: CONFIG_CHOICE, label: fallback ? `default (${fallback})` : 'default (Codex config)' },
      ...[...new Set(current ? [...available, current] : available)].map(model => ({ value: model, label: model })),
    ]
    // the efforts the chosen model takes, as Codex lists them for it
    const effort = await read($, sessionEffort)
    const levels = (await read($, efforts))[current || fallback] ?? []
    const configured = await read($, configEffort)
    const effortChoices = [
      { value: CONFIG_CHOICE, label: configured ? `default (${configured})` : 'default' },
      ...[...new Set(effort ? [...levels, effort] : levels)].map(level => ({ value: level, label: level })),
    ]
    return (
      <Box flexDirection="row" gap={1}>
        <Select
          key="talk-to"
          label="Talk to:"
          options={[
            { value: 'claude', label: 'Claude' },
            { value: 'codex', label: 'Codex' },
          ]}
          value={isChat ? 'codex' : 'claude'}
          onSelect={value => {
            void update($, isCodexChat, () => value === 'codex')
            $.ui.toast(value === 'codex' ? 'Your messages now go to Codex' : 'Your messages now go to Claude')
          }}
        />
        <Select
          key="codex-model"
          label="Codex model:"
          options={choices}
          value={current || CONFIG_CHOICE}
          onSelect={value => {
            const picked = value === CONFIG_CHOICE ? '' : value
            void update($, sessionModel, () => picked)
            $.ui.toast(`Codex model: ${picked || fallback || 'Codex config default'}`)
          }}
        />
        <Select
          key="codex-effort"
          label="Effort:"
          options={effortChoices}
          value={effort || CONFIG_CHOICE}
          onSelect={value => {
            const picked = value === CONFIG_CHOICE ? '' : value
            void update($, sessionEffort, () => picked)
            $.ui.toast(`Codex effort: ${picked || configured || 'Codex config default'}`)
          }}
        />
        <Button key="hide-codex-model" label="Hide" plain onPress={() => update($, isPickerHidden, () => true)} />
      </Box>
    )
  })

  // A Codex file step's result, inside its native row: the diff in the surface's diff view.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const output = e.props.output
    if (e.props.tool !== STEP_TOOL || e.props.isErrored || typeof output !== 'string' || !output.startsWith('@@')) return next(e)
    const { Code } = $.ui.resolve(e)
    return <Code source={output} format="diff" wrap="truncate-end" />
  })

  // A Codex reply that changed files: its prose as markdown, each diff in the
  // surface's own diff view. A reply with no diff the app draws itself.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!e.props.text.includes(DIFF_FENCE)) return next(e)
    const { Box, Code, Markdown } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" gap={1}>
        {replyParts(e.props.text).map((part, at) =>
          part.kind === 'prose' ? (
            <Markdown key={`prose-${at}`} text={absoluteLinks(part.text, sessionCwd)} />
          ) : (
            <Code source={part.diff} format="diff" path={part.name} wrap="truncate-end" />
          ),
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, lines)
    const now = await read($, running)
    const model = (await read($, sessionModel)) || String(options.codexModel ?? '').trim() || 'config default'
    const width = Math.max(10, (e.props.bodyColumns ?? 60) - 2)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 6)
    return (
      <Box flexDirection="column">
        <Text bold>{now ? `Running: ${now}` : 'Idle'}</Text>
        <Text dimColor>{`model: ${model}  (/codex-model to change)`}</Text>
        {list.length === 0 && <Text dimColor>{'Run /codex <task> to hand work to Codex.'}</Text>}
        {list.slice(-room).map(line => (
          <Text dimColor={line.stream === 'stderr'} bold={line.stream === 'info'}>
            {line.text.length > width ? `${line.text.slice(0, width - 1)}…` : line.text}
          </Text>
        ))}
      </Box>
    )
  })
}
