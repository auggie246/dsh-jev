# Native Cordis plugin, not hooks or MCP

DSH's Claude Code hook bridge cannot auto-approve: `PreToolUse` supports only `deny` and `ask` (`allow` does not pre-approve), `PermissionRequest` is unsupported, and `updatedInput` is ignored. A Gate that lets confident calls skip the prompt needs the `tools/pre-execute` allow/deny/ask decision point, which only a native Cordis plugin reaches. We build native plugins in TypeScript and give up portability to other harnesses.

## Considered Options

- **Claude Code-style hooks plus an MCP server**: portable, but in DSH it can only deny or ask, so the Gate's main value is unreachable.
- **Native plugin plus a standalone MCP server**: rejected for v1 as extra surface; an MCP tool can be added later if on-demand judging is wanted.
