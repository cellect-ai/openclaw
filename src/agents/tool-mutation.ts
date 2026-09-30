/** Tool mutation and replay-safety classification. */
import { asOptionalObjectRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { isAutomationsToolName } from "./tools/automations-tool-name.js";
import { isComputerObservationAction } from "./tools/computer-tool-shared.js";

const READ_ONLY_ACTIONS = new Set([
  "get",
  "list",
  "read",
  "status",
  "show",
  "fetch",
  "search",
  "query",
  "view",
  "poll",
  "log",
  "inspect",
  "check",
  "probe",
  "runs",
]);

const PROCESS_MUTATING_ACTIONS = new Set([
  "write",
  "send_keys",
  "submit",
  "paste",
  "kill",
  "clear",
  "remove",
]);

const PROCESS_REPLAY_SAFE_ACTIONS = new Set(["list", "log"]);

const MESSAGE_READ_ONLY_ACTIONS = new Set([
  "reactions",
  "read",
  "list_pins",
  "permissions",
  "thread_list",
  "search",
  "sticker_search",
  "member_info",
  "role_info",
  "emoji_list",
  "channel_info",
  "channel_list",
  "voice_status",
  "event_list",
]);

const REPLAY_SAFE_TOOL_NAMES = new Set([
  "agents_list",
  "conversations_list",
  "find",
  "get_goal",
  "glob",
  "grep",
  "view_image",
  "ls",
  "memory_get",
  "pdf",
  "read",
  "search",
  "sessions_history",
  "sessions_list",
  "sessions_search",
  "tool_describe",
  "tool_search",
  "tavily_search",
  "web_fetch",
  "web_search",
  "x_search",
]);

const BROWSER_READ_ONLY_ACTIONS = new Set(["console", "profiles", "snapshot", "status", "tabs"]);
const MOBILE_UI_REPLAY_SAFE_ACTIONS = new Set(["observe"]);
const GATEWAY_REPLAY_SAFE_ACTIONS = new Set(["config.get", "config.schema.lookup"]);
const NODES_REPLAY_SAFE_ACTIONS = new Set(["status", "describe", "pending"]);

const READ_ONLY_SHELL_COMMANDS = new Set([
  "cat",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "stat",
  "tail",
  "wc",
]);

const READ_ONLY_GH_PR_SUBCOMMANDS = new Set(["checks", "diff", "list", "status", "view"]);
const READ_ONLY_GH_ISSUE_SUBCOMMANDS = new Set(["list", "status", "view"]);

const UNSAFE_RG_FLAGS = new Set(["--hostname-bin", "--pre", "--pre-glob", "--search-zip", "-z"]);
const UNSAFE_RG_VALUE_FLAGS = ["--hostname-bin", "--pre", "--pre-glob"] as const;
const SHELL_EXPANSION_CHARS = new Set(["$", "*", "?", "[", "]", "{", "}", "~"]);

type ToolMutationState = {
  mutatingAction: boolean;
  replaySafe: boolean;
};

function normalizeActionName(value: unknown): string | undefined {
  const normalized = normalizeOptionalLowercaseString(value)?.replace(/[\s-]+/g, "_");
  return normalized || undefined;
}

function canonicalizeMutationToolName(toolName: string): string {
  switch (toolName) {
    case "sandbox_exec":
      return "exec";
    case "sandbox_process":
      return "process";
    default:
      return toolName;
  }
}

function readShellCommand(record: Record<string, unknown> | undefined): string | undefined {
  const command = record?.command ?? record?.cmd;
  if (typeof command !== "string") {
    return undefined;
  }
  const trimmed = command.trim();
  return trimmed || undefined;
}

/**
 * Psql examples commonly use Bash's `$'\\t'` for a tab field separator. That
 * form is a literal escape, not parameter/command expansion; normalize only
 * this exact safe spelling before the conservative shell lexer sees it.
 */
function normalizeSafeAnsiCTab(command: string): string {
  return command.replace(/\$'\\t'/g, "'__openclaw_tab__'");
}

function tokenizeSimpleShellCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (const char of command) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        // Single quotes suppress shell expansion. Double quotes still permit
        // parameter, command, and escape expansion, so those remain denied.
        if (quote === '"' && /[$`\\]/.test(char)) {
          return undefined;
        }
        current += char;
      }
      continue;
    }
    if (/[;&|<>\n\r`\\]/.test(char) || SHELL_EXPANSION_CHARS.has(char)) {
      return undefined;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) {
    return undefined;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens.length > 0 ? tokens : undefined;
}

function splitSimpleAndChain(command: string): string[] | undefined {
  const commands: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      current += char;
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (
      char === "\\" ||
      char === ";" ||
      char === "|" ||
      char === "<" ||
      char === ">" ||
      char === "`" ||
      char === "\n" ||
      char === "\r"
    ) {
      return undefined;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "&") {
      if (command[index + 1] !== "&") {
        return undefined;
      }
      const segment = current.trim();
      if (!segment) {
        return undefined;
      }
      commands.push(segment);
      current = "";
      index += 1;
      continue;
    }
    current += char;
  }
  if (quote) {
    return undefined;
  }
  const finalSegment = current.trim();
  if (!finalSegment) {
    return undefined;
  }
  commands.push(finalSegment);
  return commands;
}

