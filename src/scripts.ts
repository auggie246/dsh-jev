/**
 * Script bodies (CONTEXT.md): the text a package-manager command will actually run, read locally from the
 * project's package.json. They only add evidence for a Judge or force a prompt; they never approve anything.
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { assessCommand, commandSegments, type Risk } from './risk.js'

export type Scripts = Record<string, string>

/** The `scripts` of the nearest package.json at or above `dir` but not above `project`, and the directory it sits in. */
export type ScriptLoader = (dir: string, project: string) => Promise<{ root: string; scripts: Scripts } | undefined>

export interface ScriptBody {
  name: string
  body: string
  /** Directory of the package.json the script came from. */
  root: string
}

/** Where a command runs (`dir`) and the project directory nothing is read above. */
export interface ScriptScope {
  dir: string
  project: string
}

const MAX_PACKAGE_BYTES = 1_000_000
const MAX_BODIES = 32

const isAssignment = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)
const basename = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p
const ENV_WRAPPERS = new Set(['env', 'cross-env', 'time', 'nohup', 'command', 'exec'])
const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

/** Flags that set the package directory; their value is followed. */
const DIR_FLAGS = new Set(['--prefix', '-C', '--cwd', '--dir'])
/** Flags that run the script in other workspace packages, whose package.json is not read. */
const WORKSPACE_FLAGS = new Set(['-w', '--workspace', '--workspaces', '-ws', '-r', '--recursive', '--filter', '-F', '--filter-prod'])

/** Subcommands that are the manager's own, so `<manager> <word>` does not run a script of that name. */
const BUILTINS: Record<string, Set<string>> = {
  pnpm: new Set(['add', 'audit', 'bin', 'cat-file', 'cat-index', 'config', 'create', 'dedupe', 'deploy', 'dlx', 'doctor', 'env', 'exec', 'fetch', 'find-hash', 'i', 'import', 'init', 'install', 'install-test', 'it', 'licenses', 'link', 'list', 'ln', 'ls', 'outdated', 'pack', 'patch', 'patch-commit', 'patch-remove', 'prune', 'publish', 'rb', 'rebuild', 'recursive', 'remove', 'rm', 'root', 'self-update', 'server', 'setup', 'store', 'un', 'uninstall', 'unlink', 'up', 'update', 'why']),
  yarn: new Set(['add', 'audit', 'autoclean', 'bin', 'cache', 'check', 'config', 'constraints', 'create', 'dedupe', 'dlx', 'exec', 'explain', 'generate-lock-entry', 'global', 'help', 'import', 'info', 'init', 'install', 'licenses', 'link', 'list', 'login', 'logout', 'node', 'npm', 'outdated', 'owner', 'pack', 'patch', 'patch-commit', 'plugin', 'policies', 'publish', 'rebuild', 'remove', 'search', 'set', 'stage', 'tag', 'team', 'unlink', 'unplug', 'up', 'upgrade', 'upgrade-interactive', 'version', 'versions', 'why', 'workspace', 'workspaces']),
}
const RUN = new Set(['run', 'run-script', 'rum', 'urn'])
const INSTALL = new Set(['install', 'add', 'i', 'ci'])
/** The project's own lifecycle scripts an install runs, each run if present (dependency install scripts are out of scope). */
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare']
/** Option flags that take the next word as their value, so it is not mistaken for the subcommand or script. */
const VALUE_FLAGS = new Set(['--loglevel', '--registry', '--userconfig', '--globalconfig', '--cache', '--cache-folder', '--modules-folder', '--script-shell', '--shell', '--node-options', '--reporter', '--mutex', '--network-timeout', '--tag', '--otp', '--scope'])
const NPM_SHORTHAND: Record<string, string> = { test: 'test', t: 'test', tst: 'test', start: 'start', stop: 'stop', restart: 'restart' }

