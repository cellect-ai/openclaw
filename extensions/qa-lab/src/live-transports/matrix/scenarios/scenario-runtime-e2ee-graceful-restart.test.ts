import { describe, expect, it } from "vitest";
import {
  readMatrixGracefulCheckpointStatus,
  assertMatrixGracefulCheckpointRestored,
} from "./scenario-runtime-e2ee-graceful-restart.js";

const saved = {
  requestId: "operation",
  suspensionId: "suspension",
  predecessorProcessInstanceId: "old-process",
  accountId: "sut",
  storeId: "opaque-store",
  generation: "source-generation",
};
const account = {
  accountId: "sut",
  application: {
    matrixCheckpoint: { version: 1, accountId: "sut", storeId: "opaque-store", restored: saved },
  },
};

describe("graceful Matrix source proof assertions", () => {
  it("reads only the unique account-owned channel status", () => {
    expect(
      readMatrixGracefulCheckpointStatus({ channelAccounts: { matrix: [account] } }, "sut"),
    ).toEqual({ storeId: "opaque-store", restored: saved });
    expect(() =>
      readMatrixGracefulCheckpointStatus(
        { channelAccounts: { matrix: [account, account] } },
        "sut",
      ),
    ).toThrow("must be unique");
    expect(() =>
      readMatrixGracefulCheckpointStatus({ channelAccounts: { matrix: [account] } }, "other"),
    ).toThrow("must be unique");
    expect(() =>
      readMatrixGracefulCheckpointStatus(
        { channelAccounts: { matrix: [{ accountId: "sut" }] } },
        "sut",
      ),
    ).toThrow("Matrix application");
  });

  it.each(Object.keys(saved) as Array<keyof typeof saved>)(
    "rejects changed %s rather than synthesizing proof",
    (field) => {
      expect(() =>
        assertMatrixGracefulCheckpointRestored(saved, { ...saved, [field]: "wrong" }),
      ).toThrow("exact source-owned checkpoint");
    },
  );

  it("accepts exactly the persisted source proof, but not absent or augmented evidence", () => {
    expect(() => assertMatrixGracefulCheckpointRestored(saved, { ...saved })).not.toThrow();
    expect(() => assertMatrixGracefulCheckpointRestored(saved, null)).toThrow();
    expect(() =>
      assertMatrixGracefulCheckpointRestored(saved, { ...saved, clean: true }),
    ).toThrow();
  });
});
