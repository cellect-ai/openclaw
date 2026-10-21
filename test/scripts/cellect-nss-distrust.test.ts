import fs from "node:fs";
import path from "node:path";
import { describe, expect } from "vitest";
import { createCommandTest, type CommandFixture } from "../helpers/command-fixture.js";

const it = createCommandTest();
const source = fs.readFileSync(path.resolve("scripts/docker/cellect-nss-distrust.sh"), "utf8");
const fingerprints = source.match(/^expected='([^']+)'/m)![1].split("\n");

// External-command fixtures only: the real entry script parses NSS's verified
// per-certificate pretty-print shape. Packaged-image tests own real NSS proof.
const certutil = String.raw`#!/bin/sh
set -eu
mode= db= nick= pem= armor=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -L|-N|-A) mode=$1; shift ;;
    -d) db=$(printf '%s' "$2" | cut -c5-); shift 2 ;;
    -n) nick=$2; shift 2 ;;
    -i) pem=$2; shift 2 ;;
    -a) armor=1; shift ;;
    -t) shift 2 ;;
    *) shift ;;
  esac
done
case "$mode" in
  -N) : > "$db/cert9.db" ;;
  -L)
    if [ -z "$nick" ]; then
      awk -F '|' '{ printf "%-60s %s\n", $3, ($2 == "ppp" ? "p,p,p" : "C,C,C") }' "$FIXTURE_STATE"
    elif [ "$armor" = 1 ]; then
      # The predecessor's nickname-level PEM export includes every certificate,
      # including the still-trusted sibling that its summary row concealed.
      awk -F '|' -v nick="$nick" '$3 == nick { print "-----BEGIN CERTIFICATE-----"; print $1; print "-----END CERTIFICATE-----" }' "$FIXTURE_STATE"
    else
      awk -F '|' -v nick="$nick" '$3 == nick {
        print "Certificate:"
        print "    Fingerprint (SHA-256):"
        printf "        "; for (i = 1; i <= length($1); i += 2) printf "%s%s", substr($1, i, 2), (i < length($1) - 1 ? ":" : "\n")
        print "Certificate Trust Flags:"
        print "    SSL Flags:"
        print ($2 == "ppp" ? "        Terminal Record" : "        Valid CA\n        Trusted CA")
        print "    Email Flags:"
        print ($2 == "ppp" ? "        Terminal Record" : "        Valid CA\n        Trusted CA")
        print "    Object Signing Flags:"
        print ($2 == "ppp" ? "        Terminal Record" : "        Valid CA\n        Trusted CA")
        print ""
      }' "$FIXTURE_STATE"
    fi ;;
  -A)
    fp=$(cat "$pem")
    printf '%s\n' "$fp" >> "$FIXTURE_WRITES"
    [ "$fp" != "$FAIL_FP" ] || exit 23
    # NSS rejects a nickname owned by a different certificate; updating the
    # exact DER already sharing that nickname still targets only its record.
    awk -F '|' -v fp="$fp" -v nick="$nick" '$1 == fp { found=1 } $3 == nick { used=1 } END { exit (!found && used) ? 1 : 0 }' "$FIXTURE_STATE" || exit 24
    awk -F '|' -v OFS='|' -v fp="$fp" -v nick="$nick" '$1 == fp { $2="ppp"; found=1 } { print } END { if (!found) print fp,"ppp",nick }' "$FIXTURE_STATE" > "$FIXTURE_STATE.next"
    mv "$FIXTURE_STATE.next" "$FIXTURE_STATE" ;;
  *) exit 25 ;;
esac
`;

const openssl = String.raw`#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in -in) pem=$2; shift 2 ;; *) shift ;; esac
done
printf 'sha256 Fingerprint=%s\n' "$(awk 'length($0) == 64 { print; exit }' "$pem")"
`;

