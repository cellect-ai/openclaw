/**
 * Resolves every Python/Node script a sandboxed shell command will run.
 *
 * The fail-closed interpreter preflight refuses compound commands because the
 * direct-command parser can only see one script. This resolver walks chains
 * (`&&`, `||`, `;`, newlines, subshells), heredocs, command substitutions and
 * `sh -c` payloads, and returns the script targets of every interpreter call.
 * It returns null whenever any interpreter's program cannot be pinned down
 * (program read from a pipe or file redirect, dynamic script path or command
 * word, process substitution, interpreter hidden behind a wrapper such as
 * `xargs`/`sudo`/`eval`), so callers keep failing closed on those forms.
 */
import path from "node:path";
import { splitShellArgs } from "../utils/shell-argv.js";
import { extractShellWrappedCommandPayload } from "./bash-tools.exec-script-ambiguity.js";
import {
  extractInterpreterScriptTargetFromArgv,
  stripPreflightEnvPrefix,
} from "./bash-tools.exec-script-target.js";

export type ResolvedInterpreterScriptTarget = {
  kind: "python" | "node";
  relOrAbsPaths: string[];
};

type Heredoc = { body: string; quoted: boolean };
type CwdState = { known: true; dir: string } | { known: false };
type ResolveContext = { cwd: CwdState; depth: number };

const MAX_NESTING_DEPTH = 6;
const HEREDOC_MARKER_PREFIX = "__openclaw_heredoc_";
const SUBSTITUTION_PLACEHOLDER = "$__openclaw_substitution__";
const PYTHON_EXECUTABLE_RE = /^python(?:3(?:\.\d+)?)?$/u;
const SHELL_EXECUTABLE_RE = /^(?:bash|dash|ksh|sh|zsh)$/u;
const LEADING_KEYWORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "do",
  "while",
  "until",
  "time",
  "!",
  "{",
]);
const PREFIX_WRAPPERS = new Set(["exec", "nohup", "command"]);
// Commands that never execute their arguments as programs, so interpreter
// names among their arguments are plain text.
const NON_EXECUTING_COMMANDS = new Set([
  "[",
  "cat",
  "echo",
  "egrep",
  "fgrep",
  "grep",
  "head",
  "ls",
  "printf",
  "rg",
  "tail",
  "test",
  "type",
  "wc",
  "whereis",
  "which",
]);
const DYNAMIC_WORD_RE = /[$`*?[]|^~/u;

function executableName(token: string): string {
  return (token.split("/").at(-1) ?? token).toLowerCase();
}

function isProgramExecutableName(name: string): boolean {
  return PYTHON_EXECUTABLE_RE.test(name) || name === "node" || SHELL_EXECUTABLE_RE.test(name);
}

function isWordStart(out: string): boolean {
  const prev = out.at(-1);
  return prev === undefined || /[\s;&|()<>]/u.test(prev);
}

/**
 * Removes heredoc bodies and comments, leaving `<<__openclaw_heredoc_n__`
 * markers so each command segment can find the heredoc feeding it.
 */
function extractHeredocs(raw: string): { text: string; heredocs: Heredoc[] } | null {
  const heredocs: Heredoc[] = [];
  const pending: Array<{ delimiter: string; stripTabs: boolean; index: number }> = [];
  let out = "";
  let quote: "'" | '"' | null = null;
  let i = 0;
  while (i < raw.length) {
    const ch = raw.charAt(i);
    if (quote) {
      out += ch;
      if (quote === '"' && ch === "\\" && i + 1 < raw.length) {
        out += raw.charAt(i + 1);
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < raw.length) {
      out += raw.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "#" && isWordStart(out)) {
      while (i < raw.length && raw.charAt(i) !== "\n") {
        i += 1;
      }
      continue;
    }
    if (raw.startsWith("<<<", i)) {
      out += "<<<";
      i += 3;
      continue;
    }
    if (ch === "<" && raw.charAt(i + 1) === "<") {
      let j = i + 2;
      const stripTabs = raw.charAt(j) === "-";
      if (stripTabs) {
        j += 1;
      }
      while (raw.charAt(j) === " " || raw.charAt(j) === "\t") {
        j += 1;
      }
      const match = /^(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z0-9_.-]+))/u.exec(raw.slice(j));
      if (!match) {
        return null;
      }
      const delimiter = match[1] ?? match[2] ?? match[3] ?? "";
      const index = heredocs.length;
      heredocs.push({ body: "", quoted: match[3] === undefined || match[0].startsWith("\\") });
      pending.push({ delimiter, stripTabs, index });
      out += ` <<${HEREDOC_MARKER_PREFIX}${index}__ `;
      i = j + match[0].length;
      continue;
    }
    if (ch === "\n" && pending.length > 0) {
      out += ch;
      i += 1;
      for (const doc of pending.splice(0)) {
        const lines: string[] = [];
        let terminated = false;
        for (;;) {
          const end = raw.indexOf("\n", i);
          const lineEnd = end === -1 ? raw.length : end;
          let line = raw.slice(i, lineEnd).replace(/\r$/u, "");
          i = end === -1 ? raw.length : end + 1;
          if (doc.stripTabs) {
            line = line.replace(/^\t+/u, "");
          }
          if (line === doc.delimiter) {
            terminated = true;
            break;
          }
          lines.push(line);
          if (end === -1) {
            break;
          }
        }
        if (!terminated) {
          return null;
        }
        const heredoc = heredocs[doc.index];
        if (heredoc) {
          heredoc.body = lines.join("\n");
        }
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  if (quote || pending.length > 0) {
    return null;
  }
  return { text: out, heredocs };
}

function findClosingParen(raw: string, start: number): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw.charAt(i);
    if (quote) {
      if (quote === '"' && ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "\\") {
      i += 1;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** Replaces `$(...)` and backtick substitutions with a dynamic placeholder word. */
function extractCommandSubstitutions(raw: string): { text: string; bodies: string[] } | null {
  const bodies: string[] = [];
  let out = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw.charAt(i);
    if (inSingle) {
      out += ch;
      inSingle = ch !== "'";
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < raw.length) {
      out += raw.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = !inDouble;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "$" && raw.charAt(i + 1) === "(" && raw.charAt(i + 2) !== "(") {
      const close = findClosingParen(raw, i + 2);
      if (close === -1) {
        return null;
      }
      bodies.push(raw.slice(i + 2, close));
      out += SUBSTITUTION_PLACEHOLDER;
      i = close + 1;
      continue;
    }
    if (ch === "`") {
      const close = raw.indexOf("`", i + 1);
      if (close === -1) {
        return null;
      }
      bodies.push(raw.slice(i + 1, close));
      out += SUBSTITUTION_PLACEHOLDER;
      i = close + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return inSingle || inDouble ? null : { text: out, bodies };
}

