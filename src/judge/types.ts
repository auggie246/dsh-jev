/** Judge contract (ADR 0004): Recipes ask Judgments through this and never call an API directly. */

export interface NoulQuestion {
  type: 'noul'
  instructions: string
  criteria?: { true?: string; false?: string }
}

export interface ChoiceQuestion {
  type: 'choice'
  instructions: string
  /** option -> rubric description (null when no extra detail). */
  criteria: Record<string, string | null>
}

export interface ScoreQuestion {
  type: 'score'
  instructions: string
  /** Ordered level descriptions (at least two). */
  criteria: string[]
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion

export interface NoulAnswer {
  type: 'noul'
  /** Probability of yes, in [0,1]. */
  noul: number
}

export interface ChoiceAnswer {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
  confidence: number
}

export interface ScoreAnswer {
  type: 'score'
  score: number
  /** Level index (as string) -> description. */
  legend: Record<string, string>
  probabilities: Record<string, number>
  confidence: number
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export interface JudgeRequest<Q extends Record<string, Question> = Record<string, Question>> {
  /** Recipe name, for the audit record. */
  recipe: string
  /** Already-redacted, trimmed state (see egress.ts). */
  state: string | object
  questions: Q
}

export type AnswersFor<Q extends Record<string, Question>> = {
  [K in keyof Q]: Q[K] extends NoulQuestion
    ? NoulAnswer
    : Q[K] extends ChoiceQuestion
      ? ChoiceAnswer
      : Q[K] extends ScoreQuestion
        ? ScoreAnswer
        : Answer
}

export interface JudgeOk<Q extends Record<string, Question>> {
  status: 'ok'
  answers: AnswersFor<Q>
  usage?: Usage
  latencyMs: number
}

/** Fall-through signal: the caller must behave as if no Judge existed. */
export interface JudgeUnavailable {
  status: 'unavailable'
  reason: 'timeout' | 'http-error' | 'network' | 'malformed' | 'out-of-range' | 'missing-answer' | 'no-key' | 'disabled'
  detail?: string
  latencyMs: number
}

export type JudgeResult<Q extends Record<string, Question>> = JudgeOk<Q> | JudgeUnavailable

export interface Judge {
  /** Never throws: every failure is an `unavailable` result. */
  judge<Q extends Record<string, Question>>(req: JudgeRequest<Q>): Promise<JudgeResult<Q>>
}
