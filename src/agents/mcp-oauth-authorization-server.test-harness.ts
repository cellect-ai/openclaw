import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

function sendOAuthJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readOAuthBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startAuthorizationServer() {
  const requests: string[] = [];
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", issuer);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      sendOAuthJson(response, { resource: `${issuer}/mcp`, authorization_servers: [issuer] });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      sendOAuthJson(response, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const body = await readOAuthBody(request);
      requests.push(body);
      const metadata = JSON.parse(body) as Record<string, unknown>;
      sendOAuthJson(response, { ...metadata, client_id: "fixture-client" }, 201);
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const body = await readOAuthBody(request);
      requests.push(body);
      const form = new URLSearchParams(body);
      const challenge = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      if (form.get("code") !== challenge) {
        sendOAuthJson(response, { error: "invalid_grant" }, 400);
        return;
      }
      sendOAuthJson(response, {
        access_token: `access-${challenge.slice(0, 8)}`,
        refresh_token: "fixture-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      });
      return;
    }
    response.writeHead(404).end();
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error("OAuth fixture failed"));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const issuer = `http://127.0.0.1:${address.port}`;
  return {
    issuer,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export function authorizationCode(authorizationUrl: string): string {
  const code = new URL(authorizationUrl).searchParams.get("code_challenge");
  if (!code) {
    throw new Error("authorization URL omitted the PKCE challenge");
  }
  return code;
}
