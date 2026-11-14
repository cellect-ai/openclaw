import path from "node:path";
import { closeOpenClawStateDatabaseAsync } from "../../../../src/state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../../../src/state/user-profiles.js";

const [stateDir, tempRoot] = process.argv.slice(2);
if (
  !stateDir ||
  !tempRoot ||
  process.env.OPENCLAW_STATE_DIR !== stateDir ||
  path.resolve(stateDir) !== path.join(path.resolve(tempRoot), "state") ||
  !path.basename(tempRoot).startsWith("openclaw-qa-suite-")
) {
  throw new Error("Profile bootstrap requires stopped, isolated QA state");
}
try {
  const profiles = ["a@fixture.test", "b@fixture.test"].map((email) => {
    const { id } = ensureProfileForEmail(email, { env: process.env });
    return { id, email };
  });
  process.stdout.write(JSON.stringify(profiles) + "\n");
} finally {
  await closeOpenClawStateDatabaseAsync();
}
