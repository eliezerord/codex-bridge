import type { RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { openRouterBody, readOpenRouterReply } from '../hooks/register'

const typed = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

const reply = (model: string, content: string) => ({
  value: {
    status: 200,
    ok: true,
    headers: {},
    text: JSON.stringify({ model, choices: [{ message: { content } }] }),
  },
})

test('/or without a key says where to set one', async ($, on) => {
  mock.env(on, {})
  const { text } = await $.command.run({ command: 'or', args: 'hello', ...typed })
  expect(text).toContain('No OpenRouter key')
})

test('/or never takes a key from the environment', async ($, on) => {
  mock.env(on, { OPENROUTER_API_KEY: 'sk-or-from-the-environment' })
  let isFetched = false
  on('http.fetch', () => {
    isFetched = true
    return reply('x', 'y')
  })
  const { text } = await $.command.run({ command: 'or', args: 'hello', ...typed })
  expect(text).toContain('No OpenRouter key')
  expect(isFetched).toBe(false)
})

test('OpenRouter gets only the model and the prompt', () => {
  expect(JSON.parse(openRouterBody('openai/gpt-5', 'say hi'))).toEqual({
    model: 'openai/gpt-5',
    messages: [{ role: 'user', content: 'say hi' }],
  })
})

test("OpenRouter's reply is shown under the model that wrote it, or its error", () => {
  const ok = readOpenRouterReply(reply('openai/gpt-5', 'hi there').value, 'openrouter/auto')
  expect(ok).toEqual({ ok: true, text: '[openai/gpt-5]\n\nhi there' })
  const failed = readOpenRouterReply({ status: 402, ok: false, text: '{"error":"no credits"}' }, 'openrouter/auto')
  expect(failed.ok).toBe(false)
  expect(failed.text).toContain('OpenRouter answered 402')
})

test('/codex without a task shows usage', async $ => {
  const { text } = await $.command.run({ command: 'codex', args: '  ', ...typed })
  expect(text).toContain('Usage: /codex')
})

test('/codex-model sets, shows and resets the session model', async ($, on) => {
  mock.env(on, {})
  const set = await $.command.run({ command: 'codex-model', args: 'gpt-6-astra', ...typed })
  expect(set.text).toContain('Codex model for this session: gpt-6-astra')
  const shown = await $.command.run({ command: 'codex-model', args: '', ...typed })
  expect(shown.text).toContain('Codex model this session: gpt-6-astra')
  const reset = await $.command.run({ command: 'codex-model', args: 'default', ...typed })
  expect(reset.text).toContain('reset')
  const after = await $.command.run({ command: 'codex-model', args: '', ...typed })
  expect(after.text).toContain('your Codex config default')
})

test('/codex --model with no task shows usage', async $ => {
  const { text } = await $.command.run({ command: 'codex', args: '--model gpt-6-sol', ...typed })
  expect(text).toContain('Usage: /codex')
})

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

test('the picker above the prompt sets the Codex model on every surface that has one', async ($, on) => {
  mock.env(on, {})
  for (const surface of ['terminal', 'desktop'] as const) {
    await $.command.run({ command: 'codex-model', args: 'gpt-6-astra', ...typed })
    const ui = await $.ui.mount({ plugin: 'codex-bridge', surface, ...BAND })
    expect(await ui.find({ key: 'codex-model' })).toBeDefined()
    const picked = await ui.select({ key: 'codex-model', value: '__config__' })
    expect(picked).toBeDefined()
    const reset = await $.command.run({ command: 'codex-model', args: '', ...typed })
    expect(reset.text).toContain('your Codex config default')
    await ui.unmount()
  }
})

test('the openrouter_ask tool reads its arguments and needs a key', async ($, on) => {
  mock.env(on, {})
  const missing = await $.tool.call({ tool: 'mcp__codex-bridge__openrouter_ask' })
  expect(String(missing.deny ?? missing.text)).toContain('needs a prompt')
  const ran = await $.tool.call({ tool: 'mcp__codex-bridge__openrouter_ask', prompt: 'hi there', model: 'openai/gpt-5' })
  expect(String(ran.result)).toContain('No OpenRouter key')
})

test('the codex_run tool reads its task', async $ => {
  const missing = await $.tool.call({ tool: 'mcp__codex-bridge__codex_run' })
  expect(String(missing.deny ?? missing.text)).toContain('codex_run needs a task')
})

const SESSION = '01a1121a-f062-75f0-9129-9cf1700d0bc1'

test('/codex-say keeps one Codex conversation going', async ($, on) => {
  mock.env(on, {})
  const runs: { argv: readonly string[]; input: string }[] = []
  on('fs.exists', () => ({ value: false }))
  on('session.messages', () => ({ value: [] }))
  on('process.spawn', async function* ($, e) {
    runs.push({ argv: e.argv, input: String(e.input) })
    yield { stream: 'stderr', text: `session id: ${SESSION}\n` }
    yield { stream: 'stdout', text: 'pong\n' }
    return { value: { code: 0, signal: null } }
  })
  const first = await $.command.run({ command: 'codex-say', args: 'remember banana', ...typed })
  expect(first.text).toBe('Codex: pong')
  expect(runs[0]?.argv).not.toContain('resume')
  const second = await $.command.run({ command: 'codex-say', args: 'what word?', ...typed })
  expect(second.text).toBe('Codex: pong')
  expect(runs[1]?.argv).toContain('resume')
  expect(runs[1]?.argv.at(-2)).toBe(SESSION)
  expect(runs[1]?.input).toBe('what word?')
  await $.command.run({ command: 'codex-new', args: '', ...typed })
  await $.command.run({ command: 'codex-say', args: 'hi', ...typed })
  expect(runs[2]?.argv).not.toContain('resume')
})

const STEP_TOOL = 'mcp__codex-bridge__codex'

/**
 * Plays the engine's loop for one turn: each step, then each step-tool call it
 * asked for (through the plugin), until a step ends the turn.
 */
async function driveTurn($: Engine, turnId: string, text: string) {
  await $.turn.start({ text, turnId })
  const words: string[] = []
  const thinking: string[] = []
  const rows: { input: Record<string, string>; output: string }[] = []
  const questions: unknown[] = []
  for (let index = 0; index < 20; index++) {
    let id = ''
    let name = ''
    let json = ''
    let stop: string | null = null
    for await (const chunk of $.turn.step({ turnId, index, model: 'claude', messageCount: 1 })) {
      if (chunk.kind === 'text') words.push(chunk.text)
      else if (chunk.kind === 'thinking') thinking.push(chunk.text)
      else if (chunk.kind === 'tool') [id, name] = [chunk.id, chunk.name]
      else if (chunk.kind === 'input') json += chunk.json
      else if (chunk.kind === 'stop') stop = chunk.stopReason
    }
    if (stop !== 'tool_use') break
    const input = JSON.parse(json) as Record<string, string>
    if (name === 'AskUserQuestion') {
      questions.push(input)
      await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: id, ...(input as object) } as Parameters<typeof $.tool.call>[0])
      continue
    }
    const ran = await $.tool.call({ tool: STEP_TOOL, tool_use_id: id, ...input })
    rows.push({ input, output: String(ran.result) })
  }
  return { words: words.join('\n'), thinking: thinking.join('\n'), rows, questions }
}

