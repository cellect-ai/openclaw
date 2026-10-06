# Fi User Delegation (`fi-user`)

Requester-bound Fi, Gmail, Drive, data-room and e-sign tools for the Fi user
agent, the Matrix admission gate, admin-action approvals, and requester
attribution for the admin agent's shell work.

## The admin agent's delegated user token

For a shell command of this runtime's admin agent (`adminAgentId`, default
`cellect-fi-admin`) the plugin asks Fi for the requester's own short-lived token
(`POST {baseUrl}/api/openclaw-user-delegation`, `agentId: "cellect-fi-admin"`)
and sets it on that one call as `FI_DELEGATED_USER_TOKEN`. Fi's CLI prefers it
to `FI_SERVICE_TOKEN` + `FI_ON_BEHALF_OF`. `FI_ON_BEHALF_OF` is injected as
before, whether or not a token is issued.

### When a token is issued

All of these must hold; otherwise nothing is set and Fi is not asked.

- The session is one person's own conversation with the admin agent:
  - Slack: `agent:<adminAgentId>:slack:direct:<peer>`, and the sender is that peer.
  - Matrix: `agent:<adminAgentId>:matrix:…`, and the Matrix monitor classified
    every dispatched message as a direct message (`isGroup === false`).
  - Slack channels and threads, Matrix rooms with more than one person, webchat
    and every other session kind get no token.
- Every input observed for the session since a message run last took it up
  came from that one person, and the channel proved them on a dispatched
  message (`senderAuthentication: "verified"`).
- The run is a `user` turn by that same sender. Cron, heartbeat, webhook,
  sub-agent, inter-session and resumed runs get no token.
- Nobody else wrote into the session while the run was active.
- No Talk consult has run on the session in this process.
- The session is not an approved admin action (those keep `FI_ON_BEHALF_OF` only).
- The call is OpenClaw's own `exec` (`sandbox_exec` included) with no `host`
  other than `sandbox`, no `node`, and not `elevated`.
- The call's own `FI_APP_URL`, if it passes one, equals the plugin `baseUrl`.
- Fi answers 200 for this runtime's organization with a token that has at
  least 60 seconds left.

A call that gets a token is returned with `host: "sandbox"` and
`elevated: false`, so the host runs it in the sandbox or refuses it.

### Required settings

Nothing in the plugin can enforce these; a deployment that issues tokens must
have them.

| Setting                                                            | Why                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin agent `sandbox.mode: "all"`                                  | The pinned `host: "sandbox"` is refused when no sandbox exists, so without it no command that carries a token runs.                                                                                                                                                                                                 |
| `tools.exec.host` unset, `auto` or `sandbox` for the admin agent   | Any other value makes the host refuse the pinned call.                                                                                                                                                                                                                                                              |
| Elevated exec off for the admin agent                              | The pin sets `elevated: false`; a deployment should not rely on it alone.                                                                                                                                                                                                                                           |
| Admin agent sandbox scope `session`                                | The default `agent` scope shares one container between requesters: a file or background shell one person's command left behind is reachable from the next person's turn.                                                                                                                                            |
| Sandbox `FI_APP_URL` equals the plugin `baseUrl`                   | The plugin does not set `FI_APP_URL`. The CLI sends the bearer wherever the sandbox says.                                                                                                                                                                                                                           |
| Sandbox egress limited to the Fi origin                            | The model writes the command. Nothing in the Gateway stops it sending the token elsewhere.                                                                                                                                                                                                                          |
| Codex exec-server off for the admin agent                          | It takes its environment from Codex and drops `*_TOKEN` keys; the token would not arrive and the call is not this plugin's to pin.                                                                                                                                                                                  |
| Admin agent not on a CLI backend; Codex native shell not relied on | A native shell is seen as `exec` but takes no `env`. Any rewrite of a Codex native shell call is refused by the host, so those calls are blocked whenever an assertion or token is set. A native call that sends only `command` cannot be told from OpenClaw's own and would have the token written into its input. |
| Admin agent not reachable in group channels or threads             | They get no token; keeping the agent out of them avoids the refused commands.                                                                                                                                                                                                                                       |
| No Talk binding on admin-agent sessions                            | Voice steering is not observable by a plugin.                                                                                                                                                                                                                                                                       |

Config keys used: `baseUrl`, `brokerTokenEnv`, `tenantOrgId` (or
`matrixTenantOrgId`), `adminAgentId`; for Matrix also `matrixEnvironments` and
the `FI_THREADS_ENV_BY_ACCOUNT` environment variable. No key was added.

### What remains exposed

- The token is in the command's environment for up to ten minutes and the model
  can print it. The rewritten call also reaches tool-result middleware of other
  plugins, the exec approval request and, when content capture is on,
  diagnostics. This plugin does not redact tool output.
- A Talk binding that has not yet produced a consult is invisible here.
- After someone else's message is steered into a turn, the owner's next turn
  gets no token; the one after does.
- More than 5,000 tracked sessions or runs turns issuing off until the plugin
  is reloaded.
