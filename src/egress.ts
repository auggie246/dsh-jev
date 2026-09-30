/** Egress rule: redact secrets, never send protected paths, trim state to named fields. */

export interface EgressOptions {
  /** Env to scan for secret values; defaults to process.env. */
  env?: Record<string, string | undefined>
  /** Top-level state fields to keep. Omit only for string state. */
  fields?: string[]
  /** Per-string cap; longer strings are truncated. Default 4000. */
  maxChars?: number
}

const MIN_ENV_SECRET_LEN = 8
/** Only env vars that look like secrets are value-redacted; paths and modes are left alone. */
const SECRET_ENV_NAME = /KEY|SECRET|TOKEN|PASSW|CREDENTIAL|AUTH|PRIVATE/i
const DEFAULT_MAX_CHARS = 4000

const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  // KEY=value style assignments for secret-looking names
  /\b[A-Za-z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Za-z0-9_]*\s*[=:]\s*["']?[^\s"']{8,}["']?/gi,
]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function redactText(text: string, opts: Pick<EgressOptions, 'env'> = {}): string {
  let out = text
  const env = opts.env ?? process.env
  // Longest values first so overlapping secrets redact fully.
  const entries = Object.entries(env)
    .filter(
      (e): e is [string, string] =>
        typeof e[1] === 'string' && e[1].length >= MIN_ENV_SECRET_LEN && SECRET_ENV_NAME.test(e[0]),
    )
    .sort((a, b) => b[1].length - a[1].length)
  for (const [name, value] of entries) out = out.replace(new RegExp(escapeRe(value), 'g'), `[REDACTED:${name}]`)
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '[REDACTED]')
  return out
}

/** Path segments/basenames that are never sent. */
const PROTECTED_SEGMENT = /(^|[\\/])\.(ssh|aws)([\\/]|$)/i
const PROTECTED_BASENAME = /(^|[\\/])(\.env(\.[^\\/]+)?|\.npmrc|\.netrc|\.git-credentials|credentials(\.[^\\/]+)?)$/i

export function isProtectedPath(p: string): boolean {
  return PROTECTED_SEGMENT.test(p) || PROTECTED_BASENAME.test(p)
}

/** Mentions inside free text (commands, prose). */
const PROTECTED_MENTION = /(?:[\w~.\\/-]*[\\/])?\.(?:ssh|aws)(?:[\\/][\w.\\/-]*)?|(?:[\w~.\\/-]*[\\/])?(?:\.env(?:\.[\w-]+)?|\.npmrc|\.netrc|\.git-credentials|credentials(?:\.[\w-]+)?)(?![\w.-])/gi

function maskPaths(s: string): string {
  return s.replace(PROTECTED_MENTION, (m) => (isProtectedPath(m) ? '[protected-path]' : m))
}

/** Any key that names a path or file. */
const isPathKey = (k: string) => /path|file|dir|uri|url/i.test(k)
const hasProtectedPath = (o: Record<string, unknown>) =>
  Object.entries(o).some(([k, v]) => isPathKey(k) && typeof v === 'string' && isProtectedPath(v))

function clean(value: unknown, env: EgressOptions['env'], max: number): unknown {
  if (typeof value === 'string') {
    let s = maskPaths(redactText(value, { env }))
    if (s.length > max) s = `${s.slice(0, max)}…[truncated ${s.length - max} chars]`
    return s
  }
  if (Array.isArray(value)) return value.map((v) => clean(v, env, max))
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>
    if (hasProtectedPath(obj)) {
      return { omitted: 'protected path' }
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, clean(v, env, max)]))
  }
  return value
}

/** Produce the only state a Judgment may carry off the machine. */
export function prepareState(state: string | Record<string, unknown>, opts: EgressOptions = {}): string | Record<string, unknown> {
  const max = opts.maxChars ?? DEFAULT_MAX_CHARS
  if (typeof state === 'string') return clean(state, opts.env, max) as string
  if (!opts.fields) throw new TypeError('prepareState: object state requires named fields (Egress rule)')
  const top = state as Record<string, unknown>
  // A top-level protected path drops its sibling content fields too.
  const protectedTop = hasProtectedPath(top)
  const out: Record<string, unknown> = {}
  for (const field of opts.fields) {
    if (!(field in top)) continue
    if (protectedTop) continue
    out[field] = clean(top[field], opts.env, max)
  }
  if (protectedTop) return { omitted: 'protected path' }
  return out
}
