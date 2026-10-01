/** Gate Recipe (ADR 0003, 0005): approves sandbox escalations a Judge is confident about; never denies. */
import type { JudgeCore } from './core.js'
import { redactText } from './egress.js'
import { assessCall } from './risk.js'

export const GATED_TOOLS = new Set(['bash', 'pwsh', 'write', 'edit', 'str_replace_editor'])
export const DEFAULT_THRESHOLD = 0.9

/** Structural subset of DSH's `ToolExecution` the Gate reads. */
export interface GateExec {
  name: string
  arguments: unknown
  callId: string
  parent?: unknown
  agent?: unknown
}

/** Structural subset of DSH's `ApprovalRequestEvent`. */
export interface GateApprovalRequest {
  toolName: string
  callId?: string
}

export type GateOutcome = 'allowed-once'

/**
 * One narrow proposition per Noul (TypeSafe guidance); each is phrased so yes is the safe answer, and
 * code approves only when every one reaches the threshold. Question ids are for code, not sent to Jev.
 */
const QUESTIONS = {
  keepsData: { type: 'noul', instructions: 'Is everything in `commands` free of deleting or overwriting data that could not be recovered afterwards?' },
  leavesOutsideAlone: { type: 'noul', instructions: 'Is `commands` free of creating, changing or removing files outside the `project` directory, such as in the home directory, system paths or other projects?' },
  nothingShipped: { type: 'noul', instructions: 'Is `commands` free of publishing, deploying, or sending project data to an outside service?' },
  servesTask: { type: 'noul', instructions: 'Is `commands` something the `task` asks for or plainly needs?' },
  justified: { type: 'noul', instructions: 'Is `justification` a plausible reason for `commands` to need wider access than the sandbox gives?' },
} as const

/** Stated rule Jev judges against, rather than guessing what the Gate treats as routine. */
const POLICY =
  'Routine development work is expected and acceptable: running tests, type-checking, building, linting, formatting, and read-only inspection of the project. Only actions that destroy data, change things outside the project, or publish and send data elsewhere are concerning.'

const MAX_STASH = 256

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Text a Judge sees for a call (redaction and trimming happen in the Judge core). */
function describe(name: string, args: Record<string, unknown>): string {
  if (name === 'bash' || name === 'pwsh') return String(args.command)
  const path = ['path', 'file_path', 'filePath'].map((k) => args[k]).find((v) => typeof v === 'string')
  const body = ['content', 'new_str', 'file_text', 'new_string', 'text'].map((k) => args[k]).find((v) => typeof v === 'string')
  const cmd = typeof args.command === 'string' ? `${args.command} ` : ''
  return `${name} ${cmd}${path ?? ''}${body ? `\n${body}` : ''}`
}

/** Short redacted preview for the local audit line. */
const preview = (name: string, args: Record<string, unknown>) => redactText(describe(name, args)).slice(0, 160)

export interface GateOptions {
  core: JudgeCore
  threshold?: number
  /** Latest user task and project for the call; best effort, empty when unknown. */
  context?: (exec: GateExec) => { task?: string; project?: string }
}

export class Gate {
  private readonly stash = new Map<string, string>()
  private readonly threshold: number

  constructor(private readonly opts: GateOptions) {
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD
  }

  /** `tools/pre-execute` body: judge and stash. Never throws and never decides the call itself. */
  async consider(exec: GateExec): Promise<void> {
    try {
      if (!GATED_TOOLS.has(exec.name)) return
      const args = exec.arguments
      // Only sandbox escalations prompt in stock DSH (spike #2); everything else is out of scope.
      if (!isObj(args) || args.sandbox_permissions === undefined) return
      const risk = assessCall(exec.name, args)
      if (risk.risky) {
        // Short-circuit to the normal prompt; recorded (with a short redacted preview) so skipped escalations stay visible.
        await this.opts.core.note({ recipe: 'gate', decision: `risk-list:${risk.reason ?? 'risky'}`, meta: { tool: exec.name, parent: exec.parent !== undefined, preview: preview(exec.name, args) } })
        return
      }
      const ctx = this.opts.context?.(exec) ?? {}
      const { result } = await this.opts.core.ask({
        recipe: 'gate',
        state: { policy: POLICY, commands: describe(exec.name, args), justification: typeof args.justification === 'string' ? args.justification : '', project: ctx.project ?? '', task: ctx.task ?? '' },
        fields: ['policy', 'commands', 'justification', 'project', 'task'],
        questions: QUESTIONS,
        meta: { tool: exec.name, taskChars: ctx.task?.length ?? 0, hasProject: Boolean(ctx.project), commandChars: describe(exec.name, args).length, preview: preview(exec.name, args) },
        decide: (r) => (r.status === 'ok' && this.confident(r.answers) ? 'auto-approve' : 'fall-through'),
      })
      if (result.status === 'ok' && this.confident(result.answers)) {
        this.stash.set(exec.callId, exec.name)
        if (this.stash.size > MAX_STASH) this.stash.delete(this.stash.keys().next().value as string)
      }
    } catch {
      /* fall through */
    }
  }

  /** `approval/request` body: `'allowed-once'` only for a confident verdict on this exact call, once. */
  answer(req: GateApprovalRequest): GateOutcome | undefined {
    if (req.callId === undefined) return undefined
    const name = this.stash.get(req.callId)
    if (name === undefined || name !== req.toolName) return undefined
    this.stash.delete(req.callId)
    return 'allowed-once'
  }

  private confident(answers: Record<string, { noul: number }>): boolean {
    const all = Object.values(answers)
    return all.length === Object.keys(QUESTIONS).length && all.every((a) => a.noul >= this.threshold)
  }
}

interface GateContext {
  on(event: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean }): unknown
}

/** Register the two prepended listeners of ADR 0005. The Gate never returns deny. */
export function registerGate(ctx: GateContext, gate: Gate): void {
  ctx.on(
    'tools/pre-execute',
    async (exec: GateExec, next: () => Promise<unknown>) => {
      if (exec.parent === undefined && exec.name === 'run_code') return next()
      await gate.consider(exec)
      return next()
    },
    { prepend: true },
  )
  ctx.on(
    'approval/request',
    (req: GateApprovalRequest, next: () => Promise<unknown>) => gate.answer(req) ?? next(),
    { prepend: true },
  )
}
