import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { shouldPruneSandboxRegistryEntry } from "../agents/sandbox/registry.kernel.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { withStateMigrationBackupForTest } from "./openclaw-state-schema.test-support.js";

// Exact DDL from fork 97613fcbbaf3d215e21939a40bbbe0d7135b5473.
// Synthetic source coverage does not replace restored-state and entrypoint proof.
const ddl = fs.readFileSync(
  new URL("../../test/fixtures/sqlite/cellect-openclaw-state-schema-21.sql", import.meta.url),
  "utf8",
);
const roots = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
const retained = {
  containerName: "synthetic-retained-generation",
  sessionKey: "agent:main:synthetic-retained",
  createdAtMs: 1,
  lastUsedAtMs: 1,
  image: "synthetic:old",
  rolloverRetained: true,
};

function fixture() {
  const env = { OPENCLAW_STATE_DIR: roots.make("cellect-shared-schema-21-") };
  const pathname = resolveOpenClawStateSqlitePath(env);
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  using db = new DatabaseSync(pathname);
  expect(createHash("sha256").update(ddl).digest("hex")).toBe(
    "0e79ca02fce2328dd4ea31900fe5adf4e1f200177996acb82f6104748a640768",
  );
  db.exec(ddl);
  db.exec(`PRAGMA user_version = 21;
    INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
      VALUES ('primary', 'global', 21, 1, 1);
    INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '21', 1);
    INSERT INTO channel_pairing_requests
      (channel_key, account_id, request_id, code, created_at, last_seen_at, status, resolved_at)
      VALUES ('slack', 'synthetic-account', 'synthetic-pending', 'ABCD1234',
        '2026-11-23T00:00:00Z', '2026-11-23T00:00:00Z', NULL, NULL),
      ('slack', 'synthetic-account', 'synthetic-approved', 'ABCD5678',
        '2026-11-23T00:00:00Z', '2026-11-23T00:00:00Z', 'approved', '2026-11-23T00:01:00Z');`);
  db.prepare(`INSERT INTO sandbox_registry_entries
    (registry_kind, container_name, session_key, created_at_ms, last_used_at_ms, image, entry_json, updated_at)
    VALUES ('container', ?, ?, 1, 1, ?, ?, 1)`).run(
    retained.containerName,
    retained.sessionKey,
    retained.image,
    JSON.stringify(retained),
  );
  return { env, path: pathname };
}

it.each(["runtime", "doctor"] as const)(
  "migrates exact fork schema 21 through %s while preserving history and retained generations",
  async (owner) => {
    const options = fixture();
    await withStateMigrationBackupForTest(options, () => {
      if (owner === "doctor") {
        expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      }
      openOpenClawStateDatabase(options);
    });
    const { db } = openOpenClawStateDatabase(options);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(
      db
        .prepare(
          "SELECT request_id, status, resolved_at FROM channel_pairing_requests ORDER BY request_id",
        )
        .all(),
    ).toEqual([
      { request_id: "synthetic-approved", status: "approved", resolved_at: "2026-11-23T00:01:00Z" },
      { request_id: "synthetic-pending", status: null, resolved_at: null },
    ]);
    expect(
      db
        .prepare("SELECT entry_json FROM sandbox_registry_entries WHERE container_name = ?")
        .get(retained.containerName),
    ).toEqual({ entry_json: JSON.stringify(retained) });
    expect(
      shouldPruneSandboxRegistryEntry(retained, {
        now: Date.now(),
        idleHours: 1,
        maxAgeDays: 1,
      }),
    ).toBe(false);
    const projections = db
      .prepare("SELECT name FROM pragma_table_info('delivery_queue_entries')")
      .all()
      .map((row) => row.name);
    expect(projections).toEqual(
      expect.arrayContaining([
        "retention_id_prefix",
        "retention_max_age_ms",
        "retention_max_entries",
      ]),
    );
    await closeOpenClawStateDatabaseAsync();
    const reopened = openOpenClawStateDatabase(options);
    expect(reopened.db.prepare("SELECT COUNT(*) AS n FROM channel_pairing_requests").get()).toEqual(
      { n: 2 },
    );
  },
);

it("refuses a newer writer marker without rewriting predecessor rows", async () => {
  const options = fixture();
  using before = new DatabaseSync(options.path);
  before.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
  const snapshot = before
    .prepare("SELECT * FROM channel_pairing_requests ORDER BY request_id")
    .all();
  expect(() => openOpenClawStateDatabase(options)).toThrow();
  expect(
    before.prepare("SELECT * FROM channel_pairing_requests ORDER BY request_id").all(),
  ).toEqual(snapshot);
  expect(before.prepare("PRAGMA user_version").get()).toEqual({
    user_version: OPENCLAW_STATE_SCHEMA_VERSION + 1,
  });
});
