# The Gate is approve-only and falls through when unsure

The Gate can turn a prompt into an allow when a Judge is confident a tool call is reversible and serves the task, but it never denies. Only the static risk list and the user's own DSH deny rules block. Jev being unreachable, timing out, returning an out-of-range answer, or scoring below threshold means DSH behaves exactly as if the plugin were absent. Jev reads literally, degrades on large state and can be steered by adversarial text, so a wrong Jev answer must cost at most one extra prompt, never a wrongly blocked or silently authorised action beyond what a human would have approved.

## Considered Options

- **Approve or block**: fewer prompts for risky calls, but a wrong block interrupts legitimate work with no recourse.
- **Advisory only**: safest, but delivers none of the prompt reduction the Gate exists for.
