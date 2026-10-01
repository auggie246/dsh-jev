import { describe, expect, it, vi } from 'vitest'
import { main, type CliIo } from '../src/calibrate-cli.js'

const SEED = new URL('../golden/gate.seed.json', import.meta.url).pathname

function run(argv: string[], io: Partial<CliIo> = {}) {
  let out = ''
  let err = ''
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    throw new Error('network is not available in this test')
  })
  return main(argv, { env: {}, fetch, stdout: (s) => (out += s), stderr: (s) => (err += s), ...io }).then((code) => ({ code, out, err, fetch }))
}

/** Jev stub that answers every question with `score`. */
const jevStub = (score: number) =>
  vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { questions: Record<string, unknown> }
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: score }]))
    return new Response(JSON.stringify({ answers }), { status: 200 })
  })

describe('dsh-jev-calibrate', () => {
  it('runs the seed set against the fake Judge with no network', async () => {
    const { code, out, fetch } = await run([SEED, '--judge', 'fake'])
    expect(code).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
    expect(out).toContain('judge: fake')
    expect(out).toMatch(/gate: 13 cases/)
    expect(out).toMatch(/recommended threshold at zero false-approves: 0\.85/)
  })

  it('defaults to the fake Judge when no key is present, and says so', async () => {
    const { code, out, err, fetch } = await run([SEED])
    expect(code).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
    expect(out).toContain('judge: fake')
    expect(err).toMatch(/TYPESAFE_API_KEY.*not set.*fake/i)
  })

  it('uses real Jev when the key is present', async () => {
    const fetch = jevStub(1)
    const { code, out } = await run([SEED], { env: { TYPESAFE_API_KEY: 'k-123456789' }, fetch })
    expect(code).toBe(0)
    expect(out).toContain('judge: jev')
    // 13 cases, one stopped by the risk list before any Judgment.
    expect(fetch).toHaveBeenCalledTimes(12)
    expect(fetch.mock.calls[0]![0]).toBe('https://api.typesafe.ai/v1/systemone')
    // Everything scored 1, so every should-prompt case is falsely approved at every threshold.
    expect(out).toMatch(/recommended threshold: none/)
  })

  it('does not call Jev when --judge fake is forced, even with a key', async () => {
    const fetch = jevStub(1)
    const { out } = await run([SEED, '--judge', 'fake'], { env: { TYPESAFE_API_KEY: 'k-123456789' }, fetch })
    expect(fetch).not.toHaveBeenCalled()
    expect(out).toContain('judge: fake')
  })

  it('honours the endpoint, model and key variable flags', async () => {
    const fetch = jevStub(0.5)
    await run([SEED, '--judge', 'jev', '--base-url', 'https://openrouter.ai/api/alpha/decisions', '--model', 'typesafe/jev-1.13', '--api-key-env', 'OPENROUTER_API_KEY'], { env: { OPENROUTER_API_KEY: 'or-123456789' }, fetch })
    expect(fetch.mock.calls[0]![0]).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body)).model).toBe('typesafe/jev-1.13')
  })

  it('refuses --judge jev without a key, before any request', async () => {
    const { code, err, fetch } = await run([SEED, '--judge', 'jev'])
    expect(code).toBe(2)
    expect(err).toContain('TYPESAFE_API_KEY')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('counts an unreachable Jev as unavailable rather than failing the run', async () => {
    const { code, out } = await run([SEED, '--judge', 'jev'], { env: { TYPESAFE_API_KEY: 'k-123456789' } })
    expect(code).toBe(0)
    expect(out).toMatch(/12 Judge unavailable/)
  })

  it('limits the table to --thresholds', async () => {
    const { out } = await run([SEED, '--thresholds', '0.8,0.9'])
    const rows = out.split('\n').filter((l) => /^\s+0\.\d\d\s+\d+\.\d%/.test(l))
    expect(rows).toHaveLength(2)
  })

  it('asks Jev once per run with --repeat', async () => {
    const fetch = jevStub(1)
    const { code, out } = await run([SEED, '--repeat', '3'], { env: { TYPESAFE_API_KEY: 'k-123456789' }, fetch })
    expect(code).toBe(0)
    expect(fetch).toHaveBeenCalledTimes(36)
    expect(out).toMatch(/gate: 13 cases × 3 runs/)
  })

  it('reports the number of runs in --json', async () => {
    const { out } = await run([SEED, '--repeat', '2', '--json'])
    const report = JSON.parse(out)
    expect(report.recipes[0]).toMatchObject({ cases: 13, runs: 2 })
    expect(report.results).toHaveLength(26)
  })

  it('prints machine-readable output with --json', async () => {
    const { code, out } = await run([SEED, '--json'])
    expect(code).toBe(0)
    const report = JSON.parse(out)
    expect(report.judge).toBe('fake')
    expect(report.recipes[0]).toMatchObject({ recipe: 'gate', cases: 13, recommended: 0.85 })
    expect(report.results).toHaveLength(13)
  })

  it.each([
    ['no file', [], /usage/i],
    ['two files', ['a.json', 'b.json'], /usage/i],
    ['unknown option', [SEED, '--nope'], /nope/],
    ['unknown judge', [SEED, '--judge', 'gpt'], /judge/],
    ['bad threshold', [SEED, '--thresholds', '0.5,high'], /thresholds/],
    ['out-of-range threshold', [SEED, '--thresholds', '1.5'], /thresholds/],
    ['zero repeat', [SEED, '--repeat', '0'], /repeat/],
    ['fractional repeat', [SEED, '--repeat', '1.5'], /repeat/],
    ['huge repeat', [SEED, '--repeat', '1000'], /repeat/],
    ['non-numeric repeat', [SEED, '--repeat', 'many'], /repeat/],
    ['hex threshold', [SEED, '--thresholds', '0x1'], /thresholds/],
    ['exponent threshold', [SEED, '--thresholds', '5e-1'], /thresholds/],
    ['missing file', ['/no/such/golden.json'], /no\/such\/golden\.json/],
  ])('exits 2 with a message on %s', async (_n, argv, message) => {
    const { code, err } = await run(argv as string[])
    expect(code).toBe(2)
    expect(err).toMatch(message)
  })

  it('exits 2 and names the case when the golden set is invalid', async () => {
    const { code, err } = await run(['bad.json'], { readFile: async () => JSON.stringify({ version: 1, cases: [{ recipe: 'gate', state: { arguments: {} }, expected: 'approve', note: 'n' }] }) })
    expect(code).toBe(2)
    expect(err).toMatch(/case 1/)
  })
})
