import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notifyGuestTurnCompletion,
  registerGuestTurnCompletionHandler,
  type GuestTurnCompletion,
} from "./guest-turn-completion.js";

const completion: GuestTurnCompletion = {
  runId: "run-1",
  sessionKey: `hook:fi-guest:${"a".repeat(40)}`,
  attestation: `fga:gt_1:${"C".repeat(43)}`,
  status: "ok",
  outputText: "hello",
};

describe("guest turn completion", () => {
  let release: (() => void) | undefined;
  afterEach(() => release?.());

  it("does nothing without a handler", async () => {
    const onError = vi.fn();
    await notifyGuestTurnCompletion(completion, onError);
    expect(onError).not.toHaveBeenCalled();
  });

  it("hands the completion to the handler and contains its failure", async () => {
    const handler = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    release = registerGuestTurnCompletionHandler(handler);
    const onError = vi.fn();
    await notifyGuestTurnCompletion(completion, onError);
    expect(handler).toHaveBeenCalledWith(completion);
    expect(onError).toHaveBeenCalledTimes(1);
    await notifyGuestTurnCompletion(completion, onError);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("releases only its own registration", async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const releaseFirst = registerGuestTurnCompletionHandler(first);
    const second = vi.fn().mockResolvedValue(undefined);
    release = registerGuestTurnCompletionHandler(second);
    releaseFirst();
    await notifyGuestTurnCompletion(completion, vi.fn());
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