test('with Codex chat on, Codex writes the reply; /claude hands turns back', async ($, on) => {
  mock.env(on, {})
  on('fs.exists', () => ({ value: false }))
  on('session.messages', () => ({ value: [] }))
  const runs: (readonly string[])[] = []
  const command = '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command \'Get-Date\''
  const events = [
    { type: 'thread.started', thread_id: SESSION },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Checking the clock.' } },
    { type: 'item.started', item: { type: 'command_execution', command, status: 'in_progress' } },
    { type: 'item.completed', item: { type: 'command_execution', command, aggregated_output: '13:59\r\n', exit_code: 0 } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'I am Codex' } },
  ]
  on('process.spawn', async function* ($, e) {
    runs.push(e.argv)
    // split mid-line, as a real pipe may
    const all = events.map(event => JSON.stringify(event)).join('\n') + '\n'
    yield { stream: 'stdout', text: all.slice(0, 50) }
    yield { stream: 'stdout', text: all.slice(50) }
    return { value: { code: 0, signal: null } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  let claudeSteps = 0
  on('turn.step', async function* ($, e) {
    claudeSteps += 1
    yield { kind: 'text', index: 0, text: 'I am Claude' }
    return { turnId: e.turnId, index: e.index, answer: 'I am Claude', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.command.run({ command: 'codex-chat', args: '', ...typed })
  const fromCodex = await driveTurn($, 't1', 'what time is it')
  expect(fromCodex.words).toContain('**Codex**')
  expect(fromCodex.words).toContain('Checking the clock.')
  expect(fromCodex.words).toContain('I am Codex')
  // the command is a real tool row, answered with Codex's own output
  expect(fromCodex.rows).toEqual([{ input: { step: 'Ran', command: 'Get-Date' }, output: '13:59' }])
  expect(fromCodex.words).not.toContain('● **Ran**')
  expect(runs[0]).toContain('--json')
  expect(runs[0]).not.toContain('resume')
  expect(claudeSteps).toBe(0)

  const followUp = await driveTurn($, 't1b', 'and now?')
  expect(followUp.words).toContain('I am Codex')
  expect(runs[1]).toContain('resume')
  expect(runs[1]?.at(-2)).toBe(SESSION)

  // the step tool refuses a call Codex did not make
  const stray = await $.tool.call({ tool: STEP_TOOL, tool_use_id: 'toolu_stray', step: 'Ran', command: 'rm -rf /' })
  expect(String(stray.deny ?? stray.text)).toContain('only records steps Codex already took')

  await $.command.run({ command: 'claude', args: '', ...typed })
  const fromClaude = await driveTurn($, 't2', 'hello')
  expect(fromClaude.words).toBe('I am Claude')
  expect(claudeSteps).toBe(1)
})

test('the effort picked above the prompt reaches Codex', async ($, on) => {
  mock.env(on, {})
  on('session.messages', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  const runs: (readonly string[])[] = []
  on('process.spawn', async function* ($, e) {
    runs.push(e.argv)
    yield { stream: 'stdout', text: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) + '\n' }
    return { value: { code: 0, signal: null } }
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'codex-bridge', surface, ...BAND })
    expect(await ui.find({ key: 'codex-effort' })).toBeDefined()
    await ui.unmount()
  }
  await $.command.run({ command: 'codex-chat', args: 'one', ...typed })
  expect(runs[0]).not.toContain('model_reasoning_effort=high')

  const set = await $.command.run({ command: 'codex-effort', args: 'high', ...typed })
  expect(set.text).toContain('Codex effort for this session: high')
  await $.command.run({ command: 'codex-say', args: 'two', ...typed })
  expect(runs[1]).toContain('model_reasoning_effort=high')

  // the picker's default choice clears it again
  const ui = await $.ui.mount({ plugin: 'codex-bridge', surface: 'desktop', ...BAND })
  await ui.select({ key: 'codex-effort', value: '__config__' })
  await ui.unmount()
  await $.command.run({ command: 'codex-say', args: 'three', ...typed })
  expect(runs[2]).not.toContain('model_reasoning_effort=high')
})

test('commands kept as files are not registered twice', async ($, on) => {
  mock.env(on, {})
  const registered: string[] = []
  on('command.list', () => ({
    value: [
      { name: 'codex', description: 'file', source: 'user' },
      { name: 'codex-chat', description: 'file', source: 'user' },
    ],
  }))
  on('command.register', ($, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__codex-bridge__${e.name}` } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  expect(registered).not.toContain('codex')
  expect(registered).not.toContain('codex-chat')
  expect(registered).toContain('claude')
  const chat = await $.command.run({ command: 'codex-chat', args: '', ...typed })
  expect(chat.text).toContain('Codex chat is on')
})

test('Codex file changes show as diffs: a new file whole, an edit from git', async ($, on) => {
  mock.env(on, {})
  on('session.messages', () => ({ value: [] }))
  on('fs.read', () => ({ value: '<h1>Sign in</h1>\n<form></form>\n' }))
  const gitDiff = [
    'diff --git a/app.css b/app.css',
    'index 1111111..2222222 100644',
    '--- a/app.css',
    '+++ b/app.css',
    '@@ -1,2 +1,2 @@',
    ' body {',
    '-  color: red;',
    '+  color: blue;',
  ].join('\n')
  on('process.run', () => ({
    value: { exitCode: 0, stdout: gitDiff, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  const events = [
    { type: 'thread.started', thread_id: SESSION },
    { type: 'item.completed', item: { type: 'file_change', changes: [{ path: String.raw`C:\work\my site\auth.html`, kind: 'add' }] } },
    { type: 'item.completed', item: { type: 'file_change', changes: [{ path: String.raw`C:\work\my site\app.css`, kind: 'update' }] } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } },
  ]
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: events.map(event => JSON.stringify(event)).join('\n') + '\n' }
    return { value: { code: 0, signal: null } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('command.list', () => ({ value: [] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__codex-bridge__${e.name}` } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  // the app's own drawing of a block the mod leaves alone
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'drawn by the app') as RenderElement
  })
  await $.session.start({ cwd: String.raw`C:\work\my site`, surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'codex-chat', args: '', ...typed })
  const turn = await driveTurn($, 'f1', 'make a sign in page')
  // each file is a row of its own: the file (relative to the session folder) in, its diff out
  expect(turn.rows).toEqual([
    { input: { step: 'Created', file: 'auth.html', lines: '+2 -0' }, output: '@@ -0,0 +1,2 @@\n+<h1>Sign in</h1>\n+<form></form>' },
    { input: { step: 'Edited', file: 'app.css', lines: '+1 -1' }, output: '@@ -1,2 +1,2 @@\n body {\n-  color: red;\n+  color: blue;' },
  ])
  expect(turn.words).toContain('Done.')
  expect(turn.words).not.toContain('index 1111111')

  for (const surface of ['terminal', 'desktop'] as const) {
    // a file row's result draws as a diff
    const result = await $.ui.mount({
      plugin: 'codex-bridge',
      surface,
      component: 'ToolResult',
      props: { tool_use_id: 'toolu_a', tool: STEP_TOOL, output: turn.rows[0]?.output ?? '', isErrored: false },
    })
    expect(await result.find({ type: 'Code' })).toBeDefined()
    await result.unmount()
    // another tool's result is left to the app
    const other = await $.ui.mount({
      plugin: 'codex-bridge',
      surface,
      component: 'ToolResult',
      props: { tool_use_id: 'toolu_b', tool: 'Bash', output: '@@ not ours', isErrored: false },
    })
    expect(await other.find({ type: 'Code' })).toBeUndefined()
    await other.unmount()
  }
})

test('/codex-chat with a first message sends it to Codex', async ($, on) => {
  mock.env(on, {})
  on('session.messages', () => ({ value: [] }))
  const inputs: string[] = []
  on('process.spawn', async function* ($, e) {
    inputs.push(String(e.input))
    const events = [
      { type: 'thread.started', thread_id: SESSION },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Hi! What are we building?' } },
    ]
    yield { stream: 'stdout', text: events.map(event => JSON.stringify(event)).join('\n') + '\n' }
    return { value: { code: 0, signal: null } }
  })
  const { text } = await $.command.run({ command: 'codex-chat', args: 'hi there', ...typed })
  expect(text).toContain('Codex chat is on')
  expect(text).toContain('Hi! What are we building?')
  expect(inputs[0]).toContain('hi there')
})

test("the context handed to Codex leaves out the app's hidden notes", async ($, on) => {
  mock.env(on, {})
  on('session.messages', () => ({
    value: [
      {
        role: 'user',
        text: '<system-reminder>If you want to keep this work, offer to move the session.</system-reminder>\nmake a card',
        toolUses: [],
      },
      { role: 'assistant', text: 'Made the card.', toolUses: [] },
    ],
  }))
  const inputs: string[] = []
  on('process.spawn', async function* ($, e) {
    inputs.push(String(e.input))
    yield { stream: 'stdout', text: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) + '\n' }
    return { value: { code: 0, signal: null } }
  })
  await $.command.run({ command: 'codex-chat', args: 'continue', ...typed })
  expect(inputs[0]).toContain('User: make a card')
  expect(inputs[0]).toContain('Claude: Made the card.')
  expect(inputs[0]).not.toContain('system-reminder')
  expect(inputs[0]).not.toContain('keep this work')
})

test("Codex's question opens the app's question card, and the answer goes back to Codex", async ($, on) => {
  mock.env(on, {})
  on('session.messages', () => ({ value: [] }))
  const inputs: string[] = []
  const replies = [
    'Happy to.\n<ask_user>{"question": "What is your favorite color?", "header": "Color", "options": ["Blue", "Green", "Red", "Purple", "Pink"], "multiSelect": false}</ask_user>',
    'Blue it is.',
  ]
  on('process.spawn', async function* ($, e) {
    inputs.push(String(e.input))
    const events = [
      { type: 'thread.started', thread_id: SESSION },
      { type: 'item.completed', item: { type: 'agent_message', text: replies[inputs.length - 1] } },
    ]
    yield { stream: 'stdout', text: events.map(event => JSON.stringify(event)).join('\n') + '\n' }
    return { value: { code: 0, signal: null } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  // the app's own question card, answered "Blue"
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({
    result: { answers: { 'What is your favorite color?': 'Blue' } },
    text: 'User has answered your questions: "What is your favorite color?"="Blue".',
  }))

  await $.command.run({ command: 'codex-chat', args: '', ...typed })
  const turn = await driveTurn($, 'q1', 'ask me a question')
  // a new conversation tells Codex how to ask
  expect(inputs[0]).toContain('<ask_user>')
  // the card: Codex's question, at most 4 options, nothing typed out as a list
  expect(turn.questions).toEqual([
    {
      questions: [
        {
          question: 'What is your favorite color?',
          header: 'Color',
          options: ['Blue', 'Green', 'Red', 'Purple'].map(label => ({ label, description: '' })),
          multiSelect: false,
        },
      ],
    },
  ])
  expect(turn.words).toContain('Happy to.')
  expect(turn.words).not.toContain('ask_user')
  // the answer is Codex's next message, in the same turn and the same conversation
  expect(inputs[1]).toContain('"What is your favorite color?"="Blue"')
  expect(turn.words).toContain('Blue it is.')
})
