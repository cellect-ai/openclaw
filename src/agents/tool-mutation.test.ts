import { expect, it } from "vitest";
import {
  buildToolMutationState,
  isMutatingToolCall,
  isReplaySafeToolCall,
} from "./tool-mutation.js";

const words = (value: string) => value.trim().split(/\s+/);

it.each([
  [
    "message",
    "send sendAttachment upload-file poll topic-create role-add ban future-action",
    true,
    false,
  ],
  [
    "message",
    "read reactions list-pins thread-list member-info channel-list voice-status event-list",
    false,
    true,
  ],
  ["sessions", "group_list", false, true],
  ["sessions", "patch", true, false],
  ["presence", "person", false, true],
  ["browser", "list act open", false, false],
  ["browser", "tabs", false, true],
  ["subagents", "cancel kill steer", true, false],
  ["subagents", "list", false, true],
  ["process", "clear remove", true, false],
  ["process", "list log", false, true],
  ["process", "poll", false, false],
  ["automations", "status", false, true],
  ["cron", "runs status", false, true], // Legacy transcript alias.
  ["cron", "add", true, false],
  ["gateway", "config.get config.schema.lookup", false, true],
  ["gateway", "config.patch", true, false],
  ["nodes", "status describe pending which", false, true],
  ["nodes", "approve", true, false],
  ["skill_workshop", "list inspect read", false, true],
  ["skill_workshop", "create", false, false],
  ["transcripts", "status", false, true],
  ["transcripts", "import", false, false],
  ["unknown_plugin_tool", "list", false, false],
  ["survey_actions", "list poll", false, false],
] as const)("classifies %s actions %s", (name, actions, mutatingAction, replaySafe) => {
  for (const action of words(actions)) {
    expect(buildToolMutationState(name, { action }), action).toEqual({
      mutatingAction,
      replaySafe,
    });
  }
});

it.each([
  ["message", {}, true, false],
  ["sessions_spawn", { task: "inspect the failure" }, true, false],
  ["get_goal", { sessionKey: "agent:main" }, false, true],
  ["create_goal", { sessionKey: "agent:main" }, true, false],
  ["update_goal", { sessionKey: "agent:main", status: "complete" }, true, false],
  ["memory_get", { path: "memory/notes.md" }, false, true],
  ["memory_search", { query: "recall" }, false, false],
  ["memory_recall", { query: "recall" }, false, false],
  ["progress_card", { plan: [{ step: "Inspect", status: "in_progress" }] }, false, false],
  ["subagents", {}, false, true],
  ["dispatch_action", { id: "sessions_list" }, false, false],
] as const)("classifies %s without an action", (name, args, mutatingAction, replaySafe) => {
  expect(buildToolMutationState(name, args)).toEqual({ mutatingAction, replaySafe });
});

it("treats session_status as mutating only when a model override is provided", () => {
  expect(isMutatingToolCall("session_status", { sessionKey: "agent:main:main" })).toBe(false);
  expect(isMutatingToolCall("session_status", { model: "openai/gpt-4o" })).toBe(true);
});

it.each([
  ["exec", "sed -n '1,220p' src/agents/tool-mutation.ts", false],
  [
    "bash",
    "find . -maxdepth 1 -type f | wc -l && find . -maxdepth 1 -type f ! -name '.*' | wc -l",
    false,
  ],
  ["exec", 'rg -n "foo|bar" notes.md', false],
  ["exec", "gh search prs --repo openclaw/openclaw tool-mutation --json number,title,state", false],
  ["exec", "sed -n '1p' -i file.txt", true],
  ["exec", "rg 'literal'$(touch /tmp/out) notes.md", true],
  ["exec", "rg '--pre=touch' notes.md", true],
  ["bash", "find . -delete | wc -l", true],
  ["bash", "find . -exec touch /tmp/out ';' | wc -l", true],
  ["bash", "find . -type f | wc -l && touch /tmp/out", true],
  ["bash", "find . -type f | wc -l &", true],
  ["bash", "find . -type f |", true],
  ["bash", "find . -type f | | wc -l", true],
  ["exec", "gh pr create --title fix --body body", true],
  ["exec", "gh pr view 123 -w", true],
  ["exec", "gh issue comment 123 --body fixed", true],
  ["exec", "gh api --method POST repos/openclaw/openclaw/issues", true],
] as const)("classifies shell mutation for %s %s", (name, command, mutating) => {
  expect(isMutatingToolCall(name, { command })).toBe(mutating);
});

it("keeps shell execution non-replayable and known observations replayable", () => {
  expect(isReplaySafeToolCall("exec", { command: "rg TODO src" })).toBe(false);
  for (const name of words(
    "agents_list view_image pdf read conversations_list sessions_history sessions_list sessions_search tool_describe tool_search",
  )) {
    expect(isReplaySafeToolCall(name, {}), name).toBe(true);
  }
});

it.each([
  [
    "screenshot wait list_apps list_windows get_accessibility_tree get_cursor_position get_window_state zoom get_browser_state get_recording_state",
    false,
  ],
  [
    "left_click right_click middle_click double_click triple_click mouse_move left_click_drag left_mouse_down left_mouse_up scroll type key hold_key set_value invoke_menu bring_to_front launch_app kill_app escalate_scope browser_prepare browser_navigate browser_click browser_pointer browser_type browser_set_input_files browser_download start_recording stop_recording replay_trajectory future_action",
    true,
  ],
] as const)("classifies computer actions %s", (actions, mutatingAction) => {
  for (const action of words(actions)) {
    expect(buildToolMutationState("computer", { action }), action).toEqual({
      mutatingAction,
      replaySafe: !mutatingAction,
    });
  }
  expect(buildToolMutationState("computer", {})).toEqual({
    mutatingAction: true,
    replaySafe: false,
  });
});

