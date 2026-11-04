import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { FiUserMatrixEnvironmentHarness } from "./tools.matrix-environment.test-support.js";

type EsignHarness = Pick<
  FiUserMatrixEnvironmentHarness,
  "calls" | "context" | "json" | "routes"
> & {
  bodyJson: (init: RequestInit | undefined) => Record<string, unknown>;
  plugin: () => { tool: (name: string, context: OpenClawPluginToolContext) => AnyAgentTool };
};

/**
 * A member prepares and sends through Fi's own signing verbs (owner decision
 * of 2026-11-02): the route is stated, checked by Fi, previewed and approved.
 */
export function registerFiUserEsignTests(harness: EsignHarness) {
  const { bodyJson, calls, context, json, plugin, routes } = harness;
  const list = { templates: [] };

  describe("fi_user_esign org status discovery", () => {
    it("uses the existing signing list/show readers without a project and preserves continuation", async () => {
      routes.push((url, init) =>
        ["/api/shape/signature/list", "/api/shape/signature/show"].includes(url.pathname) &&
        init.method === "POST"
          ? json({ ok: true, result: { submissions: [{ submissionId: 12 }], nextBefore: 12 } })
          : undefined,
      );
      const tool = plugin().tool("fi_user_esign", context());
      const listed = await tool.execute("list-status", {
        action: "list",
        query: "Will Serve",
        before: 30,
      });
      expect(listed.details).toMatchObject({ result: { nextBefore: 12 } });
      await tool.execute("show-status", { action: "status", submissionId: 12 });
      const sent = calls.filter((entry) => /signature\/(list|show)$/.test(entry.url));
      expect(sent.map((entry) => bodyJson(entry.init))).toEqual([
        { input: { query: "Will Serve", before: 30 } },
        { input: { submission: 12 } },
      ]);
    });
    it("keeps missing write owner and missing status id refused", async () => {
      const tool = plugin().tool("fi_user_esign", context());
      for (const action of ["resend", "send", "prepare", "send_envelope"])
        await expect(tool.execute("refuse-owner", { action })).rejects.toThrow("exactly one");
      await expect(tool.execute("refuse-id", { action: "status" })).rejects.toThrow("submissionId");
      expect(
        calls.filter((entry) => /signature\/(list|show|send|prepare)$/.test(entry.url)),
      ).toHaveLength(0);
    });
  });

  describe("fi_user_esign prepare and send_envelope", () => {
    it("points a document without a reviewed template to prepare, not to an administrator", async () => {
      routes.push((url) =>
        url.pathname === "/api/shape/559-first/esign" ? json(list) : undefined,
      );
      await expect(
        plugin().tool("fi_user_esign", context()).execute("e3b", {
          action: "send",
          project: "559-first",
          documentId: "doc-9",
          templateId: 9,
        }),
      ).rejects.toThrow(/use action=prepare/);
    });

    it("prepares a template from the reviewed manifest through Fi's signing verb, as the requester", async () => {
      routes.push((url, init) =>
        url.pathname === "/api/shape/signature/prepare" && init.method === "POST"
          ? json({ ok: true, result: { applied: true, prepared: { templateId: 77 } } })
          : undefined,
      );
      const manifest = {
        documentKind: "consent",
        sourceSha256: "a".repeat(64),
        pageCount: 2,
        fields: [],
      };
      const tool = plugin().tool("fi_user_esign", context());
      await expect(
        tool.execute("p0", { action: "prepare", project: "559-first", documentId: "doc-1" }),
      ).rejects.toThrow(/manifest/);
      const base = {
        action: "prepare",
        project: "559-first",
        documentId: "doc-1",
        ownerRole: "Managing Member",
        manifest,
      };
      const result = await tool.execute("p1", base);
      expect(result.details).toMatchObject({ ok: true, result: { prepared: { templateId: 77 } } });
      await tool.execute("p2", { ...base, dryRun: true });
      const sent = calls.filter((entry) => entry.url.endsWith("/api/shape/signature/prepare"));
      expect(sent.map((entry) => bodyJson(entry.init))).toEqual([
        {
          input: {
            project: "559-first",
            document: "doc-1",
            ownerRole: "Managing Member",
            manifest,
          },
        },
        {
          input: {
            project: "559-first",
            document: "doc-1",
            ownerRole: "Managing Member",
            manifest,
          },
          dryRun: true,
        },
      ]);
    });

    describe("send_envelope", () => {
      const args = {
        action: "send_envelope",
        project: "559-first",
        documentId: "doc-1",
        templateId: 77,
        ownerRole: "Managing Member",
        ownerEmail: "Lorenzo@Example.com",
        additionalSigners: [{ role: "Seller", email: "seller@counterparty.example" }],
        completionCopies: ["member@example.com"],
        delivery: "docuseal",
      };
      const route = [
        { kind: "signer", role: "Managing Member", email: "lorenzo@example.com" },
        { kind: "signer", role: "Seller", email: "seller@counterparty.example" },
        { kind: "completion", email: "member@example.com" },
      ];
      const sends = () => calls.filter((entry) => entry.url.endsWith("/api/shape/signature/send"));

      beforeEach(() => {
        routes.push((url, init) =>
          url.pathname === "/api/shape/signature/send" && init.method === "POST"
            ? json({
                ok: true,
                result: { applied: bodyJson(init).dryRun !== true, submissionId: 140 },
              })
            : undefined,
        );
      });

      it("checks the stated route with Fi, previews it verbatim, and sends only the approved route", async () => {
        const tool = plugin().tool("fi_user_esign", context());
        const preview = await tool.execute("s1", args);
        expect(preview.details).toMatchObject({
          preview: true,
          delivery: "docuseal",
          emailsRecipients: true,
          route: [
            "signer (Managing Member): lorenzo@example.com",
            "signer (Seller): seller@counterparty.example",
            "completion copy: member@example.com",
          ],
          routeCode: expect.stringMatching(/^[0-9a-f]{16}$/),
        });
        expect(sends()).toHaveLength(1);
        const checked = bodyJson(sends()[0]?.init);
        expect(checked).toEqual({
          dryRun: true,
          input: {
            project: "559-first",
            document: "doc-1",
            template: 77,
            ownerRole: "Managing Member",
            additionalRecipients: [
              { kind: "signer", role: "Seller", email: "seller@counterparty.example" },
            ],
            completionBcc: ["member@example.com"],
            confirmedRecipients: route,
            delivery: "docuseal",
            additionalRecipientsConfirmed: false,
          },
        });
        const { routeCode } = preview.details as { routeCode: string };
        // A route that changed after the preview is not the approved one.
        await expect(
          tool.execute("s2", {
            ...args,
            completionCopies: [...args.completionCopies, "extra@example.com"],
            confirmRoute: routeCode,
          }),
        ).rejects.toThrow(/not the route the requester approved/);
        await expect(
          tool.execute("s3", { ...args, delivery: "hold", confirmRoute: routeCode }),
        ).rejects.toThrow(/not the route the requester approved/);
        expect(sends()).toHaveLength(1);
        const sent = await tool.execute("s4", { ...args, confirmRoute: routeCode });
        expect(sent.details).toMatchObject({
          ok: true,
          result: { applied: true, submissionId: 140 },
        });
        expect(bodyJson(sends()[1]?.init)).toEqual({
          input: { ...(checked.input as object), additionalRecipientsConfirmed: true },
        });
      });

      it("needs the owner signatory stated, holds by default, and adds nobody", async () => {
        const tool = plugin().tool("fi_user_esign", context());
        const { ownerEmail: _ownerEmail, ...noOwner } = args;
        await expect(tool.execute("s5", noOwner)).rejects.toThrow(/ownerRole and ownerEmail/);
        const { delivery: _delivery, completionCopies: _copies, ...held } = args;
        const preview = await tool.execute("s6", held);
        expect(preview.details).toMatchObject({ delivery: "hold", emailsRecipients: false });
        // The requester is not slipped onto the completion copy.
        expect(bodyJson(sends()[0]?.init).input).toMatchObject({
          delivery: "hold",
          completionBcc: [],
          confirmedRecipients: route.slice(0, 2),
        });
      });
    });

    describe("a company document", () => {
      const company = {
        action: "send_envelope",
        company: "shape-equity-partners",
        documentId: "sep-doc",
        templateId: 91,
        ownerRole: "Managing Member",
        ownerEmail: "Lorenzo@Example.com",
        completionCopies: ["member@example.com"],
        delivery: "docuseal",
      };

      beforeEach(() => {
        routes.push((url, init) =>
          (url.pathname === "/api/shape/signature/send" ||
            url.pathname === "/api/shape/signature/prepare") &&
          init.method === "POST"
            ? json({
                ok: true,
                result: { applied: bodyJson(init).dryRun !== true, submissionId: 150 },
              })
            : undefined,
        );
      });

      it("prepares and sends with the stated signer as the company's primary signer, through the same two steps", async () => {
        const tool = plugin().tool("fi_user_esign", context());
        const manifest = {
          documentKind: "consent",
          sourceSha256: "b".repeat(64),
          pageCount: 1,
          fields: [],
        };
        await expect(
          tool.execute("c0", {
            action: "prepare",
            company: "shape-equity-partners",
            documentId: "sep-doc",
            ownerRole: "Managing Member",
            manifest,
          }),
        ).rejects.toThrow(/ownerEmail/);
        await tool.execute("c1", {
          action: "prepare",
          company: "shape-equity-partners",
          documentId: "sep-doc",
          ownerRole: "Managing Member",
          ownerEmail: "Lorenzo@Example.com",
          manifest,
        });
        const prepared = calls.find((entry) => entry.url.endsWith("/api/shape/signature/prepare"));
        expect(bodyJson(prepared!.init)).toEqual({
          input: {
            company: "shape-equity-partners",
            primarySigner: { role: "Managing Member", email: "lorenzo@example.com" },
            document: "sep-doc",
            manifest,
          },
        });
        const preview = await tool.execute("c2", company);
        const { routeCode } = preview.details as { routeCode: string };
        expect(preview.details).toMatchObject({
          preview: true,
          route: [
            "signer (Managing Member): lorenzo@example.com",
            "completion copy: member@example.com",
          ],
        });
        await tool.execute("c3", { ...company, confirmRoute: routeCode });
        const sends = calls.filter((entry) => entry.url.endsWith("/api/shape/signature/send"));
        expect(sends.map((entry) => bodyJson(entry.init))).toEqual([
          {
            dryRun: true,
            input: {
              company: "shape-equity-partners",
              primarySigner: { role: "Managing Member", email: "lorenzo@example.com" },
              document: "sep-doc",
              template: 91,
              additionalRecipients: [],
              completionBcc: ["member@example.com"],
              confirmedRecipients: [
                { kind: "signer", role: "Managing Member", email: "lorenzo@example.com" },
                { kind: "completion", email: "member@example.com" },
              ],
              delivery: "docuseal",
              additionalRecipientsConfirmed: false,
            },
          },
          {
            input: expect.objectContaining({
              company: "shape-equity-partners",
              additionalRecipientsConfirmed: true,
            }),
          },
        ]);
        // The same route code does not carry over to a project of the same name and template.
        await expect(
          tool.execute("c4", {
            ...company,
            company: undefined,
            project: "shape-equity-partners",
            confirmRoute: routeCode,
          }),
        ).rejects.toThrow(/not the route the requester approved/);
      });

      it("requires an owner for writes and refuses company template listing", async () => {
        const tool = plugin().tool("fi_user_esign", context());
        await expect(tool.execute("c5", { ...company, project: "559-first" })).rejects.toThrow(
          /exactly one of project or company/,
        );
        await expect(tool.execute("c6", { action: "send" })).rejects.toThrow(
          /exactly one of project or company/,
        );
        await expect(
          tool.execute("c7", { action: "list", company: "shape-equity-partners" }),
        ).rejects.toThrow(/per project/);
        expect(calls.some((entry) => entry.url.includes("/signature/"))).toBe(false);
      });
    });
  });
}
