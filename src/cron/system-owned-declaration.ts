/** Legacy producer namespace; recognized declarations migrate in the cron store owner. */
export const RETIRED_SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX = "skill-collection-review:";

export const WORKSHOP_COLLECTION_REVIEW_DECLARATION_PREFIX = "workshop-collection-review:";

/** Reserved creation namespaces for system declarations. */
const SYSTEM_OWNED_DECLARATION_PREFIXES = [
  WORKSHOP_COLLECTION_REVIEW_DECLARATION_PREFIX,
  // Legacy keys remain reserved during migration.
  RETIRED_SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX,
];

export function systemOwnedDeclarationKeyNamespace(
  declarationKey: string | undefined,
): string | undefined {
  return SYSTEM_OWNED_DECLARATION_PREFIXES.find((prefix) => declarationKey?.startsWith(prefix));
}
