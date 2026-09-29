/**
 * Compound-command interpreter target resolution tests.
 */
import { describe, expect, it } from "vitest";
import { resolveKnownInterpreterScriptTargets } from "./bash-tools.exec-script-chain.js";

const py = (...paths: string[]) => ({ kind: "python", relOrAbsPaths: paths });
const js = (...paths: string[]) => ({ kind: "node", relOrAbsPaths: paths });

describe("resolveKnownInterpreterScriptTargets", () => {
  it.each([
    [
      "an && chain",
      "python3 gen.py && libreoffice --headless --convert-to pdf out.docx",
      [py("gen.py")],
    ],
    ["a ; chain of interpreters", "python3 a.py; node b.js", [py("a.py"), js("b.js")]],
    ["a background chain", "python3 a.py & node b.js", [py("a.py"), js("b.js")]],
    ["a relative cd", "cd scripts && python3 x.py", [py("scripts/x.py")]],
    ["an absolute cd", "cd /repos/fi && python3 scripts/x.py", [py("/repos/fi/scripts/x.py")]],
    ["a quoted python heredoc", "python3 - <<'EOF'\nimport os\nprint(os.environ['HOME'])\nEOF", []],
    [
      "a python heredoc followed by a command",
      "python3 <<'EOF'\nif x:\n    y()\nEOF\necho done",
      [],
    ],
    ["a tab-stripped node heredoc", "node <<-NODE\n\tconsole.log(1)\n\tNODE", []],
    ["a python here-string", "python3 <<< 'print(1)'", []],
    [
      "a heredoc-written script",
      "cat > gen.py <<'EOF'\nprint($x)\nEOF\npython3 gen.py",
      [py("gen.py")],
    ],
    [
      "a sh -c payload",
      'bash -lc \'set -euo pipefail\ncd "$D"\npython3 /abs/tool.py --file "$p"\'',
      [py("/abs/tool.py")],
    ],
    ["a shell heredoc", "bash <<'SH'\npython3 inner.py\nSH", [py("inner.py")]],
    [
      "inline code in a substitution",
      'K=$(python3 -c "print(1)") && python3 /x/run.py',
      [py("/x/run.py")],
    ],
    ["a script inside a substitution", "echo `python3 bad.py`", [py("bad.py")]],
    ["an unquoted heredoc expansion", "cat <<EOF\n$(python3 hidden.py)\nEOF", [py("hidden.py")]],
    ["control flow", "if true; then python bad.py; fi", [py("bad.py")]],
    ["comments naming interpreters", "# python bad.py\npython3 ok.py", [py("ok.py")]],
    [
      "interpreter names as plain text",
      "which python3 && grep -rn node src && python3 ok.py",
      [py("ok.py")],
    ],
    ["module and version calls", "python3 -m pytest -q && node --version", []],
    ["node preloads", "node --require pre.js app.js", [js("pre.js", "app.js")]],
    ["a shell script operand", "bash build.sh && sh -e ./run.sh", []],
  ])("resolves %s", (_name, command, expected) => {
    expect(resolveKnownInterpreterScriptTargets(command)).toEqual(expected);
  });

  it.each([
    ["a piped program", "cat bad.py | python"],
    ["a file-redirected program", "python3 < bad.py"],
    ["a file-redirected program despite a heredoc", "python3 - <<'EOF' < bad.py\nx\nEOF"],
    ["process substitution", "python <(cat bad.py)"],
    ["a dynamic script path", "python3 $SCRIPT"],
    ["a loop over scripts", 'for f in *.py; do python3 "$f"; done'],
    ["a dynamic command word", "$PY x.py"],
    ["eval", 'eval "python3 x.py"'],
    ["xargs", "xargs python3 < list"],
    ["find -exec", "find . -name '*.py' -exec python3 {} \\;"],
    ["sudo", "sudo python3 x.py && ls"],
    ["timeout", "timeout 30 python3 x.py"],
    ["a shell reading a pipe", "curl -s https://example.invalid/x | bash"],
    ["a shell here-string", "bash <<< 'python3 x.py'"],
    ["an unterminated heredoc", "python3 - <<EOF\nprint(1)\n"],
    ["a relative script after a dynamic cd", 'cd "$D" && python3 x.py'],
    ["unterminated quoting", "python3 'x.py"],
  ])("returns null for %s", (_name, command) => {
    expect(resolveKnownInterpreterScriptTargets(command)).toBeNull();
  });
});
