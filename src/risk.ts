/** Static risk list (CONTEXT.md): deterministic patterns that always run before any Judgment. */
import { isProtectedPath } from './egress.js'

export interface Risk {
  risky: boolean
  reason?: string
}

const SAFE: Risk = { risky: false }
const risky = (reason: string): Risk => ({ risky: true, reason })

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'ash', 'pwsh', 'powershell', 'cmd', 'nu'])
const PRIVILEGE = new Set(['sudo', 'doas', 'su', 'pkexec', 'runas'])
const INTERPRETERS = new Set(['python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'osascript'])
const IN_STRING_FLAGS = new Set(['-c', '-e', '-r', '-p', '--eval', '--command', '--print', '-command', '-encodedcommand', '-ec'])
const WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'ionice', 'time', 'timeout', 'stdbuf', 'setsid', 'xargs', 'watch', 'chronic'])
const DESTRUCTIVE = new Set(['shred', 'mkfs', 'wipefs', 'fdisk', 'parted', 'eval', 'source', '.', 'iex', 'invoke-expression'])
const PUBLISHERS: Record<string, RegExp> = {
  npm: /^(publish|unpublish|deprecate|dist-tag|access|owner|login|adduser)$/,
  pnpm: /^(publish|unpublish|deprecate|login)$/,
  yarn: /^(publish|npm)$/,
  bun: /^(publish)$/,
  cargo: /^(publish|yank|login|owner)$/,
  twine: /^upload$/,
  docker: /^(push|login)$/,
  podman: /^(push|login)$/,
  gh: /^(release|repo|secret|auth)$/,
  vercel: /.*/,
  netlify: /^deploy$/,
  fly: /^(deploy|launch)$/,
  flyctl: /^(deploy|launch)$/,
  wrangler: /^(deploy|publish)$/,
  heroku: /.*/,
  terraform: /^(apply|destroy)$/,
  kubectl: /^(apply|delete|replace|rollout|scale)$/,
  helm: /^(install|upgrade|uninstall|rollback)$/,
  gcloud: /.*/,
  aws: /.*/,
  az: /.*/,
  firebase: /^deploy$/,
  serverless: /^deploy$/,
  sls: /^deploy$/,
}

const OPERATORS = ['&&', '||', ';;', '|&', ';', '|', '&', '\n']

interface Parsed {
  segments: string[][]
}

/** Split into segments at every operator, unquoting words. `undefined` means we refuse to guess. */
function parse(input: string): Parsed | undefined {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endSegment = () => {
    endWord()
    if (words.length) segments.push(words)
    words = []
  }
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    if (c === "'") {
      const j = input.indexOf("'", i + 1)
      if (j < 0) return undefined
      word += input.slice(i + 1, j)
      inWord = true
      i = j
    } else if (c === '"') {
      inWord = true
      i++
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) i++
        else if (input[i] === '$' && input[i + 1] === '(') return undefined
        else if (input[i] === '`') return undefined
        word += input[i]
        i++
      }
      if (i >= input.length) return undefined
    } else if (c === '\\') {
      if (i + 1 >= input.length) return undefined
      if (input[i + 1] === '\n') {
        i++
        continue
      }
      word += input[i + 1]
      inWord = true
      i++
    } else if (c === '`' || (c === '$' && input[i + 1] === '(') || ((c === '<' || c === '>') && input[i + 1] === '(')) {
      return undefined
    } else if (c === '<' && input[i + 1] === '<') {
      return undefined // heredoc / here-string bodies are not parsed
    } else if (c === '(' || c === ')' || c === '{' || c === '}') {
      if (inWord) {
        word += c
        continue
      }
      return undefined // subshells and groups
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
    } else {
      const op = OPERATORS.find((o) => input.startsWith(o, i))
      if (op) {
        endSegment()
        i += op.length - 1
      } else {
        word += c
        inWord = true
      }
    }
  }
  endSegment()
  return { segments }
}

const basename = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p
const isAssignment = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)

function longFlags(args: string[]): Set<string> {
  const out = new Set<string>()
  for (const a of args) {
    if (a === '--') break
    if (a.startsWith('--')) out.add(a.split('=')[0]!.toLowerCase())
    else if (a.startsWith('-') && a.length > 1) for (const ch of a.slice(1)) out.add(`-${ch}`)
  }
  return out
}

