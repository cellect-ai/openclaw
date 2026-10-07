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

All of these must hold; otherwise nothing is set, nothing is pinned, and the
command runs exactly as it did before there was a token.

The runtime's configuration, read the way the host reads it (the admin agent's
own setting, then the default):

- `sandbox.mode` is `all`.
- `sandbox.scope` is `session` or `agent`, not `shared`.
- `tools.exec.host` is unset, `auto` or `sandbox`.
- `tools.elevated.enabled` is `false`, globally or for the admin agent. Left
  unset it counts as on, and nothing is issued.
- `talk.agentId` is not the admin agent.
- The plugin has a `tenantOrgId`.

The message and the run:

- The message that started the run is one the channel itself proved the sender
  of (`senderAuthentication: "verified"`), in one of these sessions:
  - Slack: the sender's own direct session, `agent:<adminAgentId>:slack:direct:<peer>`.
  - Matrix, direct message or room or thread: `agent:<adminAgentId>:matrix:…`,
    classified by the Matrix monitor as one or the other, and the run is the
    one the host started for that very homeserver event and sender (the
    dispatched `messageId` and sender equal the run's
    `channelContext.chat.eventId` and `channelContext.sender.id`). A room
    thread is how Fi web chat reaches the admin agent.
  - Slack channels and threads, Discord, webchat and every other session kind
    get no token.
- Every input observed for the session since a message run last took it up
  came from that one person, within the last six hours.
- The run is a `user` turn by that same sender. Cron, heartbeat, system-event,
  webhook, sub-agent, inter-session, tool-injected and resumed runs get no
  token, nor does a run started by one of this Gateway's own Matrix bot accounts.
- Nobody else wrote into the session while the run was active.
- No Talk consult has run on the session in this process.
- The session is not an approved admin action (those keep `FI_ON_BEHALF_OF` only).

The call:

- It is OpenClaw's own `exec` (`sandbox_exec` included) with no `host` other
  than `sandbox`, no `node`, not `elevated`, not `pty` and not `background`.
- Its own `FI_APP_URL`, if it passes one, equals the plugin `baseUrl`.
- At least half a second is left of the time the host gives the tool hook.
  Fi is given what remains of 13 seconds after the Matrix grant check, and
  never more than 8.
- Fi answers 200 for this runtime's organization with a token that has at
  least 60 seconds left. Fi decides who is an admin; a refusal is no token.

A call that gets a token is returned with `host: "sandbox"` and
`elevated: false`. Because of the configuration checks above that is what the
command would have got anyway.

### Rooms and threads: one message, one run

In a Matrix room or thread the token belongs to one message. When a person the
homeserver proved writes to the admin agent, the run that message starts may
ask Fi for that person's token. Nothing is kept for the thread: the next
message is a new run that stands on its own sender. If someone else writes into
the thread while the run is still working, the rest of that run gets no token.

Which organization a room belongs to is not something the plugin can read from
the message. The Matrix admission gate asks Fi about the room and event before
the run and before every tool call, and blocks the call unless Fi names this
runtime's organization; a token is only ever asked for after that.

### After a token: the sandbox is held

A command that ran with a token may have printed it or left a file or a
running process behind. Until that token expires (ten minutes at most), the
sandbox it ran in is kept to the person it was issued for. The admin agent's
`exec`, `sandbox_exec`, `process`, `sandbox_process`, `read`, `ls`, `write`,
`edit`, `apply_patch` and `view_image` calls are blocked with "Another admin's
command is still finishing here. Try again in a few minutes." unless the run is
one proven to be that person's. Cron, heartbeat and approved-action runs have
no proven person and are blocked too.

Which sandbox that is follows `sandbox.scope` for the admin agent:

- `session`: only that session (that thread) is held.
- `agent` (the default, and what tenant runtimes are generated with): the
  admin agent has one sandbox, so one person's token holds every other person's
  admin-agent commands, in every conversation, for up to ten minutes. The same
  person on Slack and on Matrix counts as two people.
- `shared`: other agents use the same sandbox and cannot be held, so no token
  is issued at all.

If two people's commands ask Fi at the same moment, the first answer takes the
sandbox and the other command is blocked with the same message. A token that
claims to live longer than fifteen minutes is refused, and nothing is held for
a token that was not handed to a command.