const inside = (dir: string, project: string) => {
  const rel = relative(project, dir)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * The scripts one command runs and the directory it runs them from; `undefined` when it is not a script run here.
 * `hooks`: whether each name brings its pre/post hooks (a named script) or is already the full list (an install).
 */
interface ScriptRun {
  dir: string
  names: string[]
  hooks: boolean
}

function scriptRun(words: string[], dir: string): ScriptRun | undefined {
  let w = words.slice()
  while (w.length && (isAssignment(w[0]!) || ENV_WRAPPERS.has(basename(w[0]!).toLowerCase()))) {
    w.shift()
    while (w.length && (isAssignment(w[0]!) || w[0]!.startsWith('-'))) w.shift()
  }
  if (!w.length) return undefined
  const manager = basename(w[0]!).toLowerCase().replace(/\.(cmd|exe)$/, '')
  if (!MANAGERS.has(manager)) return undefined
  const args = w.slice(1)
  const end = args.indexOf('--')
  const head = end < 0 ? args : args.slice(0, end)
  const positional: string[] = []
  for (let i = 0; i < head.length; i++) {
    const a = head[i]!
    const flag = a.split('=')[0]!
    if (WORKSPACE_FLAGS.has(flag)) return undefined
    if (DIR_FLAGS.has(flag)) {
      const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : head[++i]
      if (value === undefined || /[$~*?`]/.test(value)) return undefined
      dir = resolve(dir, value)
    } else if (VALUE_FLAGS.has(a)) i++
    else if (!a.startsWith('-')) positional.push(a)
  }
  const [sub, next] = positional
  const run = (name: string): ScriptRun => ({ dir, names: [name], hooks: true })
  const install = (): ScriptRun | undefined => (head.includes('--ignore-scripts') ? undefined : { dir, names: LIFECYCLE, hooks: false })
  if (sub === undefined) return manager === 'yarn' ? install() : undefined // bare `yarn` installs
  if (INSTALL.has(sub)) return install()
  if (RUN.has(sub)) return next === undefined ? undefined : run(next)
  if (manager === 'npm') return Object.hasOwn(NPM_SHORTHAND, sub) ? run(NPM_SHORTHAND[sub]!) : undefined
  if (manager === 'bun') return undefined
  if (manager === 'pnpm' && (sub === 't' || sub === 'tst')) return run('test')
  return BUILTINS[manager]!.has(sub) ? undefined : run(sub)
}

/** Script runs in a command line; literal `cd`s are followed, anything else loses the directory. */
function scriptRuns(command: string, scope: ScriptScope): ScriptRun[] {
  const segments = commandSegments(command)
  if (!segments) return []
  const runs: ScriptRun[] = []
  let dir: string | undefined = scope.dir
  for (const words of segments) {
    if (words[0] === 'cd' || words[0] === 'pushd') {
      const target = words.slice(1).find((a) => !a.startsWith('-'))
      dir = dir !== undefined && target !== undefined && !/[$~*?`]/.test(target) ? resolve(dir, target) : undefined
      continue
    }
    const run = dir === undefined ? undefined : scriptRun(words, dir)
    if (run && inside(run.dir, scope.project)) runs.push(run)
  }
  return runs
}

/**
 * Script bodies a command runs: each named script with its pre/post hooks, then one level of scripts those
 * bodies run (with their hooks). Deeper scripts are not read. Empty when nothing can be resolved.
 */
export async function scriptBodies(command: string, scope: ScriptScope, load: ScriptLoader = readPackageScripts): Promise<ScriptBody[]> {
  const packages = new Map<string, ReturnType<ScriptLoader>>()
  const loadOnce = (dir: string) => {
    if (!packages.has(dir)) packages.set(dir, load(dir, scope.project).catch(() => undefined))
    return packages.get(dir)!
  }
  const out: ScriptBody[] = []
  const seen = new Set<string>()
  const collect = async (line: string, dir: string) => {
    for (const run of scriptRuns(line, { dir, project: scope.project })) {
      const pkg = await loadOnce(run.dir)
      if (!pkg) continue
      for (const base of run.names) {
        if (run.hooks && !Object.hasOwn(pkg.scripts, base)) continue
        for (const name of run.hooks ? [`pre${base}`, base, `post${base}`] : [base]) {
          const key = `${pkg.root}\0${name}`
          if (!Object.hasOwn(pkg.scripts, name) || seen.has(key) || out.length >= MAX_BODIES) continue
          seen.add(key)
          out.push({ name, body: pkg.scripts[name]!, root: pkg.root })
        }
      }
    }
  }
  await collect(command, scope.dir)
  // Scripts run from their package's root.
  for (const top of out.slice()) await collect(top.body, top.root)
  return out
}

/** The `scripts` of the nearest package.json at or above `dir`, as npm finds it, never looking above `project`. */
export const readPackageScripts: ScriptLoader = async (dir, project) => {
  const top = resolve(project)
  for (let d = resolve(dir); inside(d, top); d = dirname(d)) {
    const file = join(d, 'package.json')
    const info = await stat(file).catch(() => undefined)
    if (info?.isFile()) {
      if (info.size > MAX_PACKAGE_BYTES) return undefined
      try {
        const scripts: unknown = JSON.parse(await readFile(file, 'utf8'))?.scripts
        const entries = typeof scripts === 'object' && scripts !== null ? Object.entries(scripts) : []
        return { root: d, scripts: Object.fromEntries(entries.filter((e): e is [string, string] => typeof e[1] === 'string')) }
      } catch {
        return undefined
      }
    }
    if (d === top || dirname(d) === d) return undefined
  }
  return undefined
}

/** The static risk list over every Script body; the first hit names its script. */
export function assessScripts(bodies: ScriptBody[]): Risk {
  for (const b of bodies) {
    const r = assessCommand(b.body)
    if (r.risky) return { risky: true, reason: `script ${b.name}: ${r.reason ?? 'risky'}` }
  }
  return { risky: false }
}

/** The `scripts` field a Judge sees: name to body, prefixed with the package directory when a name repeats. */
export function scriptsField(bodies: ScriptBody[], project: string): Scripts {
  const field: Scripts = {}
  for (const b of bodies) {
    const key = Object.hasOwn(field, b.name) ? `${relative(project, b.root) || '.'}:${b.name}` : b.name
    field[key] = b.body
  }
  return field
}
