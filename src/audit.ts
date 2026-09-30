import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One record per Judgment. */
export interface AuditRecord {
  ts: string
  recipe: string
  questionIds: string[]
  /** noul: number; choice/score: option/level -> probability. */
  probabilities: Record<string, number | Record<string, number>>
  /** What the Recipe did with the answer (or `unavailable:<reason>`). */
  decision: string
  latencyMs: number
  usage?: { inputTokens: number; outputTokens: number }
}

/** Swappable storage seam (ticket #2 may replace the JSONL file with DSH's session log). */
export interface AuditSink {
  write(record: AuditRecord): Promise<void>
}

export function auditDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return join(env.DSH_HOME || join(home, '.dsh'), 'dsh-jev')
}

export class JsonlAuditSink implements AuditSink {
  constructor(private readonly dir: string = auditDir()) {}

  /** Best-effort: audit failure must never affect a Judgment or DSH. */
  async write(record: AuditRecord): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true })
      await appendFile(join(this.dir, 'audit.jsonl'), `${JSON.stringify(record)}\n`)
    } catch {
      /* swallow */
    }
  }
}

export class MemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = []
  async write(record: AuditRecord): Promise<void> {
    this.records.push(record)
  }
}
