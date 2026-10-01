---
status: accepted
---
# The Gate approves through an approval answerer, not `tools/pre-execute` alone

Amends ADR 0001 and 0003. The spike (#2) found that a `tools/pre-execute` allow does not skip the sandbox-escalation prompt, which is raised inside the tool body (`approveEscalation` in `dsh-sandbox`). The Gate therefore judges in a prepended `tools/pre-execute` listener (never returning deny, stashing the verdict by `callId`) and auto-answers the escalation from a prepended `approval/request` listener that returns `allowed-once` only for a confident verdict, otherwise `next()`. The `never` approval policy is enforced before the answerer waterfall, so unattended runs stay denied. Untested at runtime; ticket #4 must prove it first and revise this ADR if it fails.

Runtime evidence (#4, DSH 0.2.0-rc.2, `web-test` profile, Workspace write = sandbox `workspace-write` + approval `ask`):
- A confident verdict auto-approves. Three escalating `bash` calls each logged `approval/asked` and `approval/decided: allowed-once` 1 ms apart, while a human-approved control session took 3-10 s. The `callId` on `approval/request` matches the one seen at `tools/pre-execute`.
- A low verdict leaves the normal prompt in place (fall-through audit lines, prompts shown).
- A static-risk-list hit (`git push --force`, including the `git -C <dir> push ...` form) is recorded as `risk-list:force push`, never reaches Jev, and the approval was asked with no auto-answer.
- Not observed live: policy `never`. No shipped preset escalates under it (Full access is `never` with nothing to gate), so this rests on the spike's source reading that the service enforces `never` before the answerer waterfall.
- Learned in use: only escalating calls (`sandbox_permissions` plus `justification`) prompt in stock DSH, so only those are judged. The Gate approves only when every Noul answer reaches `gate.threshold`; the default of 0.9 is conservative and should be tuned on the user's own data.
