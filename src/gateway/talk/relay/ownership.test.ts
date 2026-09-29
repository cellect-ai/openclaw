import { describe, expect, it, vi } from "vitest";
import { TalkRealtimeRelayOutputOwnership } from "./state.js";

describe("realtime relay output ownership", () => {
  it("adopts a replacement response while the previous one is still owned", () => {
    const fail = vi.fn();
    const ownership = new TalkRealtimeRelayOutputOwnership(
      () => "turn-1",
      () => "turn-1",
      fail,
    );

    expect(ownership.responseCreated("response-1")).toBe(true);
    expect(ownership.responseCreated("response-2")).toBe(true);

    expect(fail).not.toHaveBeenCalled();
    expect(ownership.phase).toBe("owned");
    expect(ownership.responseId).toBe("response-2");
    expect(ownership.takeSuperseded()).toBe(true);
    expect(ownership.takeSuperseded()).toBe(false);
  });

  it("still fails when a replacement response arrives during cancellation", () => {
    const fail = vi.fn();
    const ownership = new TalkRealtimeRelayOutputOwnership(
      () => "turn-1",
      () => "turn-1",
      fail,
    );
    ownership.responseCreated("response-1");
    ownership.phase = "cancelling";

    expect(ownership.responseCreated("response-2")).toBe(false);

    expect(fail).toHaveBeenCalledOnce();
    expect(ownership.responseId).toBe("response-1");
  });
});
