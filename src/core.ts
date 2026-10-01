import type { AuditRecord, AuditSink } from './audit.js'
import { prepareState } from './egress.js'
import type { Answer, Judge, JudgeResult, Question } from './judge/types.js'

export interface AskRequest<Q extends Record<string, Question>> {
  recipe: string
  state: string | Record<string, unknown>
  /** State fields a question needs; everything else is trimmed. */
  fields?: string[]
  questions: Q
  /** Names the action taken, for the audit record. */
  decide?: (result: JudgeResult<Q>) => string
  /** Non-sensitive facts recorded in the audit line (sizes, never content). */
  meta?: Record<string, string | number | boolean>
}

export interface JudgeCoreOptions {
  judge: Judge
  audit: AuditSink
  env?: Record<string, string | undefined>
  maxChars?: number
}

function probsOf(a: Answer): number | Record<string, number> {
  return a.type === 'noul' ? a.noul : a.probabilities
}

/** Judge core: egress rule + Judge + audit. Recipes talk to this, never to a backend. Never throws. */
export class JudgeCore {
  constructor(private readonly opts: JudgeCoreOptions) {}

  async ask<Q extends Record<string, Question>>(req: AskRequest<Q>): Promise<{ result: JudgeResult<Q> }> {
    const started = Date.now()
    let result: JudgeResult<Q>
    try {
      const state = prepareState(req.state, {
        env: this.opts.env,
        fields: req.fields,
        maxChars: this.opts.maxChars,
      })
      result = await this.opts.judge.judge({ recipe: req.recipe, state, questions: req.questions })
    } catch (e) {
      result = { status: 'unavailable', reason: 'malformed', detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started }
    }
    const record: AuditRecord = {
      ts: new Date().toISOString(),
      recipe: req.recipe,
      questionIds: Object.keys(req.questions),
      probabilities:
        result.status === 'ok' ? Object.fromEntries(Object.entries(result.answers).map(([k, a]) => [k, probsOf(a as Answer)])) : {},
      decision: this.decisionOf(req, result),
      latencyMs: result.latencyMs,
      ...(result.status === 'ok' && result.usage ? { usage: result.usage } : {}),
      ...(req.meta ? { meta: req.meta } : {}),
    }
    try {
      await this.opts.audit.write(record)
    } catch {
      /* audit is best effort */
    }
    return { result }
  }

  private decisionOf<Q extends Record<string, Question>>(req: AskRequest<Q>, result: JudgeResult<Q>): string {
    if (result.status === 'unavailable') return `unavailable:${result.reason}`
    try {
      return req.decide ? req.decide(result) : 'answered'
    } catch {
      return 'decide-error'
    }
  }
}
