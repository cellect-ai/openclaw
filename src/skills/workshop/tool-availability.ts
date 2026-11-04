import type { SkillLibraryAuthoringCapability } from "../library/authoring.js";

export type SkillWorkshopToolConstructionContext = {
  sandboxed?: boolean;
  libraryAuthoring?: SkillLibraryAuthoringCapability;
  workspaceAuthoring?: import("./types.js").SkillWorkshopWorkspaceAuthoring;
};

/** Host-side Workshop access requires an unsandboxed run or a host-issued authoring capability. */
export function resolveSkillWorkshopToolConstructionBlock(
  context: SkillWorkshopToolConstructionContext,
): { detail: string; fix: string } | undefined {
  if (context.sandboxed && !context.libraryAuthoring && !context.workspaceAuthoring) {
    return {
      detail:
        '"skill_workshop" is unavailable in a sandboxed run without host-issued authoring authority.',
      fix: "Use a non-sandboxed session for this agent, or a fresh native human turn with an explicit skill_workshop tool grant. The openclaw skills workshop CLI is also available.",
    };
  }
  return undefined;
}
