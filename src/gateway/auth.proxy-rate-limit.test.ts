// Shared-secret limiter keying for proxied clients: the bucket belongs to the
// attributed client (or a verified device subject), never to the proxy address
// and never to a forwarded claim from an untrusted peer.
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { buildRateLimitIdentityKey, createAuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeWsControlUiGatewayConnect } from "./auth.js";
import { PROXY_ATTRIBUTION_REQUIRED_REASON } from "./ingress-attribution.js";

const PROXY = "192.168.5.10";
const CLIENT_A = "203.0.113.10";
const CLIENT_B = "203.0.113.20";
const SCOPE = "shared-secret";
const auth = { mode: "token" as const, token: "secret", allowTailscale: false };

const limiter = createAuthRateLimiter({
  maxAttempts: 2,
  windowMs: 60_000,
  lockoutMs: 60_000,
  pruneIntervalMs: 0,
});

afterEach(() => {
  for (const key of [PROXY, CLIENT_A, CLIENT_B]) {
    limiter.reset(key, SCOPE);
  }
  limiter.reset(buildRateLimitIdentityKey("device", "device-b"), SCOPE);
});

function req(remoteAddress: string, forwardedFor?: string): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
  } as unknown as IncomingMessage;
}

async function attempt(params: {
  remoteAddress: string;
  forwardedFor?: string;
  token: string;
  trustedProxies?: string[];
  rateLimitSubject?: string;
}) {
  return await authorizeWsControlUiGatewayConnect({
    auth,
    connectAuth: { token: params.token },
    req: req(params.remoteAddress, params.forwardedFor),
    trustedProxies: params.trustedProxies ?? [PROXY],
    rateLimiter: limiter,
    rateLimitSubject: params.rateLimitSubject,
  });
}

describe("shared-secret limiter keying behind a reverse proxy", () => {
  it("keys failures on the forwarded client, not on the trusted proxy", async () => {
    for (let i = 0; i < 2; i += 1) {
      await expect(
        attempt({ remoteAddress: PROXY, forwardedFor: CLIENT_A, token: "wrong" }),
      ).resolves.toMatchObject({ ok: false, reason: "token_mismatch" });
    }
    await expect(
      attempt({ remoteAddress: PROXY, forwardedFor: CLIENT_A, token: "secret" }),
    ).resolves.toMatchObject({ ok: false, reason: "rate_limited" });

    await expect(
      attempt({ remoteAddress: PROXY, forwardedFor: CLIENT_B, token: "secret" }),
    ).resolves.toMatchObject({ ok: true, method: "token" });
    expect(limiter.check(PROXY, SCOPE).remaining).toBe(2);
  });

  it("refuses a forwarded claim from an untrusted peer without touching the claimed bucket", async () => {
    await expect(
      attempt({
        remoteAddress: "198.51.100.7",
        forwardedFor: CLIENT_B,
        token: "wrong",
        trustedProxies: [PROXY],
      }),
    ).resolves.toMatchObject({ ok: false, reason: PROXY_ATTRIBUTION_REQUIRED_REASON });
    expect(limiter.check(CLIENT_B, SCOPE).remaining).toBe(2);
  });

  it("keeps direct clients keyed on the socket peer", async () => {
    for (let i = 0; i < 2; i += 1) {
      await attempt({ remoteAddress: CLIENT_A, token: "wrong", trustedProxies: [] });
    }
    await expect(
      attempt({ remoteAddress: CLIENT_A, token: "secret", trustedProxies: [] }),
    ).resolves.toMatchObject({ ok: false, reason: "rate_limited" });
    await expect(
      attempt({ remoteAddress: CLIENT_B, token: "secret", trustedProxies: [] }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("uses a verified device subject in place of the shared client address", async () => {
    const deviceKey = buildRateLimitIdentityKey("device", "device-b");
    for (let i = 0; i < 2; i += 1) {
      await attempt({ remoteAddress: PROXY, forwardedFor: CLIENT_A, token: "wrong" });
    }
    expect(limiter.check(CLIENT_A, SCOPE).allowed).toBe(false);

    await expect(
      attempt({
        remoteAddress: PROXY,
        forwardedFor: CLIENT_A,
        token: "secret",
        rateLimitSubject: deviceKey,
      }),
    ).resolves.toMatchObject({ ok: true, method: "token" });

    for (let i = 0; i < 2; i += 1) {
      await attempt({
        remoteAddress: PROXY,
        forwardedFor: CLIENT_B,
        token: "wrong",
        rateLimitSubject: deviceKey,
      });
    }
    await expect(
      attempt({
        remoteAddress: PROXY,
        forwardedFor: CLIENT_B,
        token: "secret",
        rateLimitSubject: deviceKey,
      }),
    ).resolves.toMatchObject({ ok: false, reason: "rate_limited" });
    expect(limiter.check(CLIENT_B, SCOPE).remaining).toBe(2);
  });
});
