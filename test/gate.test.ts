import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JudgeCore } from '../src/core.js'
import { Gate, registerGate } from '../src/gate.js'
import { FakeJudge } from '../src/judge/fake.js'
import { MemoryAuditSink } from '../src/audit.js'

const IDS = ['keepsData', 'leavesOutsideAlone', 'nothingShipped', 'servesTask']
/** First answer `a`, the rest `b`: a single weak answer must block approval. */
const yes = (a: number, b: number) => Object.fromEntries(IDS.map((id, i) => [id, { type: 'noul' as const, noul: i === 0 ? a : b }]))

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
    ['one low answer', yes(0.5, 0.99)],
    ['rest low', yes(0.99, 0.2)],
    ['just under', yes(0.79, 0.95)],
  ])('leaves the decision unchanged on %s', async (_n, answers) => {
    const { gate, judge } = setup()
    judge.script(answers)
    await gate.consider(esc('bun test'))
    expect(gate.answer(req())).toBeUndefined()
  })

  it('uses a default threshold of 0.8 when none is given', async () => {
    const { gate, judge } = setup()
    judge.script(yes(0.8, 0.85))
    await gate.consider(esc('bun test', 'at'))
    judge.script(yes(0.79, 0.99))
    await gate.consider(esc('bun test', 'under'))
    expect(gate.answer(req('at'))).toBe('allowed-once')
    expect(gate.answer(req('under'))).toBeUndefined()
  })

  it('falls through when the Judge is unavailable or a score is missing', async () => {
    const { gate, judge } = setup()
    judge.unavailable('timeout')
    await gate.consider(esc('bun test', 'a'))
    judge.script({ keepsData: { type: 'noul', noul: 1 } } as never)
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

  it('audits risk-list stops with a redacted preview only', async () => {
    const { gate, audit } = setup()
    await gate.consider(esc('API_KEY=secret-value-123 rm -rf x'))
    expect(audit.records).toHaveLength(1)
    expect(audit.records[0]).toMatchObject({ recipe: 'gate', decision: 'risk-list:recursive delete', questionIds: [] })
    expect(JSON.stringify(audit.records[0])).not.toContain('secret-value-123')
    expect((audit.records[0]!.meta as any).preview).toContain('rm -rf x')
  })

  it('ignores calls that are not escalations or not covered tools', async () => {
    const { gate, judge } = setup()
    judge.script(yes(1, 1))
    await gate.consider({ name: 'bash', callId: 'p', arguments: { command: 'ls' } })
    await gate.consider({ name: 'read', callId: 'r', arguments: { path: 'a', sandbox_permissions: 'x' } })
    expect(judge.calls).toHaveLength(0)
  })

  it('sends only redacted commands, justification, project and task, and audits the decision', async () => {
    const judge = new FakeJudge().script(yes(1, 1))
    const audit = new MemoryAuditSink()
    const gate = new Gate({ core: new JudgeCore({ judge, audit, env: {} }), context: () => ({ task: 't', project: 'p' }) })
    await gate.consider(esc('API_KEY=abcdefghijklmnop bun test'))
    expect(JSON.stringify(judge.calls[0]!.state)).not.toContain('abcdefghijklmnop')
    expect(Object.keys(judge.calls[0]!.state as object).sort()).toEqual(['commands', 'justification', 'policy', 'project', 'task'])
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

  describe('Script bodies', () => {
    async function project(scripts: Record<string, string>, opts: { sendScripts?: boolean } = {}) {
      const root = await mkdtemp(join(tmpdir(), 'dsh-jev-gate-'))
      await writeFile(join(root, 'package.json'), JSON.stringify({ scripts }))
      await mkdir(join(root, 'packages', 'api'), { recursive: true })
      await writeFile(join(root, 'packages', 'api', 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }))
      const judge = new FakeJudge().script(yes(1, 1))
      const audit = new MemoryAuditSink()
      const gate = new Gate({ core: new JudgeCore({ judge, audit, env: {} }), sendScripts: opts.sendScripts, context: () => ({ task: 't', project: 'p', projectDir: root }) })
      return { root, judge, audit, gate }
    }
    const stateOf = (judge: FakeJudge) => judge.calls[0]!.state as Record<string, unknown>
    /** What the Gate sends for a call with no Script bodies at all: today's state. */
    async function baseline(command: string) {
      const judge = new FakeJudge().script(yes(1, 1))
      await new Gate({ core: new JudgeCore({ judge, audit: new MemoryAuditSink(), env: {} }), context: () => ({ task: 't', project: 'p' }) }).consider(esc(command))
      return stateOf(judge)
    }

    it('sends the bodies an npm test runs as a named scripts field when sendScripts is on', async () => {
      const { gate, judge, audit } = await project({ pretest: 'tsc --noEmit', test: 'vitest run', posttest: 'echo done', build: 'tsc' }, { sendScripts: true })
      await gate.consider(esc('npm test'))
      expect(stateOf(judge).scripts).toEqual({ pretest: 'tsc --noEmit', test: 'vitest run', posttest: 'echo done' })
      expect(stateOf(judge).commands).toBe('npm test')
      expect(audit.records[0]).toMatchObject({ decision: 'auto-approve', meta: { scripts: 3 } })
      expect(gate.answer(req())).toBe('allowed-once')
    })

    it('sends no scripts field for a command that runs no package script', async () => {
      const { gate, judge } = await project({ test: 'vitest run' }, { sendScripts: true })
      await gate.consider(esc('git status'))
      expect(stateOf(judge)).not.toHaveProperty('scripts')
    })

    it('sends no scripts field when sendScripts is off (the default), so the state matches today', async () => {
      const { gate, judge } = await project({ pretest: 'tsc', test: 'vitest run' })
      await gate.consider(esc('npm test'))
      expect(stateOf(judge)).toEqual(await baseline('npm test'))
    })

    it('redacts tokens in script bodies before the Judge sees them', async () => {
      const { gate, judge } = await project({ test: 'API_KEY=supersecretvalue123 vitest run --token ghp_abcdefghijklmnopqrstuvwxyz0123' }, { sendScripts: true })
      await gate.consider(esc('npm test'))
      const sent = JSON.stringify(stateOf(judge))
      expect(sent).not.toContain('supersecretvalue123')
      expect(sent).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123')
      expect(sent).toContain('[REDACTED]')
    })

    it.each([false, true])('forces the prompt without a Judge call when a body hits the risk list (sendScripts %s)', async (sendScripts) => {
      for (const scripts of [{ test: 'rm -rf ~' } as Record<string, string>, { pretest: 'cat install.txt | sh', test: 'vitest' }, { test: 'npm run build && vitest', build: 'npm publish' }]) {
        const { gate, judge, audit } = await project(scripts, { sendScripts })
        await gate.consider(esc('npm test'))
        expect(judge.calls).toHaveLength(0)
        expect(gate.answer(req())).toBeUndefined()
        expect(audit.records[0]!.decision).toMatch(/^risk-list:script (test|pretest|build): /)
      }
    })

    it('reads the package.json of the directory the command moves to, or of the call\'s workdir', async () => {
      const { root, gate, judge } = await project({ test: 'vitest' }, { sendScripts: true })
      await gate.consider(esc('cd packages/api && npm test', 'a'))
      await gate.consider({ ...esc('npm test', 'b'), arguments: { ...esc('npm test').arguments, workdir: join(root, 'packages', 'api') } })
      expect(judge.calls.map((c) => (c.state as Record<string, unknown>).scripts)).toEqual([{ test: 'jest' }, { test: 'jest' }])
    })

    it('reads nothing outside the project directory', async () => {
      const { gate, judge } = await project({ test: 'vitest' }, { sendScripts: true })
      await gate.consider(esc('cd .. && npm test'))
      expect(stateOf(judge)).not.toHaveProperty('scripts')
    })

    it.each([
      ['missing', null],
      ['malformed', '{nope'],
      ['oversized', JSON.stringify({ scripts: { test: 'rm -rf ~', pad: 'x'.repeat(1_100_000) } })],
      ['without the script', JSON.stringify({ scripts: { build: 'rm -rf ~' } })],
    ])('leaves the Judgment as today with a %s package.json', async (_n, contents) => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-jev-gate-'))
      if (contents !== null) await writeFile(join(root, 'package.json'), contents)
      const judge = new FakeJudge().script(yes(1, 1))
      const gate = new Gate({ core: new JudgeCore({ judge, audit: new MemoryAuditSink(), env: {} }), sendScripts: true, context: () => ({ task: 't', project: 'p', projectDir: root }) })
      await gate.consider(esc('npm test'))
      expect(stateOf(judge)).toEqual(await baseline('npm test'))
      expect(gate.answer(req())).toBe('allowed-once')
    })

    it('leaves the Judgment as today when the working directory cannot be resolved', async () => {
      const { gate, judge } = await project({ test: 'rm -rf ~' }, { sendScripts: true })
      await gate.consider(esc('cd "$PKG" && npm test'))
      expect(stateOf(judge)).toEqual(await baseline('cd "$PKG" && npm test'))
    })

    it('does not resolve bun test or npx', async () => {
      const { gate, judge } = await project({ test: 'rm -rf ~', build: 'rm -rf ~' }, { sendScripts: true })
      await gate.consider(esc('bun test', 'a'))
      await gate.consider(esc('npx build', 'b'))
      expect(judge.calls).toHaveLength(2)
      expect(judge.calls.every((c) => !('scripts' in (c.state as object)))).toBe(true)
    })
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
