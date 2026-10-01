import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { JsonlAuditSink } from './audit.js'
import { JudgeCore } from './core.js'
import { DEFAULT_THRESHOLD, Gate, registerGate, type GateCallContext, type GateExec } from './gate.js'
import { JEV_DEFAULTS, JevJudge } from './judge/jev.js'

export const name = 'dsh-jev'

/** Cordis only exposes `ctx.credentials` to plugins that declare it. */
export const inject = ['credentials']

export interface Config {
  /** Per-Recipe opt-in (Egress rule: nothing leaves the machine until enabled). */
  recipes?: {
    gate?: boolean
    skillHint?: boolean
    verify?: boolean
    injectionGuard?: boolean
    effortRouting?: boolean
  }
  jev?: {
    baseUrl?: string
    model?: string
    /** Name of the env var holding the API key (never the key itself). */
    apiKeyEnv?: string
    timeoutMs?: number
  }
  gate?: {
    /** Every Noul answer must reach this to auto-approve. */
    threshold?: number
    /** Send package.json Script bodies to the Judge (off the machine). They are always checked locally either way. */
    sendScripts?: boolean
  }
}

export const Config: z<Config> = z.object({
  recipes: z
    .object({
      gate: z.boolean().default(false),
      skillHint: z.boolean().default(false),
      verify: z.boolean().default(false),
      injectionGuard: z.boolean().default(false),
      effortRouting: z.boolean().default(false),
    })
    .default({}),
  jev: z
    .object({
      baseUrl: z.string().default(JEV_DEFAULTS.baseUrl),
      model: z.string().default(JEV_DEFAULTS.model),
      apiKeyEnv: z.string().default(JEV_DEFAULTS.apiKeyEnv),
      timeoutMs: z.number().default(JEV_DEFAULTS.timeoutMs),
    })
    .default({}),
  gate: z.object({ threshold: z.number().min(0).max(1).default(DEFAULT_THRESHOLD), sendScripts: z.boolean().default(false) }).default({}),
}) as never

/** Best effort: latest human task and cwd from the calling agent's session; empty when the shape is unfamiliar. */
export function sessionContext(exec: GateExec): GateCallContext {
  try {
    const session = (exec.agent as any)?.session
    const cwd: unknown = session?.header?.cwd
    const events: any[] = session?.snapshotEvents?.() ?? []
    // The latest message alone may be a short follow-up ("go ahead"), so keep the last few human messages.
    const texts: string[] = []
    for (const e of events) {
      if (e?.type !== 'user/message' || e.data?.source?.kind !== 'user') continue
      const text = (e.data.content as any[] | undefined)?.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
      if (text) texts.push(text)
    }
    const task = texts.length ? texts.slice(-3).join('\n---\n') : undefined
    if (typeof cwd !== 'string') return { task, project: undefined }
    return { task, project: cwd.split('/').filter(Boolean).pop(), ...(isAbsolute(cwd) ? { projectDir: cwd } : {}) }
  } catch {
    return {}
  }
}

/**
 * Plugin entry. Recipes hook in here on the shared Judge core; with every
 * Recipe disabled this registers nothing, so DSH behaves as if absent.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.recipes?.gate) return
  const jev = { ...JEV_DEFAULTS, ...config.jev }
  // DSH keeps keys in its credential store (env wins there, then ~/.dsh/.credentials.yaml), not in process.env.
  let warned = false
  const resolveKey = async () => {
    try {
      return (await (ctx as any).credentials.resolve(jev.apiKeyEnv))?.value as string | undefined
    } catch (e) {
      if (!warned) console.warn(`dsh-jev: credential store lookup for ${jev.apiKeyEnv} failed: ${e instanceof Error ? e.message : String(e)}`)
      warned = true
      return undefined
    }
  }
  const core = new JudgeCore({ judge: new JevJudge({ ...jev, resolveKey }), audit: new JsonlAuditSink() })
  registerGate(ctx as never, new Gate({ core, threshold: config.gate?.threshold, sendScripts: config.gate?.sendScripts, context: sessionContext }))
}
