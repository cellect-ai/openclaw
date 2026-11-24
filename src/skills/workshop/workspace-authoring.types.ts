import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";

/** Host-issued workspace scope; tool arguments cannot create or renew it. */
export type SkillWorkshopWorkspaceAuthoring = Readonly<{
  agentId: string;
  bind: (context: AdmittedRunContext) => void;
  assertCurrent: () => void;
}>;
