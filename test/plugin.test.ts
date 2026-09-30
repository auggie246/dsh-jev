import { describe, expect, it } from 'vitest'
import { Config, apply, name } from '../src/plugin.js'

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
