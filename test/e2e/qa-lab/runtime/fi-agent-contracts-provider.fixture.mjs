import http from "node:http";

// This container has only fixture data and an internal Docker network. It has
// no DB, provider SDK, delivery transport, requester credential or host mount.
const calls = [];
const tenant = "shape";
const orgId = "11111111-1111-4111-8111-111111111111";
const caseId = "22222222-2222-4222-8222-222222222222";
const deliveryId = "33333333-3333-4333-8333-333333333333";
const members = { U0000000001: "a@fixture.test", U0000000002: "b@fixture.test" };
const tokens = new Map();
function mint(sender) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 540;
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: members[sender], orgId, org_slug: tenant, agent_id: "cellect-fi-admin", slack_user_id: sender, iss: "fi-openclaw-user-delegation", aud: "fi-openclaw-user-api", iat: issuedAt, exp: expiresAt })}.${Buffer.from("fixture-only-not-a-real-signature").toString("base64url")}`;
  tokens.set(sender, token);
  return { token, expiresAt };
}
function vendor(id, name, role, contactName, email) {
  const contact = {
    id,
    vendorId: String(id),
    name: contactName,
    role: null,
    email,
    phone: null,
    source: "synthetic-fixture",
    projectRoles: [role],
    isPrimary: true,
    receivesNotifications: false,
  };
  return {
    vendorId: String(id),
    name,
    roles: [role],
    roleMeta: {},
    source: "synthetic-fixture",
    notes: null,
    contacts: [contact],
    primaryContact: contact,
    primaryContactSelection: "explicit_primary",
  };
}
const installer = vendor(
  1,
  "Fixture Sprinkler Installation",
  "trade",
  "Inez Installer",
  "installer@fixture.test",
);
const engineer = vendor(
  2,
  "Fixture Fire Engineering",
  "sprinkler_engineer",
  "Evan Engineer",
  "engineer@fixture.test",
);
installer.roleMeta = { scope: "sprinkler installation" };
installer.notes = "Assigned sprinkler installer for the synthetic site visit";
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  let body;
  try {
    body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  } catch {
    response.writeHead(400).end();
    return;
  }
  const pathname = new URL(request.url, "http://fixture").pathname;
  const reply = (status, value) => {
    // The pre-change project reader did not project internal roles. Keep the
    // underlying synthetic directory fixed and represent that actual read gap.
    if (process.env.FI_AGENT_CONTRACTS_BASELINE === "1") {
      if (value?.result?.internalRoleAssignments) {
        delete value.result.internalRoleAssignments;
      }
      for (const assignedVendor of value?.result?.team?.vendors ?? []) {
        delete assignedVendor.primaryContactSelection;
      }
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (pathname === "/health") {
    return reply(200, { ok: true });
  }
  if (pathname === "/evidence" && request.method === "GET") {
    return reply(200, { calls });
  }
  const sender = body?.requesterSenderId;
  if (
    pathname === "/api/openclaw-user-delegation/resolve" &&
    request.method === "POST" &&
    request.headers.authorization === "Bearer synthetic-fi-broker" &&
    members[sender] &&
    body.agentId === "cellect-fi-admin"
  ) {
    calls.push({ method: request.method, path: pathname, sender, allowed: true });
    return reply(200, {
      user: { email: members[sender], orgId, orgSlug: tenant, role: "admin" },
      requester: { channel: "slack", email: members[sender] },
    });
  }
  if (
    pathname === "/api/openclaw-user-delegation" &&
    request.method === "POST" &&
    request.headers.authorization === "Bearer synthetic-fi-broker" &&
    members[sender] &&
    body.agentId === "cellect-fi-admin"
  ) {
    calls.push({ method: request.method, path: pathname, sender });
    return reply(200, {
      ok: true,
      user: { email: members[sender], orgSlug: tenant, orgId, role: "admin" },
      gmail: { enabled: true, mailbox: members[sender] },
      fi: mint(sender),
      requester: { channel: "slack", email: members[sender] },
    });
  }
  const tokenSender = Object.keys(members).find(
    (id) => request.headers.authorization === `Bearer ${tokens.get(id)}`,
  );
  if (!tokenSender) {
    calls.push({
      method: request.method,
      path: pathname,
      allowed: false,
      reason: "invalid-fixture-proof",
    });
    return reply(401, {
      ok: false,
      code: "unauthenticated",
      error: "Synthetic requester proof required",
      requestId: "fixture-proof",
    });
  }
  if (
    pathname === `/api/${tenant}/project/show` &&
    request.method === "POST" &&
    body?.input?.actor === members[tokenSender] &&
    body.input.view === "team" &&
    Object.keys(body.input).every((key) => ["actor", "project", "view"].includes(key))
  ) {
    const project =
      typeof body.input.project === "string" ? body.input.project.trim().toLowerCase() : "";
    if (!["fixture-site", "fixture site", "auth-failure"].includes(project)) {
      return reply(404, { ok: false, code: "not-found", error: "Unknown synthetic project" });
    }
    calls.push({
      method: request.method,
      path: pathname,
      sender: tokenSender,
      project,
      allowed: true,
    });
    if (project === "auth-failure") {
      return reply(401, {
        ok: false,
        code: "unauthenticated",
        error: "Fixture requester session expired",
        requestId: "fixture-auth-failure",
        execution: { state: "not-started" },
      });
    }
    return reply(200, {
      ok: true,
      requestId: "fixture-project",
      result: {
        project: {
          id: "fixture-site",
          slug: "fixture-site",
          name: "Fixture Site",
          status: "active",
          isArchived: false,
          matchedBy: project === "fixture site" ? "name" : "id-or-slug",
        },
        view: "team",
        internalRoleAssignments: {
          status: "available",
          assignments: [
            {
              email: "lead@fixture.test",
              roles: ["project_lead"],
              source: "project_members.roles_json",
            },
          ],
        },
        team: {
          projectId: "fixture-site",
          vendors: [installer, engineer],
          byRole: { trade: [installer], sprinkler_engineer: [engineer] },
          gc: null,
          cm: null,
          architect: null,
          gcCompanyName: null,
          gcContactName: null,
          gcContactEmail: null,
          gcContractDate: null,
          cmCompanyName: null,
          cmContactName: null,
          cmContactEmail: null,
          architectCompanyName: null,
          architectContactName: null,
          architectContactEmail: null,
          deliveryModel: null,
        },
        assets: [],
        signingContext: { status: "available", ownerSignatory: null },
      },
    });
  }
  if (
    pathname === `/api/${tenant}/ir/custom-cases/${caseId}/invitations/${deliveryId}` &&
    request.method === "GET"
  ) {
    calls.push({ method: request.method, path: pathname, sender: tokenSender, allowed: true });
    return reply(200, {
      ok: true,
      receipt: { id: deliveryId, status: "sent", providerMessageId: "fixture-provider-message-1" },
    });
  }
  calls.push({
    method: request.method,
    path: pathname,
    sender: tokenSender,
    allowed: false,
    reason: "effect-not-allowlisted",
  });
  return reply(403, { ok: false, code: "forbidden", error: "Fixture denies unlisted effects" });
});
server.listen(8080, "0.0.0.0", () => process.stdout.write("fixture-ready\n"));
process.once("SIGTERM", () => server.close());
