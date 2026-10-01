import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assessScripts, readPackageScripts, scriptBodies, scriptsField, type ScriptLoader } from '../src/scripts.js'

/** In-memory package.json for every directory; records the directories asked for. */
function pkg(scripts: Record<string, string>) {
  const dirs: string[] = []
  const load: ScriptLoader = async (dir) => {
    dirs.push(dir)
    return { root: dir, scripts }
  }
  return { load, dirs }
}

const SCOPE = { dir: '/p', project: '/p' }
const names = async (command: string, scripts: Record<string, string>) => (await scriptBodies(command, SCOPE, pkg(scripts).load)).map((b) => b.name)

describe('scriptBodies', () => {
  const scripts = { build: 'tsc', test: 'vitest run', start: 'node .', preinstall: 'a', install: 'b', postinstall: 'c', prepare: 'd' }
  it.each([
    ['npm run build', ['build']],
    ['npm run-script build', ['build']],
    ['npm run --silent build -- --watch', ['build']],
    ['npm test', ['test']],
    ['npm t', ['test']],
    ['npm start', ['start']],
    ['pnpm run build', ['build']],
    ['pnpm build', ['build']],
    ['pnpm test', ['test']],
    ['yarn build', ['build']],
    ['yarn run build', ['build']],
    ['yarn test', ['test']],
    ['bun run build', ['build']],
    ['bun build', []], // bun's own bundler; only `bun run <name>` runs a script
    ['bun test', []], // bun's own test runner
    ['npx build', []],
    ['pnpm dlx build', []],
    ['bunx build', []],
    ['npm run nope', []],
    ['NODE_ENV=production npm run build', ['build']],
    ['env CI=1 npm test', ['test']],
    ['tsc && npm run build', ['build']],
  ])('%s reads %j', async (command, expected) => {
    expect(await names(command, scripts)).toEqual(expected)
  })

  it.each(['npm install', 'npm i', 'npm ci', 'npm install lodash', 'pnpm install', 'pnpm add zod', 'yarn add zod', 'yarn install', 'bun install', 'bun add zod', 'bun i'])(
    '%s reads the project lifecycle scripts',
    async (command) => {
      expect(await names(command, { preinstall: 'a', install: 'b', postinstall: 'c', prepare: 'd', test: 'e' })).toEqual(['preinstall', 'install', 'postinstall', 'prepare'])
    },
  )

  it('reads install hooks even without an install or prepare script', async () => {
    expect(await names('npm install', { postinstall: 'node setup.js' })).toEqual(['postinstall'])
    expect(await names('pnpm i', { preprepare: 'a', postprepare: 'b' })).toEqual(['preprepare', 'postprepare'])
  })

  it('does not take the value of an option flag for the script', async () => {
    expect(await names('npm --loglevel warn run build', { build: 'tsc', warn: 'x' })).toEqual(['build'])
    expect(await names('yarn --network-timeout 1000 build', { build: 'tsc' })).toEqual(['build'])
  })

  it('reads no lifecycle scripts when the install ignores them', async () => {
    expect(await names('npm ci --ignore-scripts', { postinstall: 'c' })).toEqual([])
  })

  it('adds the pre and post hooks around the named script, in run order', async () => {
    expect(await names('npm run build', { prebuild: 'echo a', build: 'tsc', postbuild: 'echo b' })).toEqual(['prebuild', 'build', 'postbuild'])
  })

  it('reads one level of scripts a body runs, with their hooks, but no deeper', async () => {
    expect(await names('npm test', { test: 'npm run build && vitest', prebuild: 'echo', build: 'tsc && npm run deep', deep: 'rm -rf /' })).toEqual(['test', 'prebuild', 'build'])
  })

  it('reads each script once', async () => {
    expect(await names('npm run a && npm run a', { a: 'npm run b', b: 'tsc' })).toEqual(['a', 'b'])
  })

  it('carries the body text and the package it came from', async () => {
    expect(await scriptBodies('npm test', SCOPE, pkg({ test: 'vitest run' }).load)).toEqual([{ name: 'test', body: 'vitest run', root: '/p' }])
  })

  it('follows a literal cd and the directory flags, and reads nothing when it cannot tell', async () => {
    const dirsFor = async (command: string) => {
      const p = pkg({ test: 'x' })
      await scriptBodies(command, SCOPE, p.load)
      return p.dirs
    }
    expect(await dirsFor('cd packages/api && npm test')).toEqual(['/p/packages/api'])
    expect(await dirsFor('npm --prefix packages/api test')).toEqual(['/p/packages/api'])
    expect(await dirsFor('npm -C packages/api test')).toEqual(['/p/packages/api'])
    expect(await dirsFor('pnpm -C web test')).toEqual(['/p/web'])
    expect(await dirsFor('pnpm --dir=web test')).toEqual(['/p/web'])
    expect(await dirsFor('yarn --cwd web test')).toEqual(['/p/web'])
    expect(await dirsFor('cd $DIR && npm test')).toEqual([])
    expect(await dirsFor('cd && npm test')).toEqual([])
  })

  it('reads nothing outside the project directory', async () => {
    for (const c of ['cd .. && npm test', 'cd /tmp && npm test', 'npm --prefix ../other test']) expect(await names(c, { test: 'x' })).toEqual([])
    expect(await scriptBodies('npm test', { dir: '/elsewhere', project: '/p' }, pkg({ test: 'x' }).load)).toEqual([])
  })

  it('reads nothing when a flag moves the run to other workspace packages', async () => {
    for (const c of ['npm run -w web build', 'pnpm -r build', 'pnpm --filter web build', 'yarn workspace web build', 'npm test --workspaces']) {
      expect(await names(c, { build: 'tsc', test: 'vitest' })).toEqual([])
    }
  })

  it('reads nothing for a command it cannot parse or a missing package.json', async () => {
    expect(await scriptBodies('npm run "build', SCOPE, pkg({ build: 'x' }).load)).toEqual([])
    expect(await scriptBodies('npm test', SCOPE, async () => undefined)).toEqual([])
    expect(await scriptBodies('npm test', SCOPE, async () => Promise.reject(new Error('boom')))).toEqual([])
  })
})