function isReadOnlySedCommand(tokens: readonly string[]): boolean {
  const args = tokens.slice(1);
  if (args.some((token) => token === "--in-place" || token.startsWith("--in-place="))) {
    return false;
  }
  if (args.some((token) => token.startsWith("-") && token !== "-" && token.includes("i"))) {
    return false;
  }
  // `sed -e 'w /tmp/out'` and mixed scripts are easy to misclassify. Only
  // allow the simple line-print shape that agents use for file inspection.
  if (args.some((token) => token === "-e" || token === "--expression")) {
    return false;
  }
  let sawSuppressAutoPrint = false;
  let expression: string | undefined;
  for (const token of args) {
    if (token === "--in-place" || token.startsWith("--in-place=")) {
      return false;
    }
    if (token === "--quiet" || token === "--silent") {
      sawSuppressAutoPrint = true;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      if (token.includes("i")) {
        return false;
      }
      if (token.includes("n")) {
        sawSuppressAutoPrint = true;
      }
      continue;
    }
    expression ??= token;
    break;
  }
  return sawSuppressAutoPrint && expression != null && /^(\d+|\$)(,(\d+|\$))?p$/.test(expression);
}

function hasUnsafeRipgrepFlag(tokens: readonly string[]): boolean {
  return tokens.some((token) => {
    const normalized = normalizeLowercaseStringOrEmpty(token);
    return (
      UNSAFE_RG_FLAGS.has(normalized) ||
      UNSAFE_RG_VALUE_FLAGS.some((flag) => normalized.startsWith(`${flag}=`))
    );
  });
}

function isReadOnlyGhCommand(tokens: readonly string[]): boolean {
  if (
    tokens.some((token) => {
      const normalized = normalizeLowercaseStringOrEmpty(token);
      return (
        normalized === "--web" ||
        normalized.startsWith("--web=") ||
        /^-[a-z]*w[a-z]*(?:=.*)?$/.test(normalized)
      );
    })
  ) {
    return false;
  }
  const area = normalizeLowercaseStringOrEmpty(tokens[1]);
  const action = normalizeLowercaseStringOrEmpty(tokens[2]);
  if (area === "search") {
    return action.length > 0;
  }
  if (area === "pr") {
    return READ_ONLY_GH_PR_SUBCOMMANDS.has(action);
  }
  if (area === "issue") {
    return READ_ONLY_GH_ISSUE_SUBCOMMANDS.has(action);
  }
  return false;
}