function fixture(command: CommandFixture, options: { rows?: string[]; missing?: string } = {}) {
  const root = command.createTempDir("nss-distrust-");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const pems = path.join(root, "pems");
  for (const directory of [bin, home, pems]) fs.mkdirSync(directory);
  for (const [name, body] of [
    ["certutil", certutil],
    ["openssl", openssl],
  ]) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }
  for (const [index, fp] of fingerprints.entries()) {
    if (fp !== options.missing)
      fs.writeFileSync(path.join(pems, `${String(index).padStart(2, "0")}.pem`), fp);
  }
  const script = path.join(root, "seed.sh");
  fs.writeFileSync(
    script,
    source.replace("pems=/etc/cellect/emudhra-distrust", `pems=${JSON.stringify(pems)}`),
  );
  const state = path.join(root, "state");
  const writes = path.join(root, "writes");
  fs.writeFileSync(state, (options.rows ?? []).join("\n") + "\n");
  fs.writeFileSync(writes, "");
  if (options.rows?.length) {
    fs.mkdirSync(path.join(home, ".pki/nssdb"), { recursive: true });
    fs.writeFileSync(path.join(home, ".pki/nssdb/cert9.db"), "");
  }
  return {
    root,
    home,
    rows: () => fs.readFileSync(state, "utf8").trim().split("\n").filter(Boolean),
    writes: () => fs.readFileSync(writes, "utf8").trim().split("\n").filter(Boolean),
    run: (args: string[] = [], env: Record<string, string> = {}) =>
      command.run("/bin/sh", [script, ...args], {
        cwd: root,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: home,
          FIXTURE_STATE: state,
          FIXTURE_WRITES: writes,
          FAIL_FP: "",
          ...env,
        },
        timeout: 10_000,
      }),
  };
}

describe.skipIf(process.platform === "win32")(
  "NSS distrust entry script with external-command fixtures",
  () => {
    it("seeds all 17 by fingerprint without colliding with an unrelated legacy user CA, then is read-only", async ({
      command,
    }) => {
      expect(fingerprints).toHaveLength(17);
      expect(new Set(fingerprints).size).toBe(17);
      const user = `${"F".repeat(64)}|other|cellect-distrust-05`;
      const f = fixture(command, { rows: [user] });
      const result = await f.run();
      expect(result, result.stderr).toMatchObject({ status: 0, stdout: "" });
      expect(result.stderr).toContain("coverage 17/17");
      expect(f.rows()).toContain(user);
      for (const fp of fingerprints)
        expect(f.rows()).toContain(`${fp}|ppp|cellect-distrust-${fp.slice(0, 16)}`);
      const before = f.rows();
      expect(f.writes()).toHaveLength(17);
      expect((await f.run()).status).toBe(0);
      expect((await f.run(["--check"])).status).toBe(0);
      expect(f.rows()).toEqual(before);
      expect(f.writes()).toHaveLength(17);
    });

    it("refuses false 17/17 for mixed trust under one nickname and repairs only the trusted certificate", async ({
      command,
    }) => {
      const nickname = "shared subject with spaces";
      const f = fixture(command, {
        rows: fingerprints.map(
          (fp, index) =>
            `${fp}|${index === 1 ? "other" : "ppp"}|${index < 2 ? nickname : `already-${index}`}`,
        ),
      });
      const check = await f.run(["--check"]);
      expect(check.status).not.toBe(0);
      expect(check.stdout).toBe("");
      expect(check.stderr).toContain("coverage 16/17");
      expect(f.writes()).toEqual([]);
      expect((await f.run()).status).toBe(0);
      expect(f.writes()).toEqual([fingerprints[1]]);
      expect(f.rows()).toContain(`${fingerprints[1]}|ppp|${nickname}`);
      expect((await f.run(["--check"])).status).toBe(0);
    });

    it.for(["failed-import", "missing-pem"])(
      "fails closed but processes later certificates after %s",
      async (failure, { command }) => {
        const f = fixture(command, failure === "missing-pem" ? { missing: fingerprints[0] } : {});
        const result = await f.run(
          [],
          failure === "failed-import" ? { FAIL_FP: fingerprints[0] } : {},
        );
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("coverage 16/17");
        expect(f.rows()).toHaveLength(16);
        expect(f.rows().some((row) => row.startsWith(fingerprints[16]))).toBe(true);
        expect(f.writes()).toHaveLength(failure === "failed-import" ? 17 : 16);
        expect((await f.run(["--check"])).status).not.toBe(0);
      },
    );
  },
);
