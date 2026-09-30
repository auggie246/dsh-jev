import { describe, expect, it } from 'vitest'
import { FakeJudge } from '../src/judge/fake.js'
import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from '../src/judge/types.js'

const noul: NoulQuestion = { type: 'noul', instructions: 'Is it safe?' }
const choice: ChoiceQuestion = { type: 'choice', instructions: 'Which?', criteria: { a: null, b: 'bee' } }
const score: ScoreQuestion = { type: 'score', instructions: 'How bad?', criteria: ['low', 'high'] }

describe('FakeJudge', () => {
  it('round-trips noul, choice and score answers and records calls', async () => {
    const fake = new FakeJudge()
    fake.script({
      safe: { type: 'noul', noul: 0.97 },
      pick: { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.2 }, confidence: 0.7 },
      bad: { type: 'score', score: 0.4, legend: { '0': 'low', '1': 'high' }, probabilities: { '0': 0.6, '1': 0.4 }, confidence: 0.5 },
    })
    const req = { recipe: 'gate', state: { cmd: 'ls' }, questions: { safe: noul, pick: choice, bad: score } }
    const res = await fake.judge(req)
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.answers.safe.noul).toBe(0.97)
    expect(res.answers.pick.choice).toBe('a')
    expect(res.answers.bad.score).toBe(0.4)
    expect(fake.calls).toEqual([req])
  })

  it('can be scripted as unavailable and as a function of the request', async () => {
    const fake = new FakeJudge()
    fake.unavailable('timeout')
    const res = await fake.judge({ recipe: 'x', state: 's', questions: { q: noul } })
    expect(res).toMatchObject({ status: 'unavailable', reason: 'timeout' })
    fake.script((req) => ({ q: { type: 'noul', noul: req.state === 's' ? 1 : 0 } }))
    const ok = await fake.judge({ recipe: 'x', state: 's', questions: { q: noul } })
    expect(ok.status === 'ok' && ok.answers.q.noul).toBe(1)
  })

  it('returns unavailable when nothing is scripted', async () => {
    const res = await new FakeJudge().judge({ recipe: 'x', state: 's', questions: { q: noul } })
    expect(res.status).toBe('unavailable')
  })
})