function isReadOnlyMcporterList(tokens: readonly string[]): boolean {
  const positional: string[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--json") {
      continue;
    }
    if (token === "--config") {
      if (!tokens[index + 1]) return false;
      index += 1;
      continue;
    }
    if (token.startsWith("--config=") && token.length > "--config=".length) {
      continue;
    }
    if (token.startsWith("-")) {
      return false;
    }
    positional.push(token);
  }
  // `list [server]` only discovers the configured server/tool catalog. Keep
  // calls, server edits, and any future subcommands fail-closed.
  return positional[0] === "list" && positional.length <= 2;
}

const READ_ONLY_SQL_FUNCTIONS = new Set([
  "abs",
  "array_agg",
  "avg",
  "bool_and",
  "bool_or",
  "btrim",
  "ceil",
  "ceiling",
  "char_length",
  "coalesce",
  "concat",
  "concat_ws",
  "count",
  "date_part",
  "date_trunc",
  "floor",
  "greatest",
  "generate_series",
  "json_agg",
  "json_build_array",
  "json_build_object",
  "jsonb_agg",
  "jsonb_build_array",
  "jsonb_build_object",
  "jsonb_array_elements",
  "jsonb_array_elements_text",
  "jsonb_each",
  "jsonb_each_text",
  "jsonb_extract_path",
  "jsonb_extract_path_text",
  "jsonb_typeof",
  "least",
  "left",
  "length",
  "lower",
  "max",
  "min",
  "nullif",
  "replace",
  "regexp_matches",
  "regexp_replace",
  "right",
  "round",
  "split_part",
  "stddev",
  "stddev_pop",
  "stddev_samp",
  "string_agg",
  "sum",
  "current_setting",
  "array_length",
  "array_to_string",
  "string_to_array",
  "to_char",
  "to_date",
  "to_number",
  "to_timestamp",
  "trim",
  "trunc",
  "upper",
  "variance",
  "var_pop",
  "var_samp",
]);

const READ_ONLY_SQL_CALL_SYNTAX = new Set([
  "all",
  "and",
  "any",
  "array",
  "as",
  "cast",
  "character",
  "char",
  "decimal",
  "exists",
  "filter",
  "in",
  "integer",
  "interval",
  "numeric",
  "over",
  "or",
  "real",
  "row",
  "smallint",
  "time",
  "timestamp",
  "values",
  "varchar",
  "when",
]);

const FORBIDDEN_READ_ONLY_SQL_WORDS = new Set([
  "abort",
  "alter",
  "analyze",
  "begin",
  "call",
  "checkpoint",
  "cluster",
  "commit",
  "comment",
  "copy",
  "create",
  "delete",
  "deallocate",
  "discard",
  "do",
  "drop",
  "execute",
  "for",
  "grant",
  "insert",
  "listen",
  "lock",
  "merge",
  "notify",
  "prepare",
  "refresh",
  "reindex",
  "release",
  "reset",
  "revoke",
  "rollback",
  "savepoint",
  "security_label",
  "set",
  "truncate",
  "update",
  "vacuum",
]);

type ReadOnlySqlToken = {
  value: string;
  kind: "word" | "identifier" | "operator" | "punct" | "literal";
};

const READ_ONLY_SQL_OPERATORS = new Set([
  "!=",
  "!~",
  "!~*",
  "#>",
  "#>>",
  "%",
  "&",
  "&&",
  "*",
  "+",
  "-",
  "->",
  "->>",
  "/",
  "<",
  "<@",
  "<=",
  "<>",
  "=",
  ">",
  ">=",
  "?",
  "?&",
  "?|",
  "@>",
  "^",
  "||",
  "~",
  "~*",
  "::",
]);

