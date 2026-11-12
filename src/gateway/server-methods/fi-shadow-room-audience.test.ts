import { expect, it } from "vitest";
import {
  isPersonMxid,
  ownerMxidForAccount,
  roomAudienceAllowsOwner,
} from "./fi-shadow-room-audience.js";

const OWNER = "alex@example.com";
const PROD_BOT = "@bot_shape_cellect-fi-user:matrix.test";
const DEV_BOT = "@dev.bot_shape_cellect-fi-user:matrix.test";
const OWNER_PROD = "@alex=40example=2ecom:matrix.test";
const OWNER_DEV = "@dev.alex=40example=2ecom:matrix.test";
const BOB = "@bob=40example=2ecom:matrix.test";
const ADMIN = "@threads-admin:matrix.test";

it("encodes the owner on the account's homeserver and environment", () => {
  expect(ownerMxidForAccount(OWNER, PROD_BOT)).toBe(OWNER_PROD);
  expect(ownerMxidForAccount(OWNER, DEV_BOT)).toBe(OWNER_DEV);
  expect(ownerMxidForAccount(OWNER, "@cellect-fi-user:matrix.test")).toBe(OWNER_PROD);
  expect(ownerMxidForAccount(OWNER, "@random:matrix.test")).toBeUndefined();
});

it("treats an email localpart as a person and a bot or admin localpart as not", () => {
  expect(isPersonMxid(OWNER_PROD)).toBe(true);
  expect(isPersonMxid(PROD_BOT)).toBe(false);
  expect(isPersonMxid(ADMIN)).toBe(false);
  expect(isPersonMxid("@cellect-fi-user:matrix.test")).toBe(false);
});

it("allows the owner plus this account and other non-persons", () => {
  expect(
    roomAudienceAllowsOwner({
      members: [OWNER_PROD, PROD_BOT, ADMIN],
      ownerEmail: OWNER,
      accountUserId: PROD_BOT,
    }),
  ).toBe(true);
});

it("refuses another person, a missing owner, or a missing account", () => {
  const base = { ownerEmail: OWNER, accountUserId: PROD_BOT };
  expect(roomAudienceAllowsOwner({ ...base, members: [OWNER_PROD, BOB, PROD_BOT] })).toBe(false);
  expect(roomAudienceAllowsOwner({ ...base, members: [BOB, PROD_BOT, ADMIN] })).toBe(false);
  expect(roomAudienceAllowsOwner({ ...base, members: [OWNER_PROD, ADMIN] })).toBe(false);
  expect(roomAudienceAllowsOwner({ ...base, members: [] })).toBe(false);
});
