type Action = {
  toolName: "sessions_spawn" | "read";
  task: string;
  label: string;
  confirmationId?: string;
};
export const sessionAction = (label = "helper"): Action => ({
  toolName: "sessions_spawn",
  task: `Create the requested ${label} session`,
  label,
});
export const MODEL_SUCCESS = "I have created the requested sessions.";