The hold is in memory. A plugin reload or Gateway restart forgets it.

### Output is not scrubbed

The plugin does not redact tool output. A command that prints its environment
puts the token in the thread's transcript, where the model and everyone in the
thread can read it. What bounds that: the token lives ten minutes, Fi accepts
it on five routes only, Fi checked that its owner is an admin of this
organization, and the sandbox is held for its owner while it lives.

The host does mask the `FI_DELEGATED_USER_TOKEN` value where it records a
call's arguments (tool-start events, trajectory, CLI and worker events).

Follow-up: redaction in a separate plugin with a sandbox-tools matcher. It is
not done here because a plugin that declares tool-result middleware changes
how the host handles every agent's tool results on the Gateway.

### Deploy preconditions

Checked by the plugin; where one fails, no token is issued and nothing changes:

| Setting                                                        | Enforced how                                |
| -------------------------------------------------------------- | ------------------------------------------- |
| Admin agent `sandbox.mode: "all"`                              | No token otherwise.                         |
| Admin agent `sandbox.scope` is not `shared`                    | No token otherwise.                         |
| Admin agent `tools.exec.host` unset, `auto` or `sandbox`       | No token otherwise.                         |
| `tools.elevated.enabled: false`, global or for the admin agent | No token otherwise. Must be set explicitly. |
| `talk.agentId` is not the admin agent                          | No token otherwise.                         |
| Plugin `tenantOrgId` (or `matrixTenantOrgId`)                  | No token otherwise.                         |

Not visible to the plugin; infra must assert these for a runtime that issues tokens:

| Setting                                                              | Why                                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No per-session `sandboxMode` or exec host override on admin sessions | The plugin reads configuration, not a session's stored override. With one, the pinned call is refused or the command was not in the sandbox to begin with.                                                          |
| Sandbox `FI_APP_URL` equals the plugin `baseUrl`                     | The plugin does not set `FI_APP_URL`. The CLI sends the bearer wherever the sandbox says.                                                                                                                           |
| Sandbox egress limited to the Fi origin                              | The model writes the command. Nothing in the Gateway stops it sending the token elsewhere.                                                                                                                          |
| Codex exec-server off for the admin agent                            | It takes its environment from Codex and drops `*_TOKEN` keys; the token would not arrive and the call is not this plugin's to pin.                                                                                  |
| Admin agent not on a CLI backend; Codex native shell not relied on   | A native shell is seen as `exec` but takes no `env`. The host refuses any rewrite of a Codex native shell call, so such a call is blocked whenever an assertion or token is set; the token never reaches the model. |
| No Talk binding to an admin-agent session                            | A binding is made at run time for a session, not in configuration. The plugin sees only `talk.agentId` and, afterwards, the first consult.                                                                          |
| `sandbox.scope` chosen knowingly                                     | See "After a token: the sandbox is held". `agent` scope serialises admins across the whole runtime while a token lives; `session` scope holds one thread.                                                           |

Config keys used: `baseUrl`, `brokerTokenEnv`, `tenantOrgId` (or
`matrixTenantOrgId`), `adminAgentId`; for Matrix also `matrixEnvironments` and
the `FI_THREADS_ENV_BY_ACCOUNT` environment variable. No key was added.

### What remains exposed

- The token is in the command's environment for up to ten minutes. The
  rewritten call, token included, also reaches other plugins' `after_tool_call`
  hooks and tool-result middleware, and the exec approval request. Tool output
  is not redacted; see "Output is not scrubbed".
- A command that outlives its call (the host moves a long command to the
  background on its own) keeps the token in its environment. The hold above is
  what keeps other people's runs away from it.
- In a room the agent also reads messages that were never dispatched to it, so
  other people's words can steer what an admin's run does with the token.
- The plugin cannot tell a person from a bridged or other automated Matrix
  account the Gateway does not own; Fi's answer for that account is the only
  check.
- A Talk binding that has not yet produced a consult is invisible here.
- After someone else's message is steered into a turn, the owner's next turn
  gets no token; the one after does.
- At most 5,000 sessions with unanswered messages are remembered; past that
  the oldest is forgotten, and a run for a forgotten message gets no token.
