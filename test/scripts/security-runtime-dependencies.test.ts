import { createRequire } from "node:module";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

it("rejects malformed URI references through the installed MCP/Ajv graph", () => {
  const sdk = createRequire(
    require.resolve("@modelcontextprotocol/sdk/validation/ajv-provider.js"),
  );
  const ajv = createRequire(sdk.resolve("ajv"));
  const uri = ajv("fast-uri");
  expect(uri.parse("%6Aavascript:alert(1)").error).toBeTruthy();
  expect(uri.parse("http://ev\til.com/p").error).toBeTruthy();
  expect(uri.serialize({ path: "javascript:alert(1)" }, { reference: "suffix" })).toBe(
    "javascript%3Aalert(1)",
  );
  expect(uri.resolve("https://example.test/a/b", uri.normalize("../x"))).toBe(
    "https://example.test/x",
  );
  const provider = new AjvJsonSchemaValidator();
  expect(() => provider.getValidator({ $id: "%6Aavascript:alert(1)", type: "object" })).toThrow();
  const validate = provider.getValidator({
    $id: "https://example.test/schemas/tool.json",
    type: "object",
    properties: { value: { $ref: "#/$defs/value" } },
    required: ["value"],
    $defs: { value: { type: "string" } },
  });
  expect(validate({ value: "ok" }).valid).toBe(true);
  expect(validate({ value: 1 }).valid).toBe(false);
});

describe("inbound mail sender identity", () => {
  const imap = createRequire(new URL("../../extensions/imap/package.json", import.meta.url));
  const mailparser = imap("mailparser");
  const consumers = ["mailparser", "mailauth"].map((name) => ({
    name,
    parser: createRequire(imap.resolve(name))("nodemailer/lib/addressparser"),
  }));
  const cases = [
    [
      "nested comment",
      "Attacker (x(y) <trusted@example.com>) <attacker@evil.example>",
      "attacker@evil.example",
    ],
    [
      "quoted angle",
      '<"trusted@example.com>"@evil.example>',
      '"trusted@example.com>"@evil.example',
    ],
    [
      "quoted group",
      'G: "a;" "<trusted@example.com>" <attacker@evil.example>;',
      "attacker@evil.example",
    ],
  ] as const;
  it.each(cases)("preserves the real sender across %s parsing", async (_, header, expected) => {
    for (const { parser } of consumers) {
      const parsed = parser(header, { flatten: true });
      expect(parsed).toHaveLength(1);
      expect(parsed[0].address).toBe(expected);
    }
    const mail = await mailparser.simpleParser(
      ["From: " + header, "To: reader@example.com", "Subject: parser boundary", "", "hello"].join(
        "\r\n",
      ),
    );
    const senders = mail.from.value.flatMap(
      (entry: { group?: unknown[] }) => entry.group ?? [entry],
    );
    expect(senders).toHaveLength(1);
    expect(senders[0].address).toBe(expected);
  });
  it("authenticates the same nested-comment sender domain", async () => {
    const raw = Buffer.from(
      ["From: " + cases[0][1], "To: reader@example.com", "", "hello"].join("\r\n"),
    );
    const result = await imap("mailauth").authenticate(raw, {
      disableArc: true,
      disableBimi: true,
      resolver: async () => [],
    });
    expect(result.dkim.headerFrom[0]).toBe("attacker@evil.example");
  });
});