/** Splits into pipelines (`;`, `&&`, `||`, `&`, newline, parens) of pipe-separated parts. */
function splitPipelines(raw: string): string[][] | null {
  const pipelines: string[][] = [];
  let parts: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  const endPart = () => {
    parts.push(buf);
    buf = "";
  };
  const endPipeline = () => {
    endPart();
    const nonEmpty = parts.filter((part) => part.trim().length > 0);
    if (nonEmpty.length > 0) {
      pipelines.push(nonEmpty);
    }
    parts = [];
  };
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charAt(i);
    const next = raw.charAt(i + 1);
    if (quote) {
      buf += ch;
      if (quote === '"' && ch === "\\") {
        buf += next;
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "\\") {
      buf += ch + next;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    if ((ch === "<" || ch === ">") && next === "(") {
      return null;
    }
    if (ch === "|") {
      if (next === "|") {
        endPipeline();
        i += 1;
      } else {
        endPart();
        if (next === "&") {
          i += 1;
        }
      }
      continue;
    }
    if (ch === "&") {
      const prev = raw.charAt(i - 1);
      if (next === "&") {
        endPipeline();
        i += 1;
      } else if (prev === ">" || prev === "<" || next === ">") {
        buf += ch;
      } else {
        endPipeline();
      }
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "\r" || ch === "(" || ch === ")") {
      endPipeline();
      continue;
    }
    buf += ch;
  }
  if (quote) {
    return null;
  }
  endPipeline();
  return pipelines;
}

type ParsedPart = {
  words: string[];
  heredocIndexes: number[];
  hasHereString: boolean;
  hasStdinFileRedirect: boolean;
};

const REDIRECTION_RE = /^(\d*)(<<<|<<|<>|<&|<|>>|>&|>\||>|&>>|&>)(.*)$/u;

function parsePart(part: string): ParsedPart | null {
  const argv = splitShellArgs(part.trim());
  if (!argv) {
    return null;
  }
  const words: string[] = [];
  const heredocIndexes: number[] = [];
  let hasHereString = false;
  let hasStdinFileRedirect = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    const redirect = REDIRECTION_RE.exec(token);
    if (!redirect) {
      words.push(token);
      continue;
    }
    const operator = redirect[2];
    let operand = redirect[3] ?? "";
    if (!operand && operator !== "<&" && operator !== ">&") {
      operand = argv[i + 1] ?? "";
      i += 1;
    }
    if (operator === "<<") {
      const marker = new RegExp(`^${HEREDOC_MARKER_PREFIX}(\\d+)__$`, "u").exec(operand);
      if (!marker) {
        return null;
      }
      heredocIndexes.push(Number(marker[1]));
    } else if (operator === "<<<") {
      hasHereString = true;
    } else if ((operator === "<" || operator === "<>") && (redirect[1] || "0") === "0") {
      hasStdinFileRedirect = true;
    }
  }
  return { words, heredocIndexes, hasHereString, hasStdinFileRedirect };
}

