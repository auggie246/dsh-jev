import type { Answer, Judge, JudgeRequest, JudgeResult, JudgeUnavailable, Question } from './types.js'

type Script = Record<string, Answer> | ((req: JudgeRequest) => Record<string, Answer>)

/** Scriptable Judge for tests; records every request it receives. */
export class FakeJudge implements Judge {
  readonly calls: JudgeRequest[] = []
  private next: { script: Script } | { unavailable: JudgeUnavailable['reason'] } | undefined

  script(script: Script): this {
    this.next = { script }
    return this
  }

  unavailable(reason: JudgeUnavailable['reason'] = 'network'): this {
    this.next = { unavailable: reason }
    return this
  }

  async judge<Q extends Record<string, Question>>(req: JudgeRequest<Q>): Promise<JudgeResult<Q>> {
    this.calls.push(req)
    const next = this.next
    if (!next) return { status: 'unavailable', reason: 'disabled', detail: 'FakeJudge not scripted', latencyMs: 0 }
    if ('unavailable' in next) return { status: 'unavailable', reason: next.unavailable, latencyMs: 0 }
    const answers = typeof next.script === 'function' ? next.script(req) : next.script
    return { status: 'ok', answers: answers as never, latencyMs: 0 }
  }
}
