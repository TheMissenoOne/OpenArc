import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'openarc',
  component: 'Pane',
  requestId: 'openarc',
  props: { title: 'OpenArc', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const STATUS = JSON.stringify({
  regions: 3, applied: [], pulled: [], compiled: [], modelCalls: 0, suggestions: 1,
  attention: [{ id: 'a.b', what: 'compile failed: OARC-E082' }], hostedTokensToday: 12, localTokensToday: 0,
})
const sent: string[] = []
type Spawn = (argv: string[]) => { chunks: string[]; code: number }
const ok: Spawn = () => ({ chunks: [`compiling: a.b\n${STATUS}\n`], code: 0 })
const engine = (on: any, spawned: string[][], prompts: string[], hasConfig: boolean, run: Spawn = ok, env: Record<string, string> = {}) => {
  mock.env(on, env)
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('fs.read', (_: unknown, e: { path: string }) => { if (!hasConfig || e.path.endsWith('.json') && e.path.includes('status')) throw new Error('missing'); return { value: '{}' } })
  on('prompt.submit', (_: unknown, e: { text: string }) => { sent.push(e.text); return { value: {} } })
  on('prompt.fill', (_: unknown, e: { text: string }) => { prompts.push(e.text); return { isFilled: true } })
  on('process.spawn', async function* (_: unknown, e: { argv: string[] }) {
    spawned.push([...e.argv])
    const r = run(e.argv)
    for (const text of r.chunks) yield { stream: 'stdout', text }
    return { value: { code: r.code } }
  })
}
const settle = () => new Promise(r => setTimeout(r, 20))

test('a repo without OpenArc starts nothing', async ($, on) => {
  const spawned: string[][] = []
  engine(on, spawned, [], false)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  expect(spawned).toEqual([])
})

test('in a project the watcher runs and the pane shows the lower levels, with no prompt sent', async ($, on) => {
  const spawned: string[][] = []
  const prompts: string[] = []
  engine(on, spawned, prompts, true)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  expect(spawned[0]).toEqual(['node_modules/.bin/openarc', 'sync', '--watch', '--json'])
  expect(sent).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /hosted tokens today 12/ }))?.text).toContain('1 need attention')
  expect((await ui.find({ type: 'Text', text: /compiling: a\.b/ }))?.text).toBe('compiling: a.b')
  await ui.unmount()
})

test('/openarc-fix drafts only what needs attention, and sends nothing', async ($, on) => {
  const prompts: string[] = []
  engine(on, [], prompts, true)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  await $.command.run({ command: 'openarc-fix', args: '' } as never)
  await settle()
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('a.b: compile failed')
  expect(prompts[0]!.length).toBeLessThan(200)
  expect(sent).toEqual([])
})

test('a status line split across two chunks still reaches the pane', async ($, on) => {
  const half = Math.floor(STATUS.length / 2)
  engine(on, [], [], true, () => ({ chunks: [`compiling: a.b\n${STATUS.slice(0, half)}`, `${STATUS.slice(half)}\n`], code: 0 }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /hosted tokens today 12/ }))?.text).toContain('1 need attention')
  expect(await ui.find({ type: 'Text', text: /"regions"/ })).toBeFalsy()
  await ui.unmount()
})

test('a failed adoption does not start the watcher', async ($, on) => {
  const spawned: string[][] = []
  engine(on, spawned, [], false, argv => ({ chunks: ['cannot read src/x.ts\n'], code: argv.includes('adopt') ? 1 : 0 }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'openarc-adopt', args: '' } as never)
  await settle()
  expect(spawned.map(a => a[1])).toEqual(['adopt'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /adopt failed/ }))?.text).toContain('exit 1')
  await ui.unmount()
})

test('an edit of a compiler-owned region is denied with the guard\'s reason; anything else goes through', async ($, on) => {
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  let answer: () => { exitCode: number; stdout: string; stderr: string } = () => ({ exitCode: 2, stdout: '', stderr: 'm.f is compiler-owned: edit its spec\n' })
  engine(on, [], [], true)
  on('process.run', (_: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: { ...answer(), isStdoutTruncated: false, isStderrTruncated: false } }
  })
  let ran = 0
  on('tool.call', () => (ran++, { result: { ok: true } }) as never)
  const edit = { tool: 'Edit', file_path: '/p/src/m.ts', old_string: 'return 1;', new_string: 'return 2;' } as never
  expect(await $.tool.call(edit)).toEqual({ deny: 'm.f is compiler-owned: edit its spec' })
  expect(ran).toBe(0)
  expect(runs[0]!.argv).toEqual(['node_modules/.bin/openarc', 'guard', '--hook'])
  expect(JSON.parse(runs[0]!.stdin!)).toEqual({ tool_name: 'Edit', tool_input: { file_path: '/p/src/m.ts', old_string: 'return 1;', new_string: 'return 2;' } })
  answer = () => ({ exitCode: 0, stdout: '', stderr: '' })
  await $.tool.call(edit)
  expect(ran).toBe(1)
  answer = () => { throw new Error('ENOENT') } // no binary: never blocks
  await $.tool.call(edit)
  expect(ran).toBe(2)
})

test('OPENARC_BIN names the binary', async ($, on) => {
  const spawned: string[][] = []
  engine(on, spawned, [], true, ok, { OPENARC_BIN: '/opt/openarc/bin/openarc' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  expect(spawned[0]![0]).toBe('/opt/openarc/bin/openarc')
})