function stripCommandPrefix(words: string[]): string[] {
  let argv = words;
  for (;;) {
    while (argv.length > 0 && LEADING_KEYWORDS.has(argv[0] ?? "")) {
      argv = argv.slice(1);
    }
    const stripped = stripPreflightEnvPrefix(argv);
    let idx = 0;
    while (idx < stripped.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(stripped[idx] ?? "")) {
      idx += 1;
    }
    const rest = stripped.slice(idx);
    const first = rest[0];
    if (first && PREFIX_WRAPPERS.has(first) && rest[1] && !rest[1].startsWith("-")) {
      argv = rest.slice(1);
      continue;
    }
    return rest;
  }
}

/**
 * Classifies where an interpreter call without a recognised script target gets
 * its program: inline code/info flags, stdin, or a positional word that is not
 * a `.py`/`.js` path (static, or dynamic and therefore unknowable).
 */
function classifyInterpreterProgram(
  name: string,
  args: string[],
): "inline" | "stdin" | "static-operand" | "dynamic-operand" {
  const isPython = PYTHON_EXECUTABLE_RE.test(name);
  const withValue = isPython
    ? new Set(["-W", "-X", "-Q", "--check-hash-based-pycs"])
    : new Set(["-r", "--require", "--import"]);
  for (let i = 0; i < args.length; i += 1) {
    let arg = args[i] ?? "";
    if (arg === "--") {
      arg = args[i + 1] ?? "-";
    } else if (arg.startsWith("-") && arg !== "-") {
      const inline = isPython
        ? /^-[cm]/u.test(arg) || ["-V", "--version", "-h", "--help"].includes(arg)
        : /^-[epcvh]/u.test(arg) || /^--(?:eval|print|check|version|help)(?:=|$)/u.test(arg);
      if (inline) {
        return "inline";
      }
      if (withValue.has(arg)) {
        i += 1;
      }
      continue;
    }
    if (arg === "-") {
      return "stdin";
    }
    return DYNAMIC_WORD_RE.test(arg) ? "dynamic-operand" : "static-operand";
  }
  return "stdin";
}

/** Returns whether a shell invocation (without `-c`) names a script file operand. */
function shellScriptOperand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      return args[i + 1];
    }
    if (/^[-+][oO]$/u.test(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-") || arg.startsWith("+")) {
      continue;
    }
    return arg;
  }
  return undefined;
}

function resolveTargetPath(target: string, cwd: CwdState): string | null {
  if (DYNAMIC_WORD_RE.test(target)) {
    return null;
  }
  if (path.posix.isAbsolute(target)) {
    return target;
  }
  return cwd.known ? path.posix.join(cwd.dir, target) : null;
}

function applyCd(args: string[], cwd: CwdState): CwdState {
  const dir = args.find((arg) => !arg.startsWith("-"));
  if (!cwd.known || !dir || DYNAMIC_WORD_RE.test(dir)) {
    return { known: false };
  }
  return { known: true, dir: path.posix.isAbsolute(dir) ? dir : path.posix.join(cwd.dir, dir) };
}

