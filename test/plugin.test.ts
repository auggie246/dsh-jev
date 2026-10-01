import { describe, expect, it } from 'vitest'
import { Config, apply, inject, name, sessionContext } from '../src/plugin.js'

describe('plugin entry', () => {
  it('exports loader metadata and a schema with every Recipe off by default', () => {
    expect(name).toBe('dsh-jev')
    const cfg = Config({}) as any
    expect(cfg.recipes).toEqual({ gate: false, skillHint: false, verify: false, injectionGuard: false, effortRouting: false })
    expect(cfg.jev).toMatchObject({
      baseUrl: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      apiKeyEnv: 'TYPESAFE_API_KEY',
      timeoutMs: 8000,
    })
  })

  it('loads with all Recipes disabled and registers nothing (no behaviour change)', () => {
    const touched: string[] = []
    const ctx = new Proxy({}, { get: (_t, p) => { touched.push(String(p)); return () => undefined } })
    expect(() => apply(ctx as never, Config({}) as never)).not.toThrow()
    expect(touched).toEqual([])
  })

  it('accepts OpenRouter Decisions settings', () => {
    const cfg = Config({ jev: { baseUrl: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13', apiKeyEnv: 'OPENROUTER_API_KEY' } }) as any
    expect(cfg.jev.apiKeyEnv).toBe('OPENROUTER_API_KEY')
    expect(cfg.recipes.gate).toBe(false)
  })
})

describe('gate wiring', () => {
  it('declares the credentials service so the key can be read from the DSH store', () => {
    expect(inject).toEqual(['credentials'])
  })

  it('registers exactly the two prepended listeners when the Gate is enabled', () => {
    const reg: Array<[string, unknown]> = []
    const ctx = { on: (e: string, _l: unknown, o: unknown) => reg.push([e, o]) }
    apply(ctx as never, Config({ recipes: { gate: true } }) as never)
    expect(reg).toEqual([['tools/pre-execute', { prepend: true }], ['approval/request', { prepend: true }]])
  })

  it('defaults the threshold to 0.9', () => {
    expect((Config({}) as any).gate.threshold).toBe(0.9)
  })
})

describe('sessionContext', () => {
  const msg = (text: string, kind = 'user') => ({ type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } })
  const exec = (events: unknown[]) => ({ name: 'bash', callId: 'c', arguments: {}, agent: { session: { header: { cwd: '/a/b/proj' }, snapshotEvents: () => events } } })

  it('keeps the last three human messages so a short follow-up does not hide the task', () => {
    const ctx = sessionContext(exec([msg('one'), msg('Run the whole test suite'), msg('tool', 'tool'), msg('yes'), msg('go ahead')]) as never)
    expect(ctx).toEqual({ task: 'Run the whole test suite\n---\nyes\n---\ngo ahead', project: 'proj' })
  })

  it('returns an empty context for an unfamiliar session shape', () => {
    expect(sessionContext({ name: 'bash', callId: 'c', arguments: {}, agent: {} } as never)).toEqual({ task: undefined, project: undefined })
  })
})
