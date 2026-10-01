import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { MemoryAuditSink } from '../src/audit.js'
import { JudgeCore } from '../src/core.js'
import { Gate, registerGate } from '../src/gate.js'
import { FakeJudge } from '../src/judge/fake.js'

/** Real Cordis waterfall ordering: our prepended listeners run before the stock answerer/decision. */
async function run(noul: number) {
  const ctx = new Context() as any
  const judge = new FakeJudge().script(Object.fromEntries(['keepsData', 'leavesOutsideAlone', 'nothingShipped', 'servesTask'].map((id) => [id, { type: 'noul', noul }])))
  registerGate(ctx, new Gate({ core: new JudgeCore({ judge, audit: new MemoryAuditSink(), env: {} }) }))
  ctx.on('approval/request', async () => 'rejected') // stand-in for the user prompt
  const exec = { name: 'bash', callId: 'c1', arguments: { command: 'bun test', sandbox_permissions: 'danger-full-access', justification: 'net' } }
  const pre = await ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }))
  const outcome = await ctx.waterfall('approval/request', { toolName: 'bash', callId: 'c1' }, async () => 'unavailable')
  return { pre, outcome }
}

describe('Gate on a real Cordis context', () => {
  it('confident verdict: escalation auto-approved, pre-execute still allow', async () => {
    expect(await run(0.97)).toEqual({ pre: { kind: 'allow' }, outcome: 'allowed-once' })
  })
  it('low verdict: reaches the normal answerer', async () => {
    expect(await run(0.5)).toEqual({ pre: { kind: 'allow' }, outcome: 'rejected' })
  })
})
