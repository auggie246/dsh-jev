---
status: proposed
---
# The Gate approves through an approval answerer, not `tools/pre-execute` alone

Amends ADR 0001 and 0003. The spike (#2) found that a `tools/pre-execute` allow does not skip the sandbox-escalation prompt, which is raised inside the tool body (`approveEscalation` in `dsh-sandbox`). The Gate therefore judges in a prepended `tools/pre-execute` listener (never returning deny, stashing the verdict by `callId`) and auto-answers the escalation from a prepended `approval/request` listener that returns `allowed-once` only for a confident verdict, otherwise `next()`. The `never` approval policy is enforced before the answerer waterfall, so unattended runs stay denied. Untested at runtime; ticket #4 must prove it first and revise this ADR if it fails.

Status note (#4): the two-listener ordering is verified on a real Cordis context with a fake Judge (`test/gate-cordis.test.ts`); it stays `proposed` until a live DSH session confirms an escalating call auto-approves, a low verdict prompts, and policy `never` denies.
