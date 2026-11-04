const DOUBLE_QUOTE_ESCAPES = new Set(["\\", '"', "$", "`", "\n", "\r"]);

// POSIX double quotes only consume the backslash before a small escape set;
// preserving other backslashes keeps command-risk analysis byte-faithful.
function isDoubleQuoteEscape(next: string | undefined): next is string {
  return Boolean(next && DOUBLE_QUOTE_ESCAPES.has(next));
}

/** Returns whether a shell string contains an unquoted command separator or pipeline operator. */
export function hasTopLevelShellControlOperator(raw: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let wordStart = true;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charAt(i);
    if (escaped) {
      escaped = false;
      wordStart = false;
      continue;
    }
    if (quote) {
      if (quote === '"' && ch === "\\" && isDoubleQuoteEscape(raw[i + 1])) {
        i += 1;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      wordStart = false;
      continue;
    }
    if (ch === "#" && wordStart) {
      return /[\r\n]/u.test(raw.slice(i + 1));
    }
    if (ch === "&" && (raw[i - 1] === ">" || raw[i - 1] === "<")) {
      wordStart = false;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "\r") {
      return true;
    }
    wordStart = /\s/u.test(ch);
  }

  return false;
}

/** Splits a shell-like argv string into tokens, returning null for unterminated quotes or escapes. */
export function splitShellArgs(raw: string, options?: { literalOnly?: boolean }): string[] | null {
  return splitQuotedArgs(raw, "shell", false, options?.literalOnly);
}

/** Groups quoted process arguments, preserving literal backslashes and hash characters. */
export function splitCommandArgs(raw: string, options: { allowUnclosedQuotes: true }): string[];
export function splitCommandArgs(
  raw: string,
  options?: { allowUnclosedQuotes?: boolean },
): string[] | null;
export function splitCommandArgs(
  raw: string,
  options?: { allowUnclosedQuotes?: boolean },
): string[] | null {
  return splitQuotedArgs(raw, "command", options?.allowUnclosedQuotes);
}

function splitQuotedArgs(
  raw: string,
  syntax: "shell" | "command",
  allowUnclosedQuotes = false,
  literalOnly = false,
): string[] | null {
  const backslashEscapes = syntax === "shell";
  const tokens: string[] = [];
  let buf = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;

  const pushToken = () => {
    if (buf.length > 0 || (literalOnly && started)) {
      tokens.push(buf);
      buf = "";
    }
    started = false;
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charAt(i);
    if (literalOnly && (ch === "\0" || (escaped && /[\r\n]/u.test(ch)))) {
      return null;
    }
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (backslashEscapes && !quote && ch === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      const next = raw[i + 1];
      // Inside double quotes, only POSIX-recognized escapes consume the backslash.
      if (quote === '"' && backslashEscapes && ch === "\\" && isDoubleQuoteEscape(next)) {
        if (literalOnly && /[\r\n]/u.test(next)) {
          return null;
        }
        buf += next;
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = undefined;
      } else {
        if (literalOnly && quote === '"' && (ch === "$" || ch === "`")) {
          return null;
        }
        buf += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    // Credential-bearing direct commands may contain only literal arguments:
    // expansions, control syntax and redirects are shell work, quoted text is data.
    if (literalOnly && /[;&|<>()`$\r\n*?[\]{}~]/u.test(ch)) {
      return null;
    }
    // In POSIX shells, "#" starts a comment only when it begins a word; keep
    // inline hashes inside tokens so URLs/fragments are not truncated.
    if (syntax === "shell" && ch === "#" && buf.length === 0 && (!literalOnly || !started)) {
      if (literalOnly) {
        return null;
      }
      break;
    }
    if (literalOnly ? ch === " " || ch === "\t" : /\s/.test(ch)) {
      pushToken();
      continue;
    }
    buf += ch;
    started = true;
  }

  if (escaped || (!allowUnclosedQuotes && quote)) {
    return null;
  }
  pushToken();
  return tokens;
}