function checkSegment(words: string[], pwsh: boolean): Risk {
  let w = words.slice()
  // Strip assignments, wrappers (and their flags/values) and path prefixes until the real command.
  for (let guard = 0; guard < 16; guard++) {
    while (w.length && isAssignment(w[0]!)) w.shift()
    if (!w.length) return SAFE
    const cmd = basename(w[0]!).toLowerCase()
    if (WRAPPERS.has(cmd)) {
      // A wrapper's flags may take values we cannot tell apart from the command, so
      // inspect every remaining suffix as if it were the command.
      const rest = w.slice(1)
      for (let i = 0; i < rest.length; i++) {
        const r = checkSegment(rest.slice(i), pwsh)
        if (r.risky) return r
      }
      return SAFE
    }
    break
  }
  if (!w.length) return SAFE
  const raw = w[0]!
  if (/[$*?[~]/.test(raw)) return risky('command word cannot be resolved statically')
  const cmd = basename(raw).toLowerCase().replace(/\.exe$/, '')
  const args = w.slice(1)
  const flags = longFlags(args.map((a) => (pwsh ? a.toLowerCase() : a)))
  const sub = args.find((a) => !a.startsWith('-'))?.toLowerCase()

  if (PRIVILEGE.has(cmd)) return risky('privilege escalation')
  if (SHELLS.has(cmd)) return risky('shell interpreter')
  if (DESTRUCTIVE.has(cmd)) return risky(`${cmd} is destructive or executes arbitrary text`)
  if (INTERPRETERS.has(cmd) && (args.some((a) => IN_STRING_FLAGS.has(a.toLowerCase())) || (cmd === 'deno' && sub === 'eval')))
    return risky('in-string code execution')
  if (cmd === 'rm' || cmd === 'rmdir' || cmd === 'remove-item' || cmd === 'del' || cmd === 'ri' || cmd === 'rd') {
    if (flags.has('-r') || flags.has('-R') || flags.has('--recursive') || flags.has('-recurse') || cmd === 'rmdir' && flags.has('-p'))
      return risky('recursive delete')
  }
  if (cmd === 'find' && (flags.has('-delete') || args.includes('-delete') || args.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a)))) return risky('find with delete/exec')
  if (cmd === 'git') {
    // Global options (`-C dir`, `-c k=v`) precede the subcommand, so look for subcommand words anywhere.
    const has = (w: string) => args.includes(w)
    const gf = longFlags(args)
    if (has('push') && (gf.has('--force') || gf.has('--force-with-lease') || gf.has('--force-if-includes') || gf.has('-f') || gf.has('--mirror') || gf.has('--delete') || args.some((a) => /^[+:]/.test(a))))
      return risky('force push')
    if (has('reset') && gf.has('--hard')) return risky('hard reset')
    if (has('clean')) return risky('git clean')
    if (has('checkout') && (gf.has('-f') || gf.has('--force'))) return risky('forced checkout')
    if (has('branch') && (gf.has('-D') || gf.has('--force'))) return risky('branch force delete')
    if (has('restore') || (has('stash') && (has('drop') || has('clear')))) return risky('discards changes')
  }
  const pub = PUBLISHERS[cmd]
  if (pub && (sub === undefined ? cmd === 'vercel' || cmd === 'heroku' : pub.test(sub))) return risky('publish or deploy')
  if ((cmd === 'curl' || cmd === 'wget') && args.some((a) => /^(-X|--request|-d|--data|--json|--upload-file|-T|-F|--form|--post-|--method)/i.test(a)))
    return risky('network write')
  return SAFE
}

/** Risk of one shell command line (bash or pwsh). */
export function assessCommand(command: string, shell: 'bash' | 'pwsh' = 'bash'): Risk {
  if (typeof command !== 'string') return risky('command is not a string')
  const parsed = parse(command)
  if (!parsed) return risky('command cannot be parsed')
  for (const seg of parsed.segments) {
    for (const word of seg) {
      const value = word.includes('=') ? word.slice(word.indexOf('=') + 1) : word
      if (isProtectedPath(word) || isProtectedPath(value) || /(^|[\\/])\.(ssh|aws)([\\/]|$)/.test(word) || /(\.env(\.\w+)?|\.npmrc|\.netrc|\.git-credentials)$/.test(word))
        return risky('credential file')
    }
    const r = checkSegment(seg, shell === 'pwsh')
    if (r.risky) return r
  }
  return SAFE
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'filename', 'target', 'old_path', 'new_path', 'destination']

/** Risk of a covered tool call. Unknown argument shapes are risky (refuse what cannot be understood). */
export function assessCall(name: string, args: unknown): Risk {
  if (typeof args !== 'object' || args === null) return risky('arguments are not an object')
  const a = args as Record<string, unknown>
  for (const k of PATH_KEYS) {
    const v = a[k]
    if (typeof v === 'string' && (isProtectedPath(v) || /(^|[\\/])\.(ssh|aws)([\\/]|$)/.test(v))) return risky('protected path')
    if (v !== undefined && typeof v !== 'string') return risky('path is not a string')
  }
  if (name === 'bash' || name === 'pwsh') {
    if (typeof a.command !== 'string') return risky('missing command')
    return assessCommand(a.command, name)
  }
  return SAFE
}
