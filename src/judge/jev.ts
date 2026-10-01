import type {
  Answer,
  ChoiceAnswer,
  Judge,
  JudgeRequest,
  JudgeResult,
  JudgeUnavailable,
  NoulAnswer,
  Question,
  ScoreAnswer,
  Usage,
} from './types.js'

export interface JevConfig {
  /** Full endpoint URL. Default: TypeSafe systemone. OpenRouter Decisions: https://openrouter.ai/api/alpha/decisions */
  baseUrl: string
  /** Default `jev-latest`; OpenRouter uses `typesafe/jev-1.13`. */
  model: string
  /** Name of the env var holding the bearer key. */
  apiKeyEnv: string
  timeoutMs: number
  /** Injectable for tests. */
  fetch?: typeof fetch
  env?: Record<string, string | undefined>
  /** Preferred key source (e.g. DSH's credential store); falls back to `env[apiKeyEnv]`. */
  resolveKey?: () => Promise<string | undefined>
}

export const JEV_DEFAULTS = {
  baseUrl: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest',
  apiKeyEnv: 'TYPESAFE_API_KEY',
  timeoutMs: 8000,
} as const

class Bad extends Error {
  constructor(readonly reason: JudgeUnavailable['reason'], message: string) {
    super(message)
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isProb = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1

function prob(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Bad('malformed', `${what} is not a number`)
  if (!isProb(v)) throw new Bad('out-of-range', `${what}=${v} outside [0,1]`)
  return v
}

function probs(v: unknown, what: string): Record<string, number> {
  if (!isObj(v)) throw new Bad('malformed', `${what} missing`)
  const out: Record<string, number> = {}
  for (const [k, p] of Object.entries(v)) out[k] = prob(p, `${what}.${k}`)
  return out
}

function parseAnswer(id: string, q: Question, raw: unknown): Answer {
  if (!isObj(raw)) throw new Bad('missing-answer', `no answer for ${id}`)
  if (raw.type !== q.type) throw new Bad('malformed', `${id}: expected ${q.type}, got ${String(raw.type)}`)
  switch (q.type) {
    case 'noul':
      return { type: 'noul', noul: prob(raw.noul, `${id}.noul`) } satisfies NoulAnswer
    case 'choice': {
      const probabilities = probs(raw.probabilities, `${id}.probabilities`)
      const confidence = prob(raw.confidence, `${id}.confidence`)
      const choice = raw.choice
      if (typeof choice !== 'string' || !Object.hasOwn(q.criteria, choice)) throw new Bad('malformed', `${id}: choice not among options`)
      return { type: 'choice', choice, probabilities, confidence } satisfies ChoiceAnswer
    }
    case 'score': {
      const probabilities = probs(raw.probabilities, `${id}.probabilities`)
      const confidence = prob(raw.confidence, `${id}.confidence`)
      const score = raw.score
      if (typeof score !== 'number' || !Number.isFinite(score)) throw new Bad('malformed', `${id}.score`)
      if (score < 0 || score > q.criteria.length - 1) throw new Bad('out-of-range', `${id}.score=${score} outside levels`)
      const legend = isObj(raw.legend) ? (raw.legend as Record<string, string>) : {}
      return { type: 'score', score, legend, probabilities, confidence } satisfies ScoreAnswer
    }
  }
}

export class JevJudge implements Judge {
  readonly config: Required<Omit<JevConfig, 'fetch' | 'env' | 'resolveKey'>>
  private readonly fetchImpl: typeof fetch
  private readonly env: Record<string, string | undefined>
  private readonly resolveKey?: () => Promise<string | undefined>

  constructor(cfg: Partial<JevConfig> = {}) {
    this.config = {
      baseUrl: (cfg.baseUrl ?? JEV_DEFAULTS.baseUrl).replace(/\/+$/, ''),
      model: cfg.model ?? JEV_DEFAULTS.model,
      apiKeyEnv: cfg.apiKeyEnv ?? JEV_DEFAULTS.apiKeyEnv,
      timeoutMs: cfg.timeoutMs ?? JEV_DEFAULTS.timeoutMs,
    }
    this.fetchImpl = cfg.fetch ?? fetch
    this.env = cfg.env ?? process.env
    this.resolveKey = cfg.resolveKey
  }

  async judge<Q extends Record<string, Question>>(req: JudgeRequest<Q>): Promise<JudgeResult<Q>> {
    const start = performance.now()
    const unavailable = (reason: JudgeUnavailable['reason'], detail?: string): JudgeUnavailable => ({
      status: 'unavailable',
      reason,
      ...(detail === undefined ? {} : { detail }),
      latencyMs: Math.round(performance.now() - start),
    })
    try {
      const key = (await this.resolveKey?.().catch(() => undefined)) || this.env[this.config.apiKeyEnv]
      if (!key) return unavailable('no-key', `${this.config.apiKeyEnv} is not set`)

      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(new Bad('timeout', `timed out after ${this.config.timeoutMs}ms`)), this.config.timeoutMs)
      let res: Response
      let text: string
      try {
        res = await this.fetchImpl(this.config.baseUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ state: req.state, model: this.config.model, questions: req.questions }),
          signal: ctrl.signal,
        })
        if (!res.ok) return unavailable('http-error', `HTTP ${res.status}`)
        text = await res.text()
      } catch (e) {
        if (ctrl.signal.aborted) return unavailable('timeout', `timed out after ${this.config.timeoutMs}ms`)
        return unavailable('network', e instanceof Error ? e.message : String(e))
      } finally {
        clearTimeout(timer)
      }

      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        return unavailable('malformed', 'body is not JSON')
      }
      if (!isObj(body) || !isObj(body.answers)) return unavailable('malformed', 'no answers map')

      const answers: Record<string, Answer> = {}
      for (const [id, q] of Object.entries(req.questions)) answers[id] = parseAnswer(id, q, body.answers[id])

      let usage: Usage | undefined
      if (isObj(body.usage) && typeof body.usage.input_tokens === 'number' && typeof body.usage.output_tokens === 'number') {
        usage = { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens }
      }
      return { status: 'ok', answers: answers as never, ...(usage ? { usage } : {}), latencyMs: Math.round(performance.now() - start) }
    } catch (e) {
      if (e instanceof Bad) return unavailable(e.reason, e.message)
      return unavailable('network', e instanceof Error ? e.message : String(e))
    }
  }
}
