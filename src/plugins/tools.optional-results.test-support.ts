import { expect } from "vitest";
import type { resolvePluginTools } from "./tools.js";
export function expectResolvedToolNames(
  tools: ReturnType<typeof resolvePluginTools>,
  expectedToolNames: readonly string[],
) {
  expect(tools.map((tool) => tool.name)).toEqual(expectedToolNames);
}
