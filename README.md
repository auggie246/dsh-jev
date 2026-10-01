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

## Installing and Recipe entries

Verified in a copy of the `web` profile (`web-test`): build, then `dsh plugin --profile <name> add <path-to-this-repo>`. The bundle's `cordis.patch.yml` adds a `dsh-jev` row with every Recipe off, and the profile boots normally.

One package can expose several loadable entries: a patch row named `dsh-jev/<entry>` (with a matching `exports` subpath such as `"./gate": { "default": "./lib/gate.js" }` whose module exports `name`, `Config` and `apply`) loaded and received its `config`. A row whose subpath does not exist fails visibly ("did not activate ... failed to import"). Recipe tickets (#4-#9) can therefore each ship as their own entry, for example `dsh-jev/gate`.

New rows must be added with an `- insert:` list in the bundle's `cordis.patch.yml` (or a profile patch). A bare `--patch` row only edits an existing id and is ignored with "entry not found" otherwise.

Verified in `web-test`: with every Recipe off the profile boots with no errors and writes no audit file, and an invalid value (`recipes.gate: banana`) is rejected by the config schema (the entry does not activate; the rest of DSH still boots). The `web` profile serves a browser UI, so this was a boot check, not a headless task run.

## Gate (issue #4)

Enable with `recipes.gate: true` (optional `gate.threshold`, default 0.9). A prepended `tools/pre-execute` listener judges sandbox escalations (calls to `bash`, `pwsh`, `write`, `edit`, `str_replace_editor` and inner `run_code` calls that carry `sandbox_permissions`), after the static risk list; a prepended `approval/request` listener answers `allowed-once` only when all five narrow Noul answers (keeps data, stays in project, nothing shipped, serves the task, justified) reach the threshold. It never denies; risk-list hits, low or missing scores and Judge failures leave DSH's normal prompt in place. Not yet verified in a live DSH session (see ADR 0005).

## Develop

```sh
npm run typecheck
npm test        # no network
```
