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

const SSH_FAMILY = new Set(['rsync', 'scp', 'sftp', 'ssh'])
const RAW_SOCKETS = new Set(['nc', 'nc.openbsd', 'nc.traditional', 'ncat', 'netcat', 'socat', 'rclone'])
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const GIT_REMOTE_KEY = /^(remote\..+\.(url|pushurl)|url\..+\.(insteadof|pushinsteadof))/i
const GIT_CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'])

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

/** Unquoted words of each command in a line, split at every operator; `undefined` when the line cannot be parsed safely. */
export const commandSegments = (command: string): string[][] | undefined => parse(command)?.segments

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

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const USER_AT_HOST = /^[^\s/\\@:-][^\s/\\]*@[^\s/\\]/

/** `ssh://…`, `user@host[:path]`, `host:path` or `[v6]:path`; `C:\\x` and local paths are not remote. */
const isRemoteSpec = (a: string) =>
  URL_SCHEME.test(a) || USER_AT_HOST.test(a) || (/^[^\s/\\@:-][^\s/\\@:]*:/.test(a) && !/^[a-z]:[\\/]/i.test(a)) || /^\[[^\]]+\]:/.test(a)

/** A git push destination written as an address rather than a configured remote name. */
const isRepoAddress = (a: string) => URL_SCHEME.test(a) || USER_AT_HOST.test(a) || /^(\/|\.\.?\/|~)/.test(a)

const positionals = (args: string[]) => args.filter((a) => !a.startsWith('-'))

function checkGitRemotes(args: string[]): Risk {
  const has = (w: string) => args.includes(w)
  const push = args.indexOf('push')
  if (push >= 0) {
    const after = args.slice(push + 1)
    if (positionals(after).some(isRepoAddress) || after.some((a) => a.startsWith('--repo=') && isRepoAddress(a.slice('--repo='.length))))
      return risky('git push to an address, not a configured remote')
  }
  const remote = args.indexOf('remote')
  if (remote >= 0 && /^(add|set-url)$/.test(positionals(args.slice(remote + 1))[0] ?? '')) return risky('git remote points a name at a new address')
  if (args.some((a) => GIT_REMOTE_KEY.test(a) && a.includes('='))) return risky('git config redirects a remote')
  if (has('config') && !args.some((a) => GIT_CONFIG_READS.has(a)) && args.some((a) => GIT_REMOTE_KEY.test(a))) return risky('git config redirects a remote')
  return SAFE
}

function checkGh(args: string[]): Risk {
  const pos = positionals(args)
  // A leading flag such as `-R owner/repo` puts its value among the positionals, so look for the subcommand anywhere.
  const sub = (name: string) => {
    const at = pos.indexOf(name)
    return at < 0 ? undefined : pos[at + 1]
  }
  const gist = sub('gist')
  if (gist === 'create' || gist === 'edit') return risky('gh gist uploads data')
  if (pos.includes('api')) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!
      const method = a === '-X' || a === '--method' ? args[i + 1] : a.startsWith('--method=') ? a.slice('--method='.length) : /^-X./.test(a) ? a.slice(2) : undefined
      if (method !== undefined && method.toUpperCase() !== 'GET') return risky('gh api write')
      if (/^(-[fF].*|--(field|raw-field|input)(=.*)?)$/.test(a)) return risky('gh api write')
    }
  }
  const action = sub('issue') ?? sub('pr')
  if (/^(create|comment|edit)$/.test(action ?? '') && args.some((a) => /^(--body-file(=.*)?|-F.*)$/.test(a))) return risky('gh posts a file')
  return SAFE
}

function checkHttpServer(args: string[]): Risk {
  const m = args.findIndex((a) => /^-m(http\.server|SimpleHTTPServer)$/.test(a))
  const attached = m >= 0
  const at = attached ? m : args.indexOf('-m')
  if (!attached && !/^(http\.server|SimpleHTTPServer)$/.test(args[at + 1] ?? '')) return SAFE
  for (let i = at + 1; i < args.length; i++) {
    const a = args[i]!
    const bind = a === '--bind' || a === '-b' ? args[i + 1] : a.startsWith('--bind=') ? a.slice('--bind='.length) : /^-b./.test(a) ? a.slice(2) : undefined
    if (bind !== undefined && LOOPBACK.has(bind.toLowerCase())) return SAFE
  }
  return risky('directory-serving listener on all interfaces')
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
    const remotes = checkGitRemotes(args)
    if (remotes.risky) return remotes
    if (has('restore') || (has('stash') && (has('drop') || has('clear')))) return risky('discards changes')
  }
  if (SSH_FAMILY.has(cmd) && args.some((a) => !a.startsWith('-') && isRemoteSpec(a))) return risky('sends data to another host')
  if (RAW_SOCKETS.has(cmd)) return risky('raw socket or sync tool sends data to another host')
  if (/^python[\d.]*$/.test(cmd)) {
    const server = checkHttpServer(args)
    if (server.risky) return server
  }
  if (cmd === 'gh') {
    const gh = checkGh(args)
    if (gh.risky) return gh
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
