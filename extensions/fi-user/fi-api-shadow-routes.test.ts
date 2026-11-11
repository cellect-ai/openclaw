import { describe, expect, it } from "vitest";
import { FI_USER_API_SHADOW_READ_ROUTES } from "./fi-api-tool.js";

/**
 * Vendored from Fi `src/lib/openclaw/user-delegation.ts`
 * (`OPENCLAW_USER_DELEGATION_READ_ROUTES`, with
 * `OPENCLAW_USER_DELEGATION_APP_TEXT_ROUTES` expanded), Fi main ae9e5c0c0,
 * 2026-11-11. A shadow token reaches exactly these, GET only. Refresh this copy
 * when Fi's list changes; the gateway's shadow list must stay inside it.
 */
const FI_SHADOW_ADMITTED_READ_ROUTES: readonly RegExp[] = [
  /^[^/]+\/(?:budget|cash-flows|cash-flow-statement|financing|milestones|payments|docs)\/text$/,
  /^apps\/buyout\/text$/,
  /^apps\/buyout\/[a-f0-9-]{36}\/text$/i,
  /^apps\/accounts-payable\/text$/,
  /^apps\/accounts-payable\/cash-needs\/text$/,
  /^apps\/accounts-payable\/vendor-portals\/text$/,
  /^apps\/accounts-payable\/vendor-portals\/[^/]+\/text$/,
  /^apps\/invoices\/text$/,
  /^audit\/text$/,
  /^fi-view\/context$/,
  /^companies\/[^/]+\/(?:balance-sheet|pnl|cash-flow-statement)\/text$/,
  /^debt\/[^/]+\/statement\/text$/,
  /^documents\/search$/,
  /^nav\/search$/,
  /^[^/]+\/docs\/[^/]+\/file$/,
  /^slack-channels\/[^/]+\/project$/,
  /^[^/]+\/esign$/,
  /^[^/]+\/esign\/submissions\/[1-9][0-9]*$/,
  /^mail-agent\/items$/,
  /^mail-agent\/items\/[A-Za-z0-9_-]{8,64}\/context$/,
  /^mail-agent\/items\/[A-Za-z0-9_-]{8,64}\/conversations\/[A-Za-z0-9_-]{1,128}\/text$/,
  /^mail-agent\/items\/[A-Za-z0-9_-]{8,64}\/documents\/[A-Za-z0-9_-]{1,200}\/(?:file|clip)$/,
];

/** One representative path per gateway shadow route, in list order. */
const SHADOW_SAMPLES = [
  "305-third/budget/text",
  "apps/accounts-payable/text",
  "apps/accounts-payable/cash-needs/text",
  "apps/accounts-payable/vendor-portals/text",
  "apps/accounts-payable/vendor-portals/room-1/text",
  "audit/text",
  "companies/opco/pnl/text",
  "debt/project-305-third:Loan-1/statement/text",
  "documents/search",
  "fi-view/context",
  "mail-agent/items",
  "mail-agent/items/item-12345678/context",
  "mail-agent/items/item-12345678/conversations/conv-1/text",
  "nav/search",
  "slack-channels/C0CHANNEL1/project",
];

/** Fi admits these for a shadow token; the gateway keeps a drafting turn off them. */
const EXCLUDED_FROM_SHADOW = [
  "305-third/docs/doc-1/file",
  "305-third/esign",
  "305-third/esign/submissions/221",
  "mail-agent/items/item-12345678/documents/doc-1/file",
  "mail-agent/items/item-12345678/documents/doc-1/clip",
];

const admits = (routes: readonly RegExp[], path: string) =>
  routes.some((route) => route.test(path));

describe("fi_user_api shadow route list", () => {
  it("has one sample per gateway shadow route", () => {
    expect(SHADOW_SAMPLES).toHaveLength(FI_USER_API_SHADOW_READ_ROUTES.length);
    FI_USER_API_SHADOW_READ_ROUTES.forEach((route, index) => {
      expect(route.test(SHADOW_SAMPLES[index]!)).toBe(true);
    });
  });

  it.each(SHADOW_SAMPLES)("stays inside Fi's shadow-admitted reads: %s", (path) => {
    expect(admits(FI_SHADOW_ADMITTED_READ_ROUTES, path)).toBe(true);
  });

  it.each(EXCLUDED_FROM_SHADOW)(
    "keeps document bytes and e-sign out of shadow turns: %s",
    (path) => {
      expect(admits(FI_SHADOW_ADMITTED_READ_ROUTES, path)).toBe(true);
      expect(admits(FI_USER_API_SHADOW_READ_ROUTES, path)).toBe(false);
    },
  );
});
