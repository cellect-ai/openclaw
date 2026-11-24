import { describe, expect, it } from "vitest";
import { predecessorDockerConfigs, validateReadOnlyBindRollover } from "./bind-rollover.js";
import type { SandboxDockerConfig } from "./types.js";

const from = ["/immutable/old:/resource:ro", "/immutable/old/bin:/bin/resource:ro"];
const to = ["/immutable/new:/resource:ro", "/immutable/new/bin:/bin/resource:ro"];
const docker: SandboxDockerConfig = {
  image: "fixture",
  containerPrefix: "fixture-",
  workdir: "/workspace",
  readOnlyRoot: true,
  tmpfs: [],
  network: "none",
  capDrop: ["ALL"],
  binds: [...to, "/retained:/other:ro"],
  readOnlyBindRollovers: [{ from, to }],
};

describe("host-declared read-only bind rollovers", () => {
  it("reconstructs only approved predecessor resources and keeps other policy unchanged", () => {
    const [prior] = predecessorDockerConfigs(docker);
    expect(prior).toEqual({ ...docker, binds: [...from, "/retained:/other:ro"] });
    expect(docker.binds).toEqual([...to, "/retained:/other:ro"]);
  });
  it.each([
    { from, to: [to[0]!] },
    { from, to: [to[0]!, to[0]!] },
    { from, to: [to[0]!, "/immutable/new/bin:/bin/resource:rw"] },
    { from: ["relative:/resource:ro"], to: [to[0]!] },
    { from, to: [to[0]!, "/immutable/new/bin:/bin/../resource:ro"] },
  ])("rejects destination, access, or source ambiguity %#", (pair) => {
    expect(() => validateReadOnlyBindRollover(pair)).toThrow();
  });
  it("rejects a declared resource shadowed by another configured bind", () => {
    expect(() =>
      predecessorDockerConfigs({ ...docker, binds: [...docker.binds!, "/other:/resource:ro"] }),
    ).toThrow();
  });
  it("does not infer a rollover from similar filenames", () => {
    expect(predecessorDockerConfigs({ ...docker, readOnlyBindRollovers: undefined })).toEqual([]);
  });
});
