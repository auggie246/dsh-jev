#!/usr/bin/env node
/** `dsh-jev-calibrate`: replay a golden set against a Judge and report approve / false-approve / false-prompt per threshold. */
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { calibrate, fakeJudgeFor, formatReport, parseGoldenSet } from './calibrate.js'
import { JEV_DEFAULTS, JevJudge } from './judge/jev.js'

export interface CliIo {
  env: Record<string, string | undefined>
  fetch: typeof fetch
  stdout: (text: string) => void
  stderr: (text: string) => void
  readFile: (path: string) => Promise<string>
}

const MAX_REPEAT = 100

const USAGE = `usage: dsh-jev-calibrate <golden.json> [options]

  --judge auto|fake|jev   auto (default) uses Jev when its key is in the environment, else the offline fake
  --thresholds a,b,c      thresholds to report (default 0.5,0.6,0.7,0.75,0.8,0.85,0.9,0.95,0.99)
  --repeat N              replay every case N times (1-100, default 1) to show how far scores vary between runs
  --json                  print the full report, including every case, as JSON
  --send-scripts          replay as a Gate with gate.sendScripts on (cases' Script bodies are sent to the Judge)
  --base-url URL          Jev endpoint (default ${JEV_DEFAULTS.baseUrl})
  --model NAME            Jev model (default ${JEV_DEFAULTS.model})
  --api-key-env NAME      env var holding the key (default ${JEV_DEFAULTS.apiKeyEnv})
  --timeout-ms N          per-Judgment timeout (default ${JEV_DEFAULTS.timeoutMs})
`

const defaultIo = (): CliIo => ({
  env: process.env,
  fetch: globalThis.fetch,
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  readFile: (path) => readFile(path, 'utf8'),
})

/** Returns the exit code: 0 on a completed run, 2 on a usage or input error. */
export async function main(argv: string[], overrides: Partial<CliIo> = {}): Promise<number> {
  const io = { ...defaultIo(), ...overrides }
  const fail = (message: string) => {
    io.stderr(`dsh-jev-calibrate: ${message}\n`)
    return 2
  }
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
  const { values, positionals } = parsed
  if (positionals.length !== 1) {
    io.stderr(USAGE)
    return 2
  }
  const mode = values.judge ?? 'auto'
  if (mode !== 'auto' && mode !== 'fake' && mode !== 'jev') return fail(`--judge must be auto, fake or jev, got "${mode}"`)

  let thresholds: number[] | undefined
  if (values.thresholds !== undefined) {
    thresholds = values.thresholds.split(',').map((s) => (/^\d*\.?\d+$/.test(s.trim()) ? Number(s) : Number.NaN))
    if (thresholds.some((t) => !(t >= 0 && t <= 1))) return fail('--thresholds must be comma-separated numbers between 0 and 1')
  }
  const repeat = values.repeat === undefined ? 1 : /^\d+$/.test(values.repeat) ? Number(values.repeat) : Number.NaN
  if (!(repeat >= 1 && repeat <= MAX_REPEAT)) return fail(`--repeat must be a whole number from 1 to ${MAX_REPEAT}`)
  const timeoutMs = values['timeout-ms'] === undefined ? JEV_DEFAULTS.timeoutMs : Number(values['timeout-ms'])
  if (!(timeoutMs > 0)) return fail('--timeout-ms must be a positive number')

  let cases
  try {
    cases = parseGoldenSet(await io.readFile(positionals[0]!).catch((e) => Promise.reject(new Error(`cannot read ${positionals[0]}: ${e instanceof Error ? e.message : String(e)}`))))
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }

  const apiKeyEnv = values['api-key-env'] ?? JEV_DEFAULTS.apiKeyEnv
  const hasKey = Boolean(io.env[apiKeyEnv])
  if (mode === 'jev' && !hasKey) return fail(`--judge jev needs ${apiKeyEnv} in the environment`)
  const useJev = mode === 'jev' || (mode === 'auto' && hasKey)
  if (mode === 'auto' && !useJev) io.stderr(`dsh-jev-calibrate: ${apiKeyEnv} is not set, so this run uses the offline fake Judge (it checks the plumbing, not Jev)\n`)

  const judge = useJev
    ? new JevJudge({ baseUrl: values['base-url'] ?? JEV_DEFAULTS.baseUrl, model: values.model ?? JEV_DEFAULTS.model, apiKeyEnv, timeoutMs, fetch: io.fetch, env: io.env })
    : fakeJudgeFor
  const label = useJev ? 'jev' : 'fake'
  // The report goes to stdout only; the run never touches the audit file.
  const report = await calibrate(cases, { judge, thresholds, repeat, env: io.env, sendScripts: values['send-scripts'] ?? false })
  io.stdout(values.json ? `${JSON.stringify({ judge: label, ...report }, null, 2)}\n` : formatReport(report, { judge: label }))
  return 0
}

const OPTIONS = {
  judge: { type: 'string' },
  thresholds: { type: 'string' },
  repeat: { type: 'string' },
  json: { type: 'boolean' },
  'send-scripts': { type: 'boolean' },
  'base-url': { type: 'string' },
  model: { type: 'string' },
  'api-key-env': { type: 'string' },
  'timeout-ms': { type: 'string' },
} as const

// Run only when invoked as a program (through the `bin` symlink too), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2))