function tokenizeReadOnlySql(sql: string): ReadOnlySqlToken[] | undefined {
  const trimmed = sql.trim();
  if (!trimmed || /[\\$`\n\r]/.test(trimmed)) {
    return undefined;
  }

  const tokens: ReadOnlySqlToken[] = [];
  for (let index = 0; index < trimmed.length;) {
    const char = trimmed[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === ";") {
      return trimmed.slice(index + 1).trim() ? undefined : tokens;
    }
    if ((char === "-" && trimmed[index + 1] === "-") || (char === "/" && trimmed[index + 1] === "*")) {
      return undefined;
    }
    if (char === "'") {
      index += 1;
      let closed = false;
      while (index < trimmed.length) {
        if (trimmed[index] === "'" && trimmed[index + 1] === "'") {
          index += 2;
          continue;
        }
        if (trimmed[index] === "'") {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) return undefined;
      tokens.push({ value: "<literal>", kind: "literal" });
      continue;
    }
    if (char === '"') {
      index += 1;
      let closed = false;
      let identifier = "";
      while (index < trimmed.length) {
        if (trimmed[index] === '"' && trimmed[index + 1] === '"') {
          identifier += '"';
          index += 2;
          continue;
        }
        if (trimmed[index] === '"') {
          index += 1;
          closed = true;
          break;
        }
        identifier += trimmed[index]!;
        index += 1;
      }
      if (!closed) return undefined;
      tokens.push({ value: identifier.toLowerCase(), kind: "identifier" });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < trimmed.length && /[A-Za-z0-9_]/.test(trimmed[end]!)) end += 1;
      tokens.push({ value: trimmed.slice(index, end).toLowerCase(), kind: "word" });
      index = end;
      continue;
    }
    if (/[0-9]/.test(char)) {
      let end = index + 1;
      while (end < trimmed.length && /[A-Za-z0-9_.]/.test(trimmed[end]!)) end += 1;
      tokens.push({ value: trimmed.slice(index, end), kind: "literal" });
      index = end;
      continue;
    }
    if (/[!#%&*+\-/<=>?@^|~]/.test(char)) {
      let end = index + 1;
      while (end < trimmed.length && /[!#%&*+\-/<=>?@^|~]/.test(trimmed[end]!)) end += 1;
      const operator = trimmed.slice(index, end);
      if (!READ_ONLY_SQL_OPERATORS.has(operator)) return undefined;
      tokens.push({ value: operator, kind: "operator" });
      index = end;
      continue;
    }
    tokens.push({ value: char, kind: "punct" });
    index += 1;
  }
  return tokens;
}

function isReadOnlySql(sql: string): boolean {
  const tokens = tokenizeReadOnlySql(sql);
  if (!tokens || tokens.length === 0) return false;
  const words = tokens.filter((token) => token.kind === "word").map((token) => token.value);
  const statementKind = words[0];
  if (
    !["select", "show", "values", "table"].includes(statementKind ?? "") &&
    !(statementKind === "with" && words.includes("select"))
  ) {
    return false;
  }
  if (words.some((word) => FORBIDDEN_READ_ONLY_SQL_WORDS.has(word) || word === "into")) return false;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "identifier" && tokens[index + 1]?.value === "(") return false;
    if (token.kind !== "word" || tokens[index + 1]?.value !== "(") continue;
    if (!READ_ONLY_SQL_FUNCTIONS.has(token.value) && !READ_ONLY_SQL_CALL_SYNTAX.has(token.value)) return false;
    if (tokens[index - 1]?.value === "." && tokens[index - 2]?.value !== "pg_catalog") return false;
  }
  return true;
}

function isReadOnlyPsqlCommand(tokens: readonly string[]): boolean {
  // Require the sandbox-provisioned command name. A path ending in `fi-psql`
  // could point at an arbitrary user script and must not inherit the exemption.
  if (normalizeLowercaseStringOrEmpty(tokens[0]) !== "fi-psql") return false;
  let query: string | undefined;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--command" || token === "-c") {
      if (query || !tokens[index + 1]) return false;
      query = tokens[++index];
      continue;
    }
    if (token.startsWith("--command=")) {
      if (query || token.length === "--command=".length) return false;
      query = token.slice("--command=".length);
      continue;
    }
    if (token === "--no-psqlrc" || token === "--quiet" || token === "--no-align" || token === "--tuples-only") {
      continue;
    }
    if (token === "--field-separator" || token === "-F") {
      if (!tokens[index + 1]) return false;
      index += 1;
      continue;
    }
    if (token.startsWith("--field-separator=") && token.length > "--field-separator=".length) {
      continue;
    }
    if (token === "--set" || token === "-v") {
      const value = tokens[index + 1];
      if (value !== "ON_ERROR_STOP=1") return false;
      index += 1;
      continue;
    }
    if (token.startsWith("--set=")) {
      if (token !== "--set=ON_ERROR_STOP=1") return false;
      continue;
    }
    if (token.startsWith("-v") && token.length > 2) {
      if (token !== "-vON_ERROR_STOP=1") return false;
      continue;
    }
    if (token.startsWith("-F") && token.length > 2) continue;
    if (token === "-A" || token === "-t" || token === "-X" || token === "-q") continue;
    if (token.startsWith("-") && !token.startsWith("--")) {
      const flags = token.slice(1);
      let commandSeen = false;
      for (let flagIndex = 0; flagIndex < flags.length; flagIndex += 1) {
        const flag = flags[flagIndex]!;
        if (flag === "A" || flag === "t" || flag === "X" || flag === "q") continue;
        if (flag === "c") {
          if (query) return false;
          const inline = flags.slice(flagIndex + 1);
          if (inline) query = inline;
          else if (tokens[index + 1]) query = tokens[++index];
          else return false;
          commandSeen = true;
          break;
        }
        if (flag === "F") {
          if (!flags.slice(flagIndex + 1) && !tokens[index + 1]) return false;
          if (!flags.slice(flagIndex + 1)) index += 1;
          commandSeen = true;
          break;
        }
        if (flag === "v") {
          const inline = flags.slice(flagIndex + 1);
          const value = inline || tokens[index + 1];
          if (value !== "ON_ERROR_STOP=1") return false;
          if (!inline) index += 1;
          commandSeen = true;
          break;
        }
        return false;
      }
      if (!commandSeen && flags.length === 0) return false;
      continue;
    }
    return false;
  }
  return Boolean(query && isReadOnlySql(query));
}

function isPlainReadOnlyShellCommand(command: string | undefined): boolean {
  if (!command) {
    return false;
  }
  const commands = splitSimpleAndChain(normalizeSafeAnsiCTab(command));
  if (!commands) {
    return false;
  }
  if (commands.length > 1) {
    return commands.every((segment) => isPlainReadOnlyShellCommand(segment));
  }
  const tokens = tokenizeSimpleShellCommand(commands[0]!);
  if (!tokens) {
    return false;
  }
  const executable = normalizeLowercaseStringOrEmpty(tokens[0]);
  if (executable === "rg" && hasUnsafeRipgrepFlag(tokens)) {
    return false;
  }
  if (READ_ONLY_SHELL_COMMANDS.has(executable)) {
    return true;
  }
  if (executable === "sed") {
    return isReadOnlySedCommand(tokens);
  }
  if (executable === "gh") {
    return isReadOnlyGhCommand(tokens);
  }
  if (executable === "mcporter") {
    return isReadOnlyMcporterList(tokens);
  }
  if (executable === "fi-psql") {
    return isReadOnlyPsqlCommand(tokens);
  }
  return false;
}

export function isMutatingToolCall(toolName: string, args: unknown): boolean {
  const normalized = canonicalizeMutationToolName(normalizeLowercaseStringOrEmpty(toolName));
  const record = asRecord(args);
  const action = normalizeActionName(record?.action);

  switch (normalized) {
    case "write":
    case "edit":
    case "apply_patch":
    case "sessions_spawn":
    case "sessions_send":
    case "conversations_send":
    case "conversations_turn":
    case "create_goal":
    case "update_goal":
      return true;
    case "exec":
    case "bash":
      return !isPlainReadOnlyShellCommand(readShellCommand(record));
    case "process":
      return action != null && PROCESS_MUTATING_ACTIONS.has(action);
    case "message":
      // Message actions are an extensible plugin surface. Only known lookup
      // actions are replay-safe; missing and future actions fail closed.
      return action == null || !MESSAGE_READ_ONLY_ACTIONS.has(action);
    case "sessions":
      return action !== "group_list";
    case "computer":
      return !isComputerObservationAction(action, record?.dialogAction);
    case "mobile_ui":
      return action == null || !MOBILE_UI_REPLAY_SAFE_ACTIONS.has(action);
    case "subagents":
      return action === "cancel" || action === "kill" || action === "steer";
    case "session_status":
      return typeof record?.model === "string" && record.model.trim().length > 0;
    case "gateway":
      return action == null || !GATEWAY_REPLAY_SAFE_ACTIONS.has(action);
    case "portal":
      return action !== "list";
    case "nodes":
      return action == null || !NODES_REPLAY_SAFE_ACTIONS.has(action);
    default: {
      if (isAutomationsToolName(normalized) || normalized === "canvas") {
        return action == null || !READ_ONLY_ACTIONS.has(action);
      }
      if (normalized.endsWith("_actions")) {
        return action == null || !READ_ONLY_ACTIONS.has(action);
      }
      if (normalized.startsWith("message_") || normalized.includes("send")) {
        return true;
      }
      return false;
    }
  }
}

/** Return true only for tool calls whose structured contract proves replay safety. */
export function isReplaySafeToolCall(toolName: string, args: unknown): boolean {
  const normalized = canonicalizeMutationToolName(normalizeLowercaseStringOrEmpty(toolName));
  const record = asRecord(args);
  const action = normalizeActionName(record?.action);
  if (REPLAY_SAFE_TOOL_NAMES.has(normalized)) {
    return true;
  }
  switch (normalized) {
    case "exec":
    case "bash":
      return false;
    case "process":
      return action != null && PROCESS_REPLAY_SAFE_ACTIONS.has(action);
    case "message":
      return action != null && MESSAGE_READ_ONLY_ACTIONS.has(action);
    case "subagents":
      return action == null || action === "list";
    case "sessions":
      return action === "group_list";
    case "session_status":
      return !isMutatingToolCall(normalized, args);
    case "browser":
      return action != null && BROWSER_READ_ONLY_ACTIONS.has(action);
    case "computer":
      return isComputerObservationAction(action, record?.dialogAction);
    case "mobile_ui":
      return action != null && MOBILE_UI_REPLAY_SAFE_ACTIONS.has(action);
    case "skill_workshop":
      return action === "list" || action === "inspect" || action === "read";
    case "transcripts":
      return action === "status";
    case "gateway":
      return action != null && GATEWAY_REPLAY_SAFE_ACTIONS.has(action);
    case "portal":
      return action === "list";
    case "nodes":
      return action != null && NODES_REPLAY_SAFE_ACTIONS.has(action);
    default: {
      if (isAutomationsToolName(normalized) || normalized === "canvas") {
        return action != null && READ_ONLY_ACTIONS.has(action);
      }
      return false;
    }
  }
}

export function buildToolMutationState(
  toolName: string,
  args: unknown,
  options?: { ownerKey?: string },
): ToolMutationState {
  const ownerDeclaredMutation = options?.ownerKey !== undefined;
  return {
    mutatingAction: ownerDeclaredMutation || isMutatingToolCall(toolName, args),
    replaySafe: ownerDeclaredMutation ? false : isReplaySafeToolCall(toolName, args),
  };
}