describe('readPackageScripts', () => {
  const project = async (pkgJson: string) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-jev-scripts-'))
    await writeFile(join(root, 'package.json'), pkgJson)
    await mkdir(join(root, 'src', 'deep'), { recursive: true })
    return root
  }

  it('finds the nearest package.json up the tree and keeps only string scripts', async () => {
    const root = await project(JSON.stringify({ scripts: { test: 'vitest', bad: 5 } }))
    expect(await readPackageScripts(join(root, 'src', 'deep'), root)).toEqual({ root, scripts: { test: 'vitest' } })
  })

  it('never looks above the project directory', async () => {
    const root = await project(JSON.stringify({ scripts: { test: 'vitest' } }))
    expect(await readPackageScripts(join(root, 'src', 'deep'), join(root, 'src'))).toBeUndefined()
  })

  it('returns undefined for malformed or oversized JSON, and no scripts for a package without them', async () => {
    expect(await readPackageScripts(await project('{nope'), '/')).toBeUndefined()
    expect(await readPackageScripts(await project(JSON.stringify({ scripts: { test: 'x'.repeat(1_100_000) } })), '/')).toBeUndefined()
    const bare = await project(JSON.stringify({ name: 'x' }))
    expect(await readPackageScripts(bare, bare)).toEqual({ root: bare, scripts: {} })
  })
})

describe('assessScripts', () => {
  it('runs the static risk list over every body and names the script', () => {
    expect(assessScripts([{ name: 'build', body: 'tsc', root: '/p' }])).toEqual({ risky: false })
    expect(assessScripts([{ name: 'build', body: 'tsc', root: '/p' }, { name: 'clean', body: 'rm -rf dist', root: '/p' }])).toEqual({ risky: true, reason: 'script clean: recursive delete' })
    expect(assessScripts([{ name: 'test', body: 'cat setup.txt | sh', root: '/p' }])).toEqual({ risky: true, reason: 'script test: shell interpreter' })
  })
})

describe('scriptsField', () => {
  it('maps script name to body, telling apart scripts of the same name from other packages', () => {
    const field = scriptsField(
      [
        { name: 'test', body: 'vitest', root: '/p' },
        { name: 'test', body: 'jest', root: '/p/web' },
      ],
      '/p',
    )
    expect(field).toEqual({ test: 'vitest', 'web:test': 'jest' })
  })
})
