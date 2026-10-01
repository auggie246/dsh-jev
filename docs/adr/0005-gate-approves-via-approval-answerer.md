---
status: accepted
---
# The Gate approves through an approval answerer, not `tools/pre-execute` alone

Amends ADR 0001 and 0003. The spike (#2) found that a `tools/pre-execute` allow does not skip the sandbox-escalation prompt, which is raised inside the tool body (`approveEscalation` in `dsh-sandbox`). The Gate therefore judges in a prepended `tools/pre-execute` listener (never returning deny, stashing the verdict by `callId`) and auto-answers the escalation from a prepended `approval/request` listener that returns `allowed-once` only for a confident verdict, otherwise `next()`. The `never` approval policy is enforced before the answerer waterfall, so unattended runs stay denied. Untested at runtime; ticket #4 must prove it first and revise this ADR if it fails.

Runtime evidence (#4, DSH 0.2.0-rc.2, `web-test` profile, Workspace write = sandbox `workspace-write` + approval `ask`):
- A confident verdict auto-approves. Three escalating `bash` calls each logged `approval/asked` and `approval/decided: allowed-once` 1 ms apart, while a human-approved control session took 3-10 s. The `callId` on `approval/request` matches the one seen at `tools/pre-execute`.
- A low verdict leaves the normal prompt in place (fall-through audit lines, prompts shown).
- A static-risk-list hit (`git push --force`, including the `git -C <dir> push ...` form) is recorded as `risk-list:force push`, never reaches Jev, and the approval was asked with no auto-answer.
- Policy `never`, observed live with a test-only preset (`workspace-write` sandbox + `never`): the Gate judged an escalating call and audited `auto-approve` (its stashed verdict), yet `approval/asked` was followed by `approval/decided: rejected` in the same millisecond and the command did not run. The service enforces `never` before the answerer waterfall, so the Gate's prepended answerer cannot override it. The Gate's `auto-approve` audit line records its own verdict, not the final outcome. In another run the model, told the policy was `never`, declined to send the escalation at all; the same safety then holds one layer earlier.
- Learned in use: only escalating calls (`sandbox_permissions` plus `justification`) prompt in stock DSH, so only those are judged. The Gate approves only when every Noul answer reaches `gate.threshold`; the default of 0.9 is conservative and should be tuned on the user's own data.
