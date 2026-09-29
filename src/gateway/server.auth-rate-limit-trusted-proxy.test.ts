// Shared-secret auth throttling behind a trusted reverse proxy: every client
// reaches the gateway from the proxy's address, so the limiter must key on the
// forwarded client (and on a proven paired device) or one misbehaving client
// locks out all of them.
import { afterEach, describe, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import {
  BACKEND_GATEWAY_CLIENT,
  connectReq,
  installGatewayTestHooks,
  openWs,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const CLIENT_A = "203.0.113.10";
const CLIENT_B = "203.0.113.20";
const MAX_ATTEMPTS = 2;

async function configureProxiedTokenAuth(): Promise<void> {
  const auth = {
    mode: "token" as const,
    token: "secret",
    rateLimit: { maxAttempts: MAX_ATTEMPTS, windowMs: 60_000, lockoutMs: 60_000 },
  };
  testState.gatewayAuth = auth;
  // The test client dials loopback, which stands in for the reverse proxy.
  await writeConfigFile({ gateway: { auth, trustedProxies: ["127.0.0.1"] } });
}

async function connectThroughProxy(
  port: number,
  forwardedFor: string,
  opts: Parameters<typeof connectReq>[1],
) {
  const ws = await openWs(port, {
    "x-forwarded-for": forwardedFor,
    "x-forwarded-proto": "https",
    "x-forwarded-host": "gateway.example.com",
  });
  try {
    return await connectReq(ws, { client: BACKEND_GATEWAY_CLIENT, ...opts });
  } finally {
    ws.close();
  }
}

function authReason(res: Awaited<ReturnType<typeof connectReq>>): string | undefined {
  return (res.error?.details as { authReason?: string } | undefined)?.authReason;
}

async function exhaustAnonymous(port: number, forwardedFor: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const res = await connectThroughProxy(port, forwardedFor, { token: "wrong", device: null });
    expect(authReason(res)).toBe("token_mismatch");
  }
  const locked = await connectThroughProxy(port, forwardedFor, { token: "wrong", device: null });
  expect(authReason(locked)).toBe("rate_limited");
}

describe("shared-secret rate limit behind a trusted proxy", () => {
  test("one forwarded client's failures do not lock out another client of the same proxy", async () => {
    await configureProxiedTokenAuth();
    await withGatewayServer(async ({ port }) => {
      await exhaustAnonymous(port, CLIENT_A);

      const other = await connectThroughProxy(port, CLIENT_B, { token: "secret", device: null });
      expect(authReason(other)).not.toBe("rate_limited");
      expect(other.ok).toBe(true);
    });
  });

  test("the failing forwarded client itself stays locked out, even with the right token", async () => {
    await configureProxiedTokenAuth();
    await withGatewayServer(async ({ port }) => {
      await exhaustAnonymous(port, CLIENT_A);

      const retry = await connectThroughProxy(port, CLIENT_A, { token: "secret", device: null });
      expect(retry.ok).toBe(false);
      expect(authReason(retry)).toBe("rate_limited");
    });
  });

  test("a client-supplied forwarded chain cannot move failures onto another client", async () => {
    await configureProxiedTokenAuth();
    await withGatewayServer(async ({ port }) => {
      // The proxy appends the real peer; the spoofed entries to its left are
      // the client's own claim and must not select the limiter bucket.
      for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt += 1) {
        await connectThroughProxy(port, `${CLIENT_B}, 198.51.100.${attempt}, ${CLIENT_A}`, {
          token: "wrong",
          device: null,
        });
      }
      const spoofer = await connectThroughProxy(port, CLIENT_A, { token: "secret", device: null });
      expect(authReason(spoofer)).toBe("rate_limited");

      const victim = await connectThroughProxy(port, CLIENT_B, { token: "secret", device: null });
      expect(victim.ok).toBe(true);
    });
  });

  test("a paired device is keyed on its own bucket, and a bad device is still throttled", async () => {
    await configureProxiedTokenAuth();
    const goodDevice = tempDirs.make("openclaw-proxy-rl-good-") + "/device.json";
    const badDevice = tempDirs.make("openclaw-proxy-rl-bad-") + "/device.json";
    const freshDevice = tempDirs.make("openclaw-proxy-rl-fresh-") + "/device.json";
    await withGatewayServer(async ({ port }) => {
      // Pair both devices before anything fails.
      for (const deviceIdentityPath of [goodDevice, badDevice]) {
        const paired = await connectThroughProxy(port, CLIENT_A, {
          token: "secret",
          deviceIdentityPath,
          prePairDevice: true,
        });
        expect(paired.ok).toBe(true);
      }

      // An anonymous client exhausts the shared forwarded address (a NAT or a
      // proxy that cannot tell its clients apart)...
      await exhaustAnonymous(port, CLIENT_A);

      // ...which must not refuse a paired device that authenticates correctly.
      const good = await connectThroughProxy(port, CLIENT_A, {
        token: "secret",
        deviceIdentityPath: goodDevice,
      });
      expect(good.ok).toBe(true);

      // A paired device presenting the wrong token is throttled on its own key.
      const badReasons: Array<string | undefined> = [];
      for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const res = await connectThroughProxy(port, CLIENT_B, {
          token: "wrong",
          deviceIdentityPath: badDevice,
        });
        expect(res.ok).toBe(false);
        badReasons.push(authReason(res));
      }
      expect(badReasons.at(-1)).toBe("rate_limited");
      expect(badReasons.slice(0, MAX_ATTEMPTS)).not.toContain("rate_limited");
      const badRetry = await connectThroughProxy(port, CLIENT_B, {
        token: "secret",
        deviceIdentityPath: badDevice,
      });
      expect(authReason(badRetry)).toBe("rate_limited");

      // The bad device's lockout does not spill onto another device or address.
      const goodAgain = await connectThroughProxy(port, CLIENT_B, {
        token: "secret",
        deviceIdentityPath: goodDevice,
      });
      expect(goodAgain.ok).toBe(true);

      // An unpaired keypair gets no bucket of its own: it stays on the locked
      // client address, so minting identities cannot buy fresh attempts.
      const fresh = await connectThroughProxy(port, CLIENT_A, {
        token: "wrong",
        deviceIdentityPath: freshDevice,
      });
      expect(authReason(fresh)).toBe("rate_limited");
    });
  });
});
