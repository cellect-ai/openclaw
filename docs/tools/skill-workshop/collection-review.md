---
summary: "Weekly Workshop collection review through the versioned skill library"
title: "Collection review"
read_when:
  - You are enabling or debugging the weekly collection review
  - You need to know what a review can change and how to inspect retained legacy material
---

## Collection review

In `auto` mode, the Gateway maintains one weekly automation per agent. Cron owns
scheduling, cancellation, and run history. `propose` and `off` disable these reviews.
The automation does not announce into a conversation.

The reviewer uses only the versioned `skill_workshop` tool. It lists and views the
learned collection before making changes, treats skill content as untrusted review
material, and checks the result of each change. Shell, ordinary filesystem,
network, and business tools are unavailable for this turn. Tool search and Code
Mode are disabled. The review does not grant new tool or execution authority.

The review can create, patch, write support files, archive, and restore skills
through the current library. It must preserve distinct triggers, local policy,
and uncertain rules. Low usage alone does not justify removal. It reports
completed changes and reasons, remaining scope, or why no changes were necessary.
The turn uses a bounded prompt and output budget and a maximum two-minute timeout.

### Runtime and authorization

The embedded OpenClaw runtime is supported. Another harness must declare exact
conversation-tool-policy support through its loaded native registration before
execution. Static eligibility may recognize Codex, but runtime admission still
checks the actual loaded harness. CLI execution is refused. No runtime is
substituted to bypass these checks.

An agent with no eligible review tool or no provably supported configured runtime
chain keeps a visible disabled automation. Unknown static eligibility is resolved
at native candidate admission. Gateway startup and configuration changes reconcile
the declaration; runtime checks again require the exact agent, weekly schedule,
isolated session target, fixed prompt, tool allowlist, and no-delivery policy.

Versioned library effects retain current source and authoring capability checks.
A revoked source cannot authorize a later file change merely because the review
started earlier. Sandbox policy and native tool availability still apply.

### Changes and recovery

Completed versioned edits survive cancellation or failure of a later step. There
is no transaction or automatic rollback across the whole collection. Inspect
native library history and the automation's run history before retrying an
interrupted review. If files changed but the change journal was not confirmed,
the tool reports that uncertainty; it does not claim a successful history entry
or instruct an automatic retry.

The current tool's `restore` operation belongs to the versioned skill library.
It is not the retired `restore_collection` action, and it does not imply adoption
of an older collection backup.

Native Doctor exports retained pending and quarantined proposal drafts into the
owning agent's Workshop drafts inbox under exclusive state maintenance. Review
those exports with `/learn drafts`. Missing, unowned, or conflicting material is
reported for review rather than assigned a new owner. Follow the actual Doctor
report for the retained source; a successful current library operation does not
prove that every older proposal or collection backup was migrated.

Before operator-led recovery from legacy collection backups, preserve the entire
original backup and a separate copy of affected current skills, including hidden
files and nested support content. Compare copies outside the live Workshop and
state directories. Do not rewrite hashes or manifests, delete deep files to make
a check pass, or treat a retained backup as authority to overwrite newer edits.
Use the supported migration and recovery route for that stored format; unresolved
legacy material must remain intact until its disposition is established.
