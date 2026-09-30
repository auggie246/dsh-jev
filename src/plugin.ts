import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { JEV_DEFAULTS } from './judge/jev.js'

export const name = 'dsh-jev'

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
}) as never

/**
 * Plugin entry. Recipes (#4-#9) hook in here on the shared Judge core; with
 * every Recipe disabled this registers nothing, so DSH behaves as if absent.
 */
export function apply(_ctx: Context, _config: Config): void {
  // Intentionally empty until a Recipe is enabled.
}
