import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { runQaGatewayCliCommand } from "./gateway-child-command.js";
import { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";
import { formatQaGatewayProcessBoundaryStartupFailure } from "./gateway-child-process.js";

export function registerGatewayCommandFailureCases() {
  describe("runQaGatewayCliCommand", () => {
    it("retains bounded redacted stdout failures alongside stderr panels", async () => {
      const lifetime = new QaGatewayChildLifecycle();
      try {
        const error = await runQaGatewayCliCommand({
          lifetime,
          executablePath: process.execPath,
          argsPrefix: [
            "--input-type=module",
            "--eval",
            `await new Promise((resolve) => process.stderr.write(
            "Doctor panel: Authorization: Bearer fixture-panel-secret\\n" + "diagnostic ".repeat(400), resolve));
          await new Promise((resolve) => process.stdout.write(JSON.stringify({
            status: "error", reason: "readiness execution failed", apiKey: "fixture-result-secret",
          }), resolve));
          process.exit(7);`,
          ],
          args: [],
          cwd: process.cwd(),
          env: process.env,
        }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) {
          throw new Error("expected CLI failure");
        }
        expect(error.message).toContain("OpenClaw CLI exited 7: Doctor panel:");
        expect(error.message).toContain('"reason":"readiness execution failed"');
        expect(error.message.length).toBeLessThanOrEqual(2_048);
        expect(error.message).toContain("Bearer <redacted>");
        expect(error.message).toContain('"apiKey":"<redacted>"');
        expect(inspect(error, { depth: null })).not.toMatch(/fixture-(panel|result)-secret/u);
      } finally {
        await expect(lifetime.stop()).resolves.toEqual({
          process: "confirmed-stopped",
          errors: [],
        });
      }
    });
  });

  describe("formatQaGatewayProcessBoundaryStartupFailure", () => {
    it("includes only a bounded, redacted launcher log tail", () => {
      const prefix = "x".repeat(9_000);
      const longSecret = "s".repeat(9_000);
      const message = formatQaGatewayProcessBoundaryStartupFailure(
        new Error("launcher exited before identity"),
        `${prefix}\nAuthorization: Bearer ${longSecret}\nlauncher stage=mount-proc`,
      );

      expect(message).toContain("launcher exited before identity");
      expect(message).toContain("Gateway logs:");
      expect(message).toContain("Authorization: Bearer <redacted>");
      expect(message).toContain("launcher stage=mount-proc");
      expect(message).not.toContain("s".repeat(100));
      expect(message).not.toContain(prefix);
    });
  });
}