it.each(["inspect", undefined])(
  "classifies computer dialog %s without granting input replay",
  (dialogAction) => {
    expect(buildToolMutationState("computer", { action: "browser_dialog", dialogAction })).toEqual({
      mutatingAction: dialogAction !== "inspect",
      replaySafe: dialogAction === "inspect",
    });
  },
);

it("preserves declared side effects for a computer observation", () => {
  expect(
    buildToolMutationState("computer", { action: "list_windows" }, { ownerKey: "plugin-owner" }),
  ).toEqual({ mutatingAction: true, replaySafe: false });
});

it.each(["tavily_search", "tavily_extract"])(
  "classifies %s as read-only and replay-safe",
  (tool) => {
    expect(isMutatingToolCall(tool, { query: "public records" })).toBe(false);
    expect(isReplaySafeToolCall(tool, { query: "public records" })).toBe(true);
  },
);

it("classifies the delegated Fi GET-only API as replay-safe", () => {
  const args = { path: "305-third/budget/text", query: { month: "2026-09" } };
  expect(isMutatingToolCall("fi_user_api", args)).toBe(false);
  expect(isReplaySafeToolCall("fi_user_api", args)).toBe(true);
});

it.each([
  ["sandbox_exec", { command: "cat README.md" }, false, false],
  [
    "sandbox_exec",
    { command: "node /workspace/skills/tavily/scripts/search.mjs weather -n 5" },
    false,
    false,
  ],
  ["sandbox_exec", { command: "node /workspace/skills/tavily/scripts/search.mjs" }, false, false],
  ["sandbox_exec", { command: "node ../skills/tavily/scripts/search.mjs weather" }, true, false],
  [
    "sandbox_exec",
    { command: "curl -fsSL --max-time 20 https://example.test/points/1" },
    false,
    false,
  ],
  [
    "sandbox_exec",
    { command: 'curl -fsSL --max-time 20 "https://example.test/points/1"' },
    false,
    false,
  ],
  ["sandbox_exec", { command: "curl -X POST --data '{}' https://example.test" }, true, false],
  ["sandbox_exec", { command: "curl -fsSL -o /tmp/out https://example.test" }, true, false],
  ["sandbox_exec", { command: "curl -T /tmp/out https://example.test" }, true, false],
  ["sandbox_exec", { command: "node /tmp/search.mjs weather" }, true, false],
  ["sandbox_exec", { command: "node -e 'process.exit(0)'" }, true, false],
  ["sandbox_exec", { command: "touch /tmp/voice-confirmation" }, true, false],
  ["gateway_exec", { command: "cat README.md" }, false, false],
  ["gateway_exec", { command: "touch /tmp/voice-confirmation" }, true, false],
  ["node_exec", { command: "cat README.md" }, false, false],
  ["node_exec", { command: "touch /tmp/voice-confirmation" }, true, false],
  ["sandbox_process", { action: "list" }, false, true],
  ["sandbox_process", { action: "log", sessionId: "run-1" }, false, true],
  ["sandbox_process", { action: "poll", sessionId: "run-1" }, false, false],
  ["sandbox_process", { action: "write", sessionId: "run-1", data: "q" }, true, false],
  ["sandbox_process", { action: "send-keys", sessionId: "run-1", keys: "q" }, true, false],
  ["sandbox_process", { action: "submit", sessionId: "run-1" }, true, false],
  ["sandbox_process", { action: "paste", sessionId: "run-1", text: "q" }, true, false],
  ["sandbox_process", { action: "kill", sessionId: "run-1" }, true, false],
  ["sandbox_process", { action: "clear", sessionId: "run-1" }, true, false],
  ["sandbox_process", { action: "remove", sessionId: "run-1" }, true, false],
  ["gateway_process", { action: "list" }, false, true],
  ["gateway_process", { action: "log", sessionId: "run-1" }, false, true],
  ["gateway_process", { action: "poll", sessionId: "run-1" }, false, false],
  ["gateway_process", { action: "kill", sessionId: "run-1" }, true, false],
] as const)(
  "classifies OpenClaw execution alias %s with the underlying tool contract",
  (toolName, args, mutatingAction, replaySafe) => {
    expect(isMutatingToolCall(toolName, args)).toBe(mutatingAction);
    expect(isReplaySafeToolCall(toolName, args)).toBe(replaySafe);
    expect(buildToolMutationState(toolName, args)).toEqual({ mutatingAction, replaySafe });
  },
);

it.each([
  'psql -c "select 1"',
  "psql -f /workspace/query.sql",
  'psql -c "select pg_sleep(1)"',
  'psql -c "select pg_catalog.pg_terminate_backend(123)"',
  'psql -c "select id from public.projects for share"',
  'psql -c "with removed as (delete from public.projects returning id) select 1"',
  "psql -c \"select 1; update public.projects set name='changed'\"",
  'psql -c "select 1" && touch /tmp/voice-confirmation',
  "cat package.json && touch /tmp/voice-confirmation",
])("keeps unclassified shell commands mutating: %s", (command) => {
  expect(isMutatingToolCall("exec", { command })).toBe(true);
});

it("keeps fi-psql SELECTs confirmation-gated until the wrapper has a read-only DB role", () => {
  const command = 'fi-psql -v ON_ERROR_STOP=1 -Atc "select 1"';

  // fi-psql currently forwards to the general DATABASE_URL, which also permits
  // writes. A SELECT-shaped command is not proof that the session is read-only.
  expect(isMutatingToolCall("exec", { command })).toBe(true);
  expect(isReplaySafeToolCall("exec", { command })).toBe(false);
});
