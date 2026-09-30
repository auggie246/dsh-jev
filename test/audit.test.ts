import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JsonlAuditSink, MemoryAuditSink, auditDir } from '../src/audit.js'
import { JudgeCore } from '../src/core.js'
import { FakeJudge } from '../src/judge/fake.js'

describe('auditDir', () => {
  it('uses $DSH_HOME, else ~/.dsh', () => {
    expect(auditDir({ DSH_HOME: '/x/dsh' }, '/home/u')).toBe('/x/dsh/dsh-jev')
    expect(auditDir({}, '/home/u')).toBe('/home/u/.dsh/dsh-jev')
  })
})

describe('JsonlAuditSink', () => {
  it('appends one JSON line per record, creating the directory', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'dsh-jev-')), 'nested')
    const sink = new JsonlAuditSink(dir)
    const rec = { ts: 't', recipe: 'gate', questionIds: ['a'], probabilities: { a: 0.9 }, decision: 'allow', latencyMs: 3 }
    await sink.write(rec)
    await sink.write({ ...rec, decision: 'ask' })
    const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n')
    expect(lines.map((l) => JSON.parse(l).decision)).toEqual(['allow', 'ask'])
  })

  it('never throws when the directory is unwritable', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dsh-jev-')), 'afile')
    writeFileSync(file, 'x')
    await expect(new JsonlAuditSink(join(file, 'sub')).write({ ts: 't', recipe: 'r', questionIds: [], probabilities: {}, decision: 'd', latencyMs: 0 })).resolves.toBeUndefined()
  })
})

describe('JudgeCore', () => {
  const questions = {
    safe: { type: 'noul' as const, instructions: 'safe?' },
    pick: { type: 'choice' as const, instructions: 'which', criteria: { a: null, b: null } },
  }

  it('redacts state before the Judge sees it and audits the Judgment', async () => {
    const fake = new FakeJudge().script({
      safe: { type: 'noul', noul: 0.95 },
      pick: { type: 'choice', choice: 'a', probabilities: { a: 0.7, b: 0.3 }, confidence: 0.6 },
    })
    const audit = new MemoryAuditSink()
    const core = new JudgeCore({ judge: fake, audit, env: { MY_SECRET: 'supersecretvalue' } })
    const { result } = await core.ask({
      recipe: 'gate',
      state: { command: 'echo supersecretvalue', junk: 'zzz' },
      fields: ['command'],
      questions,
      decide: (r) => (r.status === 'ok' && r.answers.safe.noul >= 0.9 ? 'allow' : 'ask'),
    })
    expect(result.status).toBe('ok')
    expect(JSON.stringify(fake.calls[0]!.state)).not.toContain('supersecretvalue')
    expect(JSON.stringify(fake.calls[0]!.state)).not.toContain('zzz')
    expect(audit.records).toHaveLength(1)
    expect(audit.records[0]).toMatchObject({
      recipe: 'gate',
      questionIds: ['safe', 'pick'],
      probabilities: { safe: 0.95, pick: { a: 0.7, b: 0.3 } },
      decision: 'allow',
    })
    expect(typeof audit.records[0]!.latencyMs).toBe('number')
  })

  it('audits unavailable Judgments too, and never throws even if the sink does', async () => {
    const audit = { write: async () => { throw new Error('disk full') } }
    const fake = new FakeJudge().unavailable('timeout')
    const core = new JudgeCore({ judge: fake, audit })
    const { result } = await core.ask({ recipe: 'gate', state: 's', questions })
    expect(result).toMatchObject({ status: 'unavailable', reason: 'timeout' })
    const mem = new MemoryAuditSink()
    await new JudgeCore({ judge: fake, audit: mem }).ask({ recipe: 'gate', state: 's', questions })
    expect(mem.records[0]).toMatchObject({ decision: 'unavailable:timeout', probabilities: {} })
  })
})

describe('JudgeCore never throws', () => {
  const questions = { safe: { type: 'noul', instructions: 'safe?' } } as const
  it('falls through when the Judge rejects', async () => {
    const judge = { judge: async () => { throw new Error('boom') } }
    const core = new JudgeCore({ judge, audit: new MemoryAuditSink() })
    const { result } = await core.ask({ recipe: 'gate', state: 'x', questions })
    expect(result.status).toBe('unavailable')
  })
  it('falls through when object state names no fields (Egress rule)', async () => {
    const audit = new MemoryAuditSink()
    const core = new JudgeCore({ judge: new FakeJudge(), audit })
    const { result } = await core.ask({ recipe: 'gate', state: { command: 'ls' }, questions })
    expect(result.status).toBe('unavailable')
    expect(audit.records).toHaveLength(1)
  })
})
