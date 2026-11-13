import { beforeEach, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const { resolve, deliver } = vi.hoisted(() => ({ resolve: vi.fn(), deliver: vi.fn() }));
vi.mock("../../../extensions/fi-user/api.js", () => ({ resolvePersonalReviewDelivery: resolve }));
vi.mock("./fi-shadow-announce.js", () => ({ deliverFiPrivateMain: deliver }));
const owner = {
  ownerEmail: "owner@example.test",
  roomId: "!main:example.test",
  jobId: "review-job-1",
};
const params = () => ({
  reviewAttestation: `pra:review-job-1:${"B".repeat(43)}`,
  childSessionKey: `hook:fi-review:${"a".repeat(40)}`,
  idempotencyKey: "first",
  label: "Personal review",
  resultText: "1. Review permit.",
});
beforeEach(() => {
  resetGatewayWorkAdmission();
  vi.clearAllMocks();
  resolve.mockResolvedValue(owner);
  deliver.mockImplementation(async (_params, _owner, respond, _signal, revalidate) => {
    await revalidate();
    respond(true, { path: "direct" });
  });
});
async function call(input: Record<string, unknown> = params(), scopes = ["operator.admin"]) {
  const respond = vi.fn();
  const client: GatewayClient = {
    connId: crypto.randomUUID(),
    clientIp: "127.0.0.1",
    connect: {
      role: "operator",
      scopes,
      client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  };
  await handleGatewayRequest({
    req: { type: "req", id: crypto.randomUUID(), method: "fi.review.announce", params: input },
    respond,
    client,
    isWebchatConnect: () => false,
    context: { logGateway: { warn: vi.fn() } } as unknown as GatewayRequestContext,
  });
  return respond;
}
it("uses fresh enrollment authority twice and the native private-Main delivery owner", async () => {
  const respond = await call();
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(deliver).toHaveBeenCalledWith(
    expect.objectContaining({
      roomId: owner.roomId,
      ownerEmail: owner.ownerEmail,
      replyInstruction: "ask_owner",
    }),
    owner.ownerEmail,
    expect.any(Function),
    undefined,
    expect.any(Function),
  );
  expect(respond).toHaveBeenCalledWith(true, { path: "direct" });
});
it("does not let a caller choose another replay key for the accepted report", async () => {
  await call();
  await call({ ...params(), idempotencyKey: "different" });
  expect(deliver.mock.calls[0][0].idempotencyKey).toBe(deliver.mock.calls[1][0].idempotencyKey);
});
it("refuses a changed owner, enrollment or destination before native delivery", async () => {
  resolve
    .mockResolvedValueOnce(owner)
    .mockResolvedValueOnce({ ...owner, roomId: "!changed:example.test" });
  expect((await call()).mock.calls[0]?.[0]).toBe(false);
});
it("refuses caller destinations, wrong grant purposes and non-admin transport", async () => {
  expect((await call({ ...params(), roomId: "!other:example.test" })).mock.calls[0]?.[0]).toBe(
    false,
  );
  expect(
    (await call({ ...params(), reviewAttestation: `fsa:review-job-1:${"B".repeat(43)}` })).mock
      .calls[0]?.[0],
  ).toBe(false);
  expect((await call(params(), ["operator.read"])).mock.calls[0]?.[0]).toBe(false);
  expect(deliver).not.toHaveBeenCalled();
});
