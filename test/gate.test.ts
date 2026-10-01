import { describe, expect, it } from 'vitest'
import { JudgeCore } from '../src/core.js'
import { Gate, registerGate } from '../src/gate.js'
import { FakeJudge } from '../src/judge/fake.js'
import { MemoryAuditSink } from '../src/audit.js'

const yes = (a: number, b: number) => ({ reversible: { type: 'noul' as const, noul: a }, servesTask: { type: 'noul' as const, noul: b } })

function setup(threshold?: number) {
  const judge = new FakeJudge()
  const audit = new MemoryAuditSink()
  const gate = new Gate({ core: new JudgeCore({ judge, audit, env: {} }), threshold, context: () => ({ task: 'run tests', project: 'app' }) })
  return { judge, audit, gate }
}
const esc = (command: string, id = 'c1') => ({ name: 'bash', callId: id, arguments: { command, sandbox_permissions: 'danger-full-access', justification: 'network' } })
const req = (id = 'c1', toolName = 'bash') => ({ toolName, callId: id })

describe('Gate', () => {
  it('auto-approves an escalation with a confident verdict, once', async () => {
    const { gate, judge } = setup()
    judge.script(yes(0.95, 0.93))
    await gate.consider(esc('bun test'))
    expect(gate.answer(req())).toBe('allowed-once')
    expect(gate.answer(req())).toBeUndefined()
  })

  it.each([
    ['low reversible', yes(0.5, 0.99)],
    ['low serves', yes(0.99, 0.2)],
    ['just under', yes(0.89, 0.95)],
  ])('leaves the decision unchanged on %s', async (_n, answers) => {
    const { gate, judge } = setup()
    judge.script(answers)
    await gate.consider(esc('bun test'))
    expect(gate.answer(req())).toBeUndefined()
  })

  it('falls through when the Judge is unavailable or a score is missing', async () => {
    const { gate, judge } = setup()
    judge.unavailable('timeout')
    await gate.consider(esc('bun test', 'a'))
    judge.script({ reversible: { type: 'noul', noul: 1 } } as never)
    await gate.consider(esc('bun test', 'b'))
    expect(gate.answer(req('a'))).toBeUndefined()
    expect(gate.answer(req('b'))).toBeUndefined()
  })

  it('does not answer for another call id or tool', async () => {
    const { gate, judge } = setup()
    judge.script(yes(1, 1))
    await gate.consider(esc('bun test'))
    expect(gate.answer(req('other'))).toBeUndefined()
    expect(gate.answer(req('c1', 'write'))).toBeUndefined()
    expect(gate.answer({ toolName: 'bash' })).toBeUndefined()
  })

  it('never calls the Judge for risk-list matches', async () => {
    const { gate, judge } = setup()
    judge.script(yes(1, 1))
    for (const c of ['a && rm -rf x', 'echo $(ls)', "bash -c 'ls'", 'FOO=1 rm -rf x', '/bin/rm -rf x', 'git push --force', 'sudo ls']) await gate.consider(esc(c))
    await gate.consider({ name: 'write', callId: 'w', arguments: { path: '.env', content: 'x', sandbox_permissions: 'x', justification: 'y' } })
    expect(judge.calls).toHaveLength(0)
    expect(gate.answer(req())).toBeUndefined()
  })

  it('ignores calls that are not escalations or not covered tools', async () => {
    const { gate, judge } = setup()
    judge.script(yes(1, 1))
    await gate.consider({ name: 'bash', callId: 'p', arguments: { command: 'ls' } })
    await gate.consider({ name: 'read', callId: 'r', arguments: { path: 'a', sandbox_permissions: 'x' } })
    expect(judge.calls).toHaveLength(0)
  })

  it('sends only redacted commands, project and task, and audits the decision', async () => {
    const judge = new FakeJudge().script(yes(1, 1))
    const audit = new MemoryAuditSink()
    const gate = new Gate({ core: new JudgeCore({ judge, audit, env: {} }), context: () => ({ task: 't', project: 'p' }) })
    await gate.consider(esc('API_KEY=abcdefghijklmnop bun test'))
    expect(JSON.stringify(judge.calls[0]!.state)).not.toContain('abcdefghijklmnop')
    expect(Object.keys(judge.calls[0]!.state as object).sort()).toEqual(['commands', 'project', 'task'])
    expect(audit.records[0]).toMatchObject({ recipe: 'gate', decision: 'auto-approve', meta: { tool: 'bash', taskChars: 1, hasProject: true } })
  })

  it('never returns deny from its listeners, over generated inputs', async () => {
    const { gate, judge } = setup()
    judge.script(yes(1, 1))
    const listeners: Record<string, (...a: any[]) => any> = {}
    registerGate({ on: (e, l, o) => { expect(o).toEqual({ prepend: true }); listeners[e] = l } }, gate)
    const cmds = ['ls', 'rm -rf /', 'sudo x', '$(x)', '', "'", 'bun test', 'a;b|c&&d', '\n', 'git push -f']
    const names = ['bash', 'pwsh', 'write', 'edit', 'run_code', 'nope']
    const argsList: unknown[] = [null, 5, 'x', {}, ...cmds.map((c) => ({ command: c, sandbox_permissions: 'x', justification: 'y', path: c }))]
    let n = 0
    for (const name of names) for (const arguments_ of argsList) {
      const sentinel = { kind: 'allow' }
      const out = await listeners['tools/pre-execute']!({ name, arguments: arguments_, callId: `g${n++}` }, async () => sentinel)
      expect(out).toBe(sentinel)
    }
    for (const id of [undefined, 'g1', 'g8', 'zzz']) {
      const out = await listeners['approval/request']!({ toolName: 'bash', callId: id }, async () => 'rejected')
      expect(['allowed-once', 'rejected']).toContain(out)
    }
  })

  it('skips the outer run_code but gates inner calls', async () => {
    const { gate, judge } = setup()
    judge.script(yes(1, 1))
    const l: Record<string, any> = {}
    registerGate({ on: (e, f) => { l[e] = f } }, gate)
    const next = async () => ({ kind: 'allow' })
    await l['tools/pre-execute']({ ...esc('bun test', 'o'), name: 'run_code' }, next)
    expect(judge.calls).toHaveLength(0)
    await l['tools/pre-execute']({ ...esc('bun test', 'i'), parent: 'o' }, next)
    expect(await l['approval/request']({ toolName: 'bash', callId: 'i' }, async () => 'rejected')).toBe('allowed-once')
  })
})
