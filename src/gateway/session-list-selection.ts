import {
  resolveNonNegativeIntegerOption,
  resolveOptionalIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import { recordSessionRowPartitionCache } from "../infra/gateway-work-metrics.js";
import { getMainThreadTaskName } from "../infra/main-thread-stall.js";
import { SESSIONS_LIST_OWNER_LIMIT } from "../shared/session-list-limits.js";
import {
  addSessionOwnerFacetIdentity,
  sortSessionOwnerFacet,
} from "./session-identity-projection.js";
import {
  filterSessionEntries,
  type SessionEntrySelection,
  type SessionListFilterParams,
  type SessionListFilteredEntries,
} from "./session-list-filters.js";
import {
  mergeSessionEntryPages,
  sortAndLimitSessionEntries,
  type SessionEntryPair,
} from "./session-list-order.js";
import { createSessionRowSelection } from "./session-row-selection.js";
import { matchesSessionArchiveFilter } from "./session-utils-core.js";

export function selectSessionEntries(
  params: SessionListFilterParams & {
    defaultLimit?: number;
    partitions?: ReturnType<ReturnType<typeof createSessionRowSelection>["read"]>["partitions"];
    retained?: WeakMap<object, SessionListFilteredEntries>;
  },
): SessionEntrySelection {
  const limit = resolveOptionalIntegerOption(params.opts.limit, { min: 1 }) ?? params.defaultLimit;
  const offset = resolveNonNegativeIntegerOption(params.opts.offset, 0);
  const ownerLimit =
    params.ownerFirstActorId && offset === 0
      ? Math.min(limit ?? SESSIONS_LIST_OWNER_LIMIT, SESSIONS_LIST_OWNER_LIMIT)
      : 0;
  // Person-reference resolution and people truncation require the whole visible roster.
  // Temporal queries are not retained by the presentation owner.
  const incremental =
    params.partitions &&
    params.retained &&
    !params.opts.includePeople &&
    !params.opts.involvingProfileId &&
    !params.opts.includeOwnerSessionCounts;
  let filteredResult: SessionListFilteredEntries;
  if (incremental) {
    const pages: SessionEntryPair[][] = [];
    const ownerPages: SessionEntryPair[][] = [];
    const owners = new Map<string, SessionListFilteredEntries["ownerFacet"][number]>();
    let totalCount = 0;
    let hits = 0;
    let misses = 0;
    let activityExpiresAt = Infinity;
    const pageEnd =
      limit === undefined ? undefined : Math.min(offset + limit, Number.MAX_SAFE_INTEGER);
    for (const partition of params.partitions!) {
      if (!partition.entries.size) {
        continue;
      }
      let part = params.retained!.get(partition.revision);
      if (!part) {
        misses++;
        part = filterSessionEntries({
          ...params,
          entries: (archived) =>
            Array.from(partition.entries.values()).filter(([, entry]) =>
              matchesSessionArchiveFilter(entry, archived),
            ),
        });
        part.entries = sortAndLimitSessionEntries(part.entries, pageEnd, params.opts.sortBy);
        part.ownerEntries = sortAndLimitSessionEntries(
          part.ownerEntries,
          ownerLimit,
          params.opts.sortBy,
        );
        params.retained!.set(partition.revision, part);
      } else {
        hits++;
      }
      pages.push(part.entries);
      ownerPages.push(part.ownerEntries);
      totalCount += part.totalCount;
      activityExpiresAt = Math.min(activityExpiresAt, part.activityExpiresAt ?? Infinity);
      for (const owner of part.ownerFacet) {
        addSessionOwnerFacetIdentity(owners, owner);
      }
    }
    recordSessionRowPartitionCache(hits, misses, getMainThreadTaskName());
    filteredResult = {
      entries: mergeSessionEntryPages(pages, pageEnd, params.opts.sortBy),
      ownerEntries: mergeSessionEntryPages(ownerPages, ownerLimit, params.opts.sortBy),
      totalCount,
      ownerFacet: sortSessionOwnerFacet(owners),
      ...(Number.isFinite(activityExpiresAt) ? { activityExpiresAt } : {}),
    };
  } else {
    filteredResult = filterSessionEntries(
      params,
      params.entriesSorted ? { offset, limit, ownerLimit } : undefined,
    );
  }
  const { ownerEntries, entries: filtered, ...facets } = filteredResult;
  const sharedEntries = incremental
    ? filtered.slice(offset)
    : params.entriesSorted
      ? filtered
      : sortAndLimitSessionEntries(
          filtered,
          limit === undefined ? undefined : Math.min(offset + limit, Number.MAX_SAFE_INTEGER),
          params.opts.sortBy,
        ).slice(offset);
  let entries = sharedEntries;
  let ownerCount = 0;
  if (ownerLimit > 0) {
    const owned =
      params.entriesSorted || incremental
        ? ownerEntries
        : sortAndLimitSessionEntries(ownerEntries, ownerLimit, params.opts.sortBy);
    ownerCount = owned.length;
    const ownedKeys = new Set(owned.map(([key]) => key));
    entries = [...owned, ...sharedEntries.filter(([key]) => !ownedKeys.has(key))];
  }
  const nextOffset = offset + sharedEntries.length;
  const hasMore = nextOffset < facets.totalCount;
  return {
    ...facets,
    entries,
    ownerCount,
    limitApplied: limit,
    offset,
    nextOffset: hasMore ? nextOffset : null,
    hasMore,
  };
}
