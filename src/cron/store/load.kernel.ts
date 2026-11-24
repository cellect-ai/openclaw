import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { stripJobRuntimeFields } from "./job-config-codec.js";
import {
  upsertCronJobRow,
  fingerprintCronJobRows,
  fingerprintCronRuntimeRows,
  loadedCronStoreFromRows,
  loadCronRows,
} from "./row-codec.js";
import {
  loadCronRuntimeAuthorities,
  repairCronRuntimeAuthorityRows,
} from "./runtime-authority-store.js";
import type { LoadedCronStore } from "./types.js";
import {
  isLegacyWorkshopCollectionRow,
  migrateWorkshopCollectionRow,
  quarantineLegacyWorkshopRow,
} from "./workshop-collection-migration.js";

type CronLoadWriter = {
  write<T>(operation: (db: EngineConnection) => T, operationLabel: string): T;
  committed(): void;
};

export function loadCronStoreFromDatabase(
  database: EngineConnection,
  storeKey: string,
  writer?: CronLoadWriter,
): LoadedCronStore {
  let rows = loadCronRows(database, storeKey);
  const legacyIds = new Set(rows.filter(isLegacyWorkshopCollectionRow).map((row) => row.job_id));
  if (writer && legacyIds.size > 0) {
    const migrated = writer.write((db) => {
      const current = loadCronRows(db, storeKey);
      const claimed = new Set(current.map((row) => row.declaration_key).filter(Boolean));
      let count = 0;
      for (const row of current) {
        if (!legacyIds.has(row.job_id) || !isLegacyWorkshopCollectionRow(row)) continue;
        const job = migrateWorkshopCollectionRow(row);
        // An existing declaration wins; preserve a duplicate legacy row quarantined for repair.
        if (!job || claimed.has(job.declarationKey ?? null)) continue;
        upsertCronJobRow(db, storeKey, job, Number(row.sort_order), { preserveRuntimeState: true });
        claimed.add(job.declarationKey ?? null);
        count++;
      }
      return count;
    }, "cron.migrate-workshop-collection-review");
    if (migrated > 0) writer.committed();
    rows = loadCronRows(database, storeKey);
  }
  const persistedRows = rows;
  // Read-only inventories project the same recognized declaration without mutation.
  const claimed = new Set(
    rows.filter((row) => !isLegacyWorkshopCollectionRow(row)).map((row) => row.declaration_key),
  );
  rows = rows.map((row) => {
    if (!isLegacyWorkshopCollectionRow(row)) return row;
    const job = migrateWorkshopCollectionRow(row);
    if (!job || claimed.has(job.declarationKey ?? null)) return quarantineLegacyWorkshopRow(row);
    claimed.add(job.declarationKey ?? null);
    return {
      ...row,
      declaration_key: job.declarationKey ?? null,
      payload_kind: "agentTurn",
      job_json: JSON.stringify(stripJobRuntimeFields(job)),
    };
  });
  const loaded = loadedCronStoreFromRows(rows);
  for (const invalid of loaded.invalidConfigRows) {
    const source = persistedRows[invalid.sourceIndex];
    if (!source || !isLegacyWorkshopCollectionRow(source)) continue;
    invalid.raw = { jobId: source.job_id, jobJson: source.job_json, stateJson: source.state_json };
    const original = safeParseJsonRecord(source.job_json);
    if (original) invalid.job = original;
  }

  if (rows.length > 0) {
    const authority = loadCronRuntimeAuthorities({
      db: database,
      storeKey,
      jobs: loaded.store.jobs,
    });
    if (writer) {
      repairLoadedCronRuntimeAuthority(writer, {
        storeKey,
        jobIds: authority.repairJobIds,
      });
    }
  }
  return !writer
    ? loaded
    : {
        ...loaded,
        jobsFingerprint: fingerprintCronJobRows(persistedRows),
        runtimeFingerprint: fingerprintCronRuntimeRows(persistedRows),
      };
}

function repairLoadedCronRuntimeAuthority(
  writer: CronLoadWriter,
  params: {
    storeKey: string;
    jobIds: readonly string[];
  },
): void {
  if (params.jobIds.length === 0) {
    return;
  }
  const repaired = writer.write((db) => {
    const rows = loadCronRows(db, params.storeKey, new Set(params.jobIds));
    if (rows.length === 0) {
      return false;
    }
    const loaded = loadedCronStoreFromRows(rows);

    return repairCronRuntimeAuthorityRows({
      db,
      storeKey: params.storeKey,
      jobs: loaded.store.jobs,
      jobIds: params.jobIds,
    });
  }, "cron.runtime-authority-repair");
  if (repaired) {
    writer.committed();
  }
}
