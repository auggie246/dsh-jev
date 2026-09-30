import { describe, expect, it } from 'vitest'
import { isProtectedPath, prepareState, redactText } from '../src/egress.js'

const env = { HOME: '/home/u', MY_SECRET: 'hunter2hunter2', SHORT: 'abc', DB_PASSWORD: 'p@ss-w0rd-long' }

describe('redactText', () => {
  it('redacts env-var values (ignoring short/benign ones) and names the variable', () => {
    const out = redactText('login with hunter2hunter2 and p@ss-w0rd-long, abc stays', { env })
    expect(out).not.toContain('hunter2hunter2')
    expect(out).not.toContain('p@ss-w0rd-long')
    expect(out).toContain('[REDACTED:MY_SECRET]')
    expect(out).toContain('abc stays')
  })

  it.each([
    ['openai', 'key sk-proj-abcdefghijklmnopqrstuvwx1234'],
    ['github', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['github fine-grained', 'github_pat_11ABCDEFG0abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['aws', 'AKIAIOSFODNN7EXAMPLE'],
    ['slack', ['xoxb', '1234567890-abcdefghijklmnop'].join('-')],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuv'],
    ['bearer', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'],
    ['assignment', 'API_KEY="abcd1234efgh5678"'],
    ['pem', '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'],
  ])('redacts token-shaped %s', (_n, secret) => {
    const out = redactText(`before ${secret} after`, { env: {} })
    expect(out).toContain('[REDACTED')
    expect(out).toContain('before')
    expect(out).toContain('after')
    expect(out).not.toContain(secret.slice(-16))
  })

  it('leaves ordinary text alone', () => {
    const t = 'bun test src/foo.test.ts && git status'
    expect(redactText(t, { env: {} })).toBe(t)
  })
})

describe('isProtectedPath', () => {
  it.each(['.env', '/w/.env.local', '/w/app/.env.production', '~/.ssh/id_rsa', '/home/u/.aws/credentials', '.npmrc', '/home/u/.netrc', '/x/credentials.json', '/x/.git-credentials'])(
    'protects %s',
    (p) => expect(isProtectedPath(p)).toBe(true),
  )
  it.each(['/w/src/env.ts', '/w/README.md', '/w/docs/ssh-guide.md', '/w/.envrc.md'])('allows %s', (p) =>
    expect(isProtectedPath(p)).toBe(false),
  )
})

describe('prepareState', () => {
  it('keeps only named fields', () => {
    const out = prepareState({ command: 'ls', cwd: '/w', noise: 'x'.repeat(100) }, { fields: ['command', 'cwd'], env: {} })
    expect(out).toEqual({ command: 'ls', cwd: '/w' })
  })

  it('redacts secrets inside kept fields, including nested', () => {
    const out = prepareState({ command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"', meta: { k: 'hunter2hunter2' } }, { fields: ['command', 'meta'], env })
    expect(JSON.stringify(out)).not.toContain('abcdefghijklmnopqrstuvwxyz012345')
    expect(JSON.stringify(out)).not.toContain('hunter2hunter2')
  })

  it('drops content of protected-path entries but keeps the rest', () => {
    const out = prepareState(
      { files: [{ path: '/w/.env', content: 'SECRET=1' }, { path: '/w/a.ts', content: 'ok' }] },
      { fields: ['files'], env: {} },
    ) as any
    expect(JSON.stringify(out)).not.toContain('SECRET=1')
    expect(out.files[0]).toEqual({ omitted: 'protected path' })
    expect(out.files[1]).toEqual({ path: '/w/a.ts', content: 'ok' })
  })

  it('drops the whole state when its own path is protected', () => {
    const out = prepareState({ path: '/home/u/.ssh/id_rsa', content: 'PRIVATE' }, { fields: ['path', 'content'], env: {} })
    expect(JSON.stringify(out)).not.toContain('PRIVATE')
    expect(JSON.stringify(out)).not.toContain('id_rsa')
  })

  it('masks protected path mentions inside free text', () => {
    const out = prepareState({ command: 'cat ~/.aws/credentials && cat .env' }, { fields: ['command'], env: {} }) as any
    expect(out.command).not.toContain('.aws/credentials')
    expect(out.command).not.toMatch(/\.env(\s|$)/)
  })

  it('truncates oversized strings', () => {
    const out = prepareState({ diff: 'a'.repeat(5000) }, { fields: ['diff'], env: {}, maxChars: 100 }) as any
    expect(out.diff.length).toBeLessThan(200)
    expect(out.diff).toContain('[truncated')
  })

  it('accepts string state via redaction only', () => {
    expect(prepareState('token ghp_abcdefghijklmnopqrstuvwxyz0123456789', { env: {} })).toContain('[REDACTED')
  })
})

describe('review hardening', () => {
  it('leaves non-secret env values alone', () => {
    expect(redactText('mode is production here', { env: { NODE_ENV: 'production' } })).toBe('mode is production here')
  })
  it('protects paths case-insensitively and by any path-like key', () => {
    expect(isProtectedPath('/home/u/.ENV')).toBe(true)
    expect(prepareState({ notebook_path: '/p/.env', body: 'TOKEN=abc' }, { fields: ['notebook_path', 'body'] })).toEqual({ omitted: 'protected path' })
  })
})
