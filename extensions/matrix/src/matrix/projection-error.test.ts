import { describe, expect, it, vi } from "vitest";
import { ProjectionError, projectionFailure } from "./projection-error.js";
import { handleMatrixSessionProjectionCreate } from "./session-projection.js";

describe("projection failures", () => {
  it("carries the message and reason in the error frame, not only the payload", () => {
    const failure = projectionFailure(
      new ProjectionError("ownership_changed", "Projection conversation ownership cannot change"),
    );
    expect(failure.error).toMatchObject({
      code: "UNAVAILABLE",
      message: "Projection conversation ownership cannot change",
      details: { reason: "ownership_changed" },
    });
    expect(failure.payload).toEqual({ error: "Projection conversation ownership cannot change" });
  });

  it("marks caller mistakes as invalid requests", () => {
    expect(projectionFailure(new ProjectionError("invalid_request", "bad")).error.code).toBe(
      "INVALID_REQUEST",
    );
  });

  it("labels unexpected errors as internal but keeps their message", () => {
    expect(projectionFailure(new Error("homeserver timeout")).error).toMatchObject({
      code: "UNAVAILABLE",
      message: "homeserver timeout",
      details: { reason: "internal" },
    });
  });

  it("create responds with an error shape when the request is invalid", async () => {
    const respond = vi.fn();
    await handleMatrixSessionProjectionCreate(
      {
        params: {
          targetSessionKey: "agent:x:slack:channel:c1",
          roomId: "!r:hs",
          environment: "prod",
        },
        respond,
        context: { getRuntimeConfig: () => ({}) },
      } as never,
      {} as never,
    );
    expect(respond).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ error: expect.any(String) }),
      expect.objectContaining({
        message: expect.any(String),
        details: { reason: expect.any(String) },
      }),
    );
  });
});