function resolveCommand(
  command: string,
  context: ResolveContext,
): ResolvedInterpreterScriptTarget[] | null {
  if (context.depth > MAX_NESTING_DEPTH) {
    return null;
  }
  const extracted = extractHeredocs(command.replace(/\\\r?\n/gu, " "));
  if (!extracted) {
    return null;
  }
  const substituted = extractCommandSubstitutions(extracted.text);
  if (!substituted) {
    return null;
  }
  const targets: ResolvedInterpreterScriptTarget[] = [];
  const nested = (body: string, cwd: CwdState): boolean => {
    const resolved = resolveCommand(body, { cwd, depth: context.depth + 1 });
    if (resolved) {
      targets.push(...resolved);
    }
    return resolved !== null;
  };
  for (const body of substituted.bodies) {
    if (!nested(body, context.cwd)) {
      return null;
    }
  }
  for (const heredoc of extracted.heredocs) {
    if (heredoc.quoted) {
      continue;
    }
    const expansions = extractCommandSubstitutions(heredoc.body.replace(/['"]/gu, ""));
    if (!expansions || !expansions.bodies.every((body) => nested(body, context.cwd))) {
      return null;
    }
  }
  const pipelines = splitPipelines(substituted.text);
  if (!pipelines) {
    return null;
  }
  let cwd = context.cwd;
  for (const pipeline of pipelines) {
    for (const rawPart of pipeline) {
      const part = parsePart(rawPart);
      if (!part) {
        return null;
      }
      const argv = stripCommandPrefix(part.words);
      const executable = argv[0];
      if (!executable) {
        continue;
      }
      if (/[$`]/u.test(executable)) {
        return null;
      }
      const name = executableName(executable);
      const args = argv.slice(1);
      const hasInlineStdin = part.heredocIndexes.length > 0 || part.hasHereString;
      if (name === "cd" || name === "pushd") {
        cwd = applyCd(args, cwd);
        continue;
      }
      if (
        NON_EXECUTING_COMMANDS.has(name) ||
        (name === "command" && /^-[vV]$/u.test(args[0] ?? ""))
      ) {
        continue;
      }
      if (PYTHON_EXECUTABLE_RE.test(name) || name === "node") {
        const target = extractInterpreterScriptTargetFromArgv([name, ...args]);
        if (target) {
          const paths = target.relOrAbsPaths.map((entry) => resolveTargetPath(entry, cwd));
          if (paths.some((entry) => entry === null)) {
            return null;
          }
          targets.push({ kind: target.kind, relOrAbsPaths: paths as string[] });
          continue;
        }
        const program = classifyInterpreterProgram(name, args);
        if (
          program === "dynamic-operand" ||
          (program === "stdin" && (!hasInlineStdin || part.hasStdinFileRedirect))
        ) {
          return null;
        }
        continue;
      }
      if (SHELL_EXECUTABLE_RE.test(name)) {
        const payload = extractShellWrappedCommandPayload(name, args);
        if (payload !== null) {
          if (!nested(payload, cwd)) {
            return null;
          }
          continue;
        }
        const scriptOperand = shellScriptOperand(args);
        if (scriptOperand !== undefined) {
          if (DYNAMIC_WORD_RE.test(scriptOperand)) {
            return null;
          }
          continue;
        }
        if (part.heredocIndexes.length !== 1 || part.hasStdinFileRedirect) {
          return null;
        }
        const heredoc = extracted.heredocs[part.heredocIndexes[0] ?? -1];
        if (!heredoc || !nested(heredoc.body, cwd)) {
          return null;
        }
        continue;
      }
      if (name === "eval" || args.some((arg) => isProgramExecutableName(executableName(arg)))) {
        return null;
      }
    }
  }
  return targets;
}

/**
 * Returns the script targets of every Python/Node invocation in a compound
 * shell command, or null when any interpreter program cannot be identified.
 */
export function resolveKnownInterpreterScriptTargets(
  command: string,
): ResolvedInterpreterScriptTarget[] | null {
  return resolveCommand(command, { cwd: { known: true, dir: "" }, depth: 0 });
}
