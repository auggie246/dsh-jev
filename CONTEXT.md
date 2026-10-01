# dsh-jev

A DeepSeek Harness (DSH) plugin that uses Jev, a typed-decision model, to gate, route, verify and suggest around the DeepSeek coding loop. DeepSeek still writes the code; Jev only makes fast structured judgments.

## Language

**Judgment**:
One typed question put to a judge about a piece of state, answered as a Choice, a Noul or a Score with probabilities.
_Avoid_: Prompt, query, classification

**Judge**:
The backend that answers Judgments. Jev is the first Judge; an open-weights local model is a later one.
_Avoid_: Model, provider, classifier

**Recipe**:
A named coding workflow built from Judgments and ordinary code: tool-call gate, skill suggestion, patch verification gate, tool-result injection guard, model/effort routing.
_Avoid_: Feature, cookbook, pattern

**Judge core**:
The shared layer every Recipe uses to ask Judgments: the Judge backend interface, secret redaction, egress rules and the audit record of each Judgment.
_Avoid_: SDK wrapper, client

**Egress rule**:
What state may leave the machine in a Judgment: secrets are redacted, protected paths are never sent, and each Recipe is off until explicitly enabled.
_Avoid_: Privacy setting

**Static risk list**:
The deterministic patterns (recursive delete, force push, privilege escalation, publish/deploy, sending data to another host, credential files, shell-in-string) that always run before any Judgment, over a command and the Script bodies it runs, and send a tool call straight to the normal prompt.
_Avoid_: Blocklist, denylist

**Script body**:
The text a package-manager command will actually run, read locally from the project's scripts (the named script, its pre/post hooks, and one level of scripts it calls). It can only add evidence for a Judge or force a prompt; it never approves anything by itself.
_Avoid_: Script contents, npm script

**Gate**:
The Recipe that lets a tool call skip the prompt only when a Judge is confident it is reversible and serves the task. It can allow; it never denies.
_Avoid_: Auto mode, permission hook

**Fall-through**:
What every Recipe does when a Judge is unavailable or unsure: DSH behaves exactly as if the plugin were absent.
_Avoid_: Fail-open, fallback

**Decision layer**:
The role the plugin plays around DeepSeek: it judges and gates, and never generates code or text itself.
_Avoid_: Agent, harness, replacement model
