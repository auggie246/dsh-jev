# dsh-jev

A Jev decision layer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). DeepSeek still writes the code; Jev only answers small typed **Judgments** (Noul / Choice / Score). See `CONTEXT.md` and `docs/adr/`.

This package is the **Judge core** (issue #3): the `Judge` interface, a Jev backend, a fake Judge, the Egress rule (redaction, protected paths, state trimming), an audit log, and the Cordis plugin entry. Recipes (Gate, skill hint, verify, injection guard, effort routing) arrive in later tickets. With every Recipe disabled, the plugin registers nothing and DSH behaves as stock.

## Install

```sh
npm install && npm run build
dsh plugin --profile <name> add /path/to/dsh-jev
```

## Configure (`cordis.patch.yml`)

```yaml
- id: dsh-jev
  name: dsh-jev
  config:
    recipes:            # all off by default
      gate: false
      skillHint: false
      verify: false
      injectionGuard: false
      effortRouting: false
    jev:
      baseUrl: https://api.typesafe.ai/v1/systemone
      model: jev-latest
      apiKeyEnv: TYPESAFE_API_KEY   # name of the env var, never the key
      timeoutMs: 8000
```

OpenRouter Decisions instead: `baseUrl: https://openrouter.ai/api/alpha/decisions`, `model: typesafe/jev-1.13`, `apiKeyEnv: OPENROUTER_API_KEY`.

Audit records append to `$DSH_HOME/dsh-jev/audit.jsonl` (default `~/.dsh/dsh-jev/`).

## Develop

```sh
npm run typecheck
npm test        # no network
```
