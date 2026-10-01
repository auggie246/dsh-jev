import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { JevJudge, type JevConfig } from '../src/judge/jev.js'
import type { JudgeRequest, Question } from '../src/judge/types.js'

const fixture = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'))
const reqFixture = fixture('systemone-request.json')
const respFixture = fixture('systemone-response.json')

const request = (): JudgeRequest<Record<string, Question>> => ({
  recipe: 'test',
  state: reqFixture.state,
  questions: reqFixture.questions,
})

interface Seen { url: string; init: RequestInit }
function make(reply: (seen: Seen) => Response | Promise<Response>, cfg: Partial<JevConfig> = {}) {
  const seen: Seen[] = []
  const judge = new JevJudge({
    env: { TYPESAFE_API_KEY: 'sk-test' },
    fetch: (async (url: string, init: RequestInit) => {
      const s = { url, init }
      seen.push(s)
      return reply(s)
    }) as unknown as typeof fetch,
    ...cfg,
  })
  return { judge, seen }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const clone = <T>(x: T): T => structuredClone(x)

describe('JevJudge request shape (TypeSafe systemone)', () => {
  it('POSTs {state, model, questions} with bearer auth to /v1/systemone', async () => {
    const { judge, seen } = make(() => json(respFixture))
    await judge.judge(request())
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(seen[0]!.init.method).toBe('POST')
    const headers = seen[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
    expect(headers['content-type']).toBe('application/json')
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual(reqFixture)
  })

  it('supports OpenRouter Decisions by config only', async () => {
    const { judge, seen } = make(() => json(respFixture), {
      baseUrl: 'https://openrouter.ai/api/alpha/decisions',
      model: 'typesafe/jev-1.13',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      env: { OPENROUTER_API_KEY: 'or-key' },
    })
    await judge.judge(request())
    expect(seen[0]!.url).toBe('https://openrouter.ai/api/alpha/decisions')
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer or-key')
    expect(JSON.parse(seen[0]!.init.body as string).model).toBe('typesafe/jev-1.13')
  })

  it('does not double the systemone path when base already ends in it', async () => {
    const { judge, seen } = make(() => json(respFixture), { baseUrl: 'https://api.typesafe.ai/v1/systemone/' })
    await judge.judge(request())
    expect(seen[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')
  })
})

describe('JevJudge response parsing', () => {
  it('maps the documented response to typed answers and usage', async () => {
    const { judge } = make(() => json(respFixture))
    const res = await judge.judge(request())
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.answers.is_urgent).toEqual({ type: 'noul', noul: 0.95 })
    expect(res.answers.department).toMatchObject({ type: 'choice', choice: 'billing', confidence: 0.81 })
    expect(res.answers.frustration).toMatchObject({ type: 'score', score: 1.05 })
    expect(res.usage).toEqual({ inputTokens: 296, outputTokens: 20 })
    expect(res.latencyMs).toBeGreaterThanOrEqual(0)
  })
})

describe('JevJudge unavailable results (never throws)', () => {
  const cases: Array<[string, () => Response | Promise<Response>, string]> = [
    ['HTTP 500', () => json({ error: 'boom' }, 500), 'http-error'],
    ['HTTP 401', () => json({ error: 'nope' }, 401), 'http-error'],
    ['HTTP 429', () => json({}, 429), 'http-error'],
    ['non-JSON body', () => new Response('<html>', { status: 200 }), 'malformed'],
    ['JSON without answers', () => json({ model: 'x' }), 'malformed'],
    ['network error', () => { throw new Error('ECONNRESET') }, 'network'],
  ]
  for (const [name, reply, reason] of cases) {
    it(`${name} -> ${reason}`, async () => {
      const { judge } = make(reply)
      expect(await judge.judge(request())).toMatchObject({ status: 'unavailable', reason })
    })
  }

  it('missing answer for a question', async () => {
    const r = clone(respFixture)
    delete r.answers.department
    const { judge } = make(() => json(r))
    expect(await judge.judge(request())).toMatchObject({ status: 'unavailable', reason: 'missing-answer' })
  })

  it('answer type mismatch is malformed', async () => {
    const r = clone(respFixture)
    r.answers.is_urgent = { type: 'choice', choice: 'x' }
    const { judge } = make(() => json(r))
    expect(await judge.judge(request())).toMatchObject({ status: 'unavailable', reason: 'malformed' })
  })

  const outOfRange: Array<[string, (r: any) => void]> = [
    ['noul > 1', (r) => { r.answers.is_urgent.noul = 1.2 }],
    ['noul < 0', (r) => { r.answers.is_urgent.noul = -0.1 }],
    ['noul NaN-ish string', (r) => { r.answers.is_urgent.noul = '0.9' }],
    ['choice probability > 1', (r) => { r.answers.department.probabilities.billing = 1.5 }],
    ['choice confidence > 1', (r) => { r.answers.department.confidence = 2 }],
    ['score probability < 0', (r) => { r.answers.frustration.probabilities['0'] = -0.2 }],
    ['score outside level range', (r) => { r.answers.frustration.score = 7 }],
  ]
  for (const [name, mutate] of outOfRange) {
    it(`out of range: ${name}`, async () => {
      const r = clone(respFixture)
      mutate(r)
      const { judge } = make(() => json(r))
      const res = await judge.judge(request())
      expect(res.status).toBe('unavailable')
      expect(res.status === 'unavailable' && ['out-of-range', 'malformed']).toContain(
        res.status === 'unavailable' ? res.reason : '',
      )
    })
  }

  it('choice selection not among the offered options is malformed', async () => {
    const r = clone(respFixture)
    r.answers.department.choice = 'legal'
    const { judge } = make(() => json(r))
    expect(await judge.judge(request())).toMatchObject({ status: 'unavailable', reason: 'malformed' })
  })

  it('timeout aborts the request', async () => {
    const { judge } = make(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
        }),
      { timeoutMs: 20 },
    )
    const res = await judge.judge(request())
    expect(res).toMatchObject({ status: 'unavailable', reason: 'timeout' })
  })

  it('prefers a key from resolveKey (DSH credential store) over env, and survives it throwing', async () => {
    const a = make(() => json(respFixture), { resolveKey: async () => 'sk-store' })
    await a.judge.judge(request())
    expect((a.seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-store')
    const b = make(() => json(respFixture), { resolveKey: async () => { throw new Error('boom') } })
    await b.judge.judge(request())
    expect((b.seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
  })

  it('missing API key is unavailable without calling fetch', async () => {
    const { judge, seen } = make(() => json(respFixture), { env: {} })
    expect(await judge.judge(request())).toMatchObject({ status: 'unavailable', reason: 'no-key' })
    expect(seen).toHaveLength(0)
  })

  it('defaults: 8s timeout, jev-latest', () => {
    const j = new JevJudge({ env: {} })
    expect(j.config.timeoutMs).toBe(8000)
    expect(j.config.model).toBe('jev-latest')
    expect(j.config.apiKeyEnv).toBe('TYPESAFE_API_KEY')
    expect(j.config.baseUrl).toBe('https://api.typesafe.ai/v1/systemone')
  })
})
