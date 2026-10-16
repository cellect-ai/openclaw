// Temporary builder-provenance diagnostic for the pairing-cli phantom tsgo
// errors (gates-2/3/4 report lastSeenAt literals at lines absent from the
// shipped tree). Prints the builder's actual bytes, then gets deleted.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

describe("builder provenance", () => {
  it("prints pairing-cli bytes", () => {
    const raw = readFileSync("src/cli/pairing-cli.ts", "utf8");
    const lines = raw.split("\n");
    console.log(
      `BUILDER-PROOF md5=${createHash("md5").update(raw).digest("hex")}` +
        ` lines=${lines.length}` +
        ` lastSeenAt=${raw.match(/lastSeenAt/g)?.length ?? 0}`,
    );
    console.log(`BUILDER-PROOF l128=${JSON.stringify(lines[127])}`);
    console.log(`BUILDER-PROOF l146=${JSON.stringify(lines[145])}`);
    console.log(`BUILDER-PROOF l149=${JSON.stringify(lines[148])}`);
  });
});
