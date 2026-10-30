/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import authSchema from "./betterAuth/schema";
import schema from "./schema";
import { SUPPORT_RATE_LIMITS } from "./support";
import { supportNotificationRecipients } from "./supportNotifications";
import { isAcceptableSupportScreenshot } from "../shared/support";

const modules = import.meta.glob("./**/*.ts");
const authModules = Object.fromEntries(
  Object.entries(import.meta.glob("./betterAuth/**/*.ts")).map(
    ([path, load]) => [`./${path.slice("./betterAuth/".length)}`, load],
  ),
);

type T = TestConvex<typeof schema>;
const previousEnv = { ...process.env };

afterEach(() => {
  process.env = { ...previousEnv };
  vi.unstubAllGlobals();
});

function createBackend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

async function createUser(t: T, options: { role?: string; admin?: boolean } = {}) {
  const role = options.role ?? "user";
  const { userId, sessionId, email } = await t.run(async (ctx) => {
    const now = Date.now();
    const email = `${role}-${crypto.randomUUID()}@example.com`;
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "user", data: {
        name: "Ama Mensah", email, emailVerified: true, createdAt: now, updatedAt: now,
        role, banned: false, twoFactorEnabled: options.admin === true,
      } },
    });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "session", data: {
        token: `secret-${crypto.randomUUID()}`, userId: user._id, expiresAt: now + 60 * 60_000, createdAt: now, updatedAt: now,
        ...(options.admin ? { adminTwoFactorVerifiedAt: now } : {}),
      } },
    });
    return { userId: user._id as string, sessionId: session._id, email };
  });
  return { userId, email, client: t.withIdentity({ subject: userId, sessionId }) };
}

async function enableAdminPanel(t: T) {
  process.env.ADMIN_PANEL_ENABLED = "true";
  process.env.ADMIN_ENVIRONMENT = "test";
  await t.run(async (ctx) => {
    await ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: Date.now() });
  });
}

const guestMessage = {
  category: "bug" as const,
  subject: "Citations do not open",
  message: "Clicking a citation in my answer does nothing on Safari.",
  email: "Guest@Example.com",
  name: "Kofi",
  pagePath: "/research",
};

describe("submitTicket", () => {
  it("saves a guest message with a normalized email and returns a reference", async () => {
    const t = createBackend();
    const result = await t.mutation(api.support.submitTicket, guestMessage);
    expect(result.reference).toMatch(/^[A-Z0-9]{8}$/);
    const tickets = await t.run((ctx) => ctx.db.query("supportTickets").take(10));
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      category: "bug", status: "new", email: "guest@example.com", name: "Kofi", pagePath: "/research",
    });
    expect(tickets[0].userId).toBeUndefined();
  });

  it("uses the signed-in account's email instead of anything typed in", async () => {
    const t = createBackend();
    const { client, userId, email } = await createUser(t);
    await client.mutation(api.support.submitTicket, { ...guestMessage, email: "someone-else@example.com", name: "Not me" });
    const [ticket] = await t.run((ctx) => ctx.db.query("supportTickets").take(1));
    expect(ticket).toMatchObject({ userId, email, name: "Ama Mensah" });
  });

  it("requires a valid email from guests", async () => {
    const t = createBackend();
    await expect(t.mutation(api.support.submitTicket, { ...guestMessage, email: "not-an-email" })).rejects.toThrow();
    await expect(t.mutation(api.support.submitTicket, { ...guestMessage, email: undefined })).rejects.toThrow();
  });

  it("rejects messages that are too short or too long", async () => {
    const t = createBackend();
    await expect(t.mutation(api.support.submitTicket, { ...guestMessage, message: "short" })).rejects.toThrow();
    await expect(t.mutation(api.support.submitTicket, { ...guestMessage, subject: "x".repeat(151) })).rejects.toThrow();
  });

  it("drops off-site page paths", async () => {
    const t = createBackend();
    await t.mutation(api.support.submitTicket, { ...guestMessage, pagePath: "//evil.example/phish" });
    const [ticket] = await t.run((ctx) => ctx.db.query("supportTickets").take(1));
    expect(ticket.pagePath).toBeUndefined();
  });

  it("quietly discards bot submissions that fill the hidden field", async () => {
    const t = createBackend();
    const result = await t.mutation(api.support.submitTicket, { ...guestMessage, website: "https://spam.example" });
    expect(result.reference).toMatch(/^[A-Z0-9]{8}$/);
    expect(await t.run((ctx) => ctx.db.query("supportTickets").take(1))).toHaveLength(0);
  });

  it("never deletes a caller-supplied file on the bot path", async () => {
    const t = createBackend();
    const someoneElsesFile = await t.run((ctx) => ctx.storage.store(new Blob(["original document"])));
    await t.mutation(api.support.submitTicket, { ...guestMessage, website: "x", screenshotId: someoneElsesFile });
    expect(await t.run((ctx) => ctx.db.system.get("_storage", someoneElsesFile))).not.toBeNull();
  });

  it("limits how often one guest email can write", async () => {
    const t = createBackend();
    for (let index = 0; index < SUPPORT_RATE_LIMITS.perGuestEmailPerHour; index++) {
      await t.mutation(api.support.submitTicket, guestMessage);
    }
    await expect(t.mutation(api.support.submitTicket, guestMessage)).rejects.toThrow(/SUPPORT_RATE_LIMITED|try again/);
    await t.mutation(api.support.submitTicket, { ...guestMessage, email: "other@example.com" });
  });

  it("limits how often a signed-in user can write", async () => {
    const t = createBackend();
    const { client } = await createUser(t);
    for (let index = 0; index < SUPPORT_RATE_LIMITS.perUserPerHour; index++) {
      await client.mutation(api.support.submitTicket, guestMessage);
    }
    await expect(client.mutation(api.support.submitTicket, guestMessage)).rejects.toThrow();
  });

  it("only lets signed-in users upload screenshots", async () => {
    const t = createBackend();
    await expect(t.mutation(api.support.generateScreenshotUploadUrl, {})).rejects.toThrow();
    const { client } = await createUser(t);
    await expect(client.mutation(api.support.generateScreenshotUploadUrl, {})).resolves.toEqual(expect.any(String));
  });

  it("only accepts small image screenshots", () => {
    expect(isAcceptableSupportScreenshot({ contentType: "image/png", size: 1024 })).toBe(true);
    expect(isAcceptableSupportScreenshot({ contentType: "text/html", size: 1024 })).toBe(false);
    expect(isAcceptableSupportScreenshot({ contentType: undefined, size: 1024 })).toBe(false);
    expect(isAcceptableSupportScreenshot({ contentType: "image/jpeg", size: 6 * 1024 * 1024 })).toBe(false);
  });

  it("refuses an uploaded file that is not a recognized image", async () => {
    const t = createBackend();
    const { client } = await createUser(t);
    const upload = await t.run((ctx) => ctx.storage.store(new Blob(["<script>alert(1)</script>"])));
    await expect(client.mutation(api.support.submitTicket, { ...guestMessage, screenshotId: upload })).rejects.toThrow(/Screenshots must be/);
    expect(await t.run((ctx) => ctx.db.query("supportTickets").take(1))).toHaveLength(0);
  });

  it("does not let guests attach files", async () => {
    const t = createBackend();
    const image = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array([1])], { type: "image/png" })));
    await expect(t.mutation(api.support.submitTicket, { ...guestMessage, screenshotId: image })).rejects.toThrow();
  });
});

describe("storage retention", () => {
  it("keeps screenshots attached to messages and clears unattached uploads", async () => {
    vi.useFakeTimers();
    try {
      const t = createBackend();
      const { attached, orphan } = await t.run(async (ctx) => {
        const attached = await ctx.storage.store(new Blob(["png"]));
        const orphan = await ctx.storage.store(new Blob(["png"]));
        await ctx.db.insert("supportTickets", {
          category: "bug", subject: "Broken", message: "Something broke today.", status: "new",
          email: "a@example.com", screenshotId: attached, createdAt: Date.now(), updatedAt: Date.now(),
        });
        await ctx.db.insert("retentionState", {
          key: "default", phase: "storage", cycleHadChanges: false, storagePassHadChanges: false,
          deletedTotal: 0, lastStartedAt: Date.now(), updatedAt: Date.now(),
        });
        return { attached, orphan };
      });
      vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60_000);
      await t.mutation(internal.admin.operations.runRetentionBatch, { cursor: null });
      expect(await t.run((ctx) => ctx.db.system.get("_storage", attached))).not.toBeNull();
      expect(await t.run((ctx) => ctx.db.system.get("_storage", orphan))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("notifyNewTicket", () => {
  it("parses a comma-separated admin recipient list", () => {
    expect(supportNotificationRecipients(" a@example.com, nope ,b@example.com")).toEqual(["a@example.com", "b@example.com"]);
    expect(supportNotificationRecipients(undefined)).toEqual([]);
  });

  it("emails the admins and sends a receipt to signed-in users, escaping content", async () => {
    process.env.RESEND_API_KEY = "configured-for-test";
    process.env.SUPPORT_NOTIFICATION_EMAIL = "owner@example.com";
    process.env.SITE_URL = "https://app.example.com";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const t = createBackend();
    const { client, email } = await createUser(t);
    await client.mutation(api.support.submitTicket, { ...guestMessage, subject: "<b>Broken</b> page" });
    const [ticket] = await t.run((ctx) => ctx.db.query("supportTickets").take(1));
    await t.action(internal.supportNotifications.notifyNewTicket, { ticketId: ticket._id });

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)));
    expect(bodies.map((body) => body.to).sort()).toEqual([email, "owner@example.com"].sort());
    const adminEmail = bodies.find((body) => body.to === "owner@example.com");
    expect(adminEmail.html).toContain("&lt;b&gt;Broken&lt;/b&gt;");
    expect(adminEmail.html).toContain(`https://app.example.com/admin/feedback/${ticket._id}`);
  });

  it("never emails a receipt to an address a guest typed in", async () => {
    process.env.RESEND_API_KEY = "configured-for-test";
    process.env.SUPPORT_NOTIFICATION_EMAIL = "owner@example.com";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const t = createBackend();
    await t.mutation(api.support.submitTicket, guestMessage);
    const [ticket] = await t.run((ctx) => ctx.db.query("supportTickets").take(1));
    await t.action(internal.supportNotifications.notifyNewTicket, { ticketId: ticket._id });
    const recipients = fetchMock.mock.calls.map((call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)).to);
    expect(recipients).toEqual(["owner@example.com"]);
  });

  it("skips email entirely when email is not configured", async () => {
    delete process.env.RESEND_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const t = createBackend();
    await t.mutation(api.support.submitTicket, guestMessage);
    const [ticket] = await t.run((ctx) => ctx.db.query("supportTickets").take(1));
    await t.action(internal.supportNotifications.notifyNewTicket, { ticketId: ticket._id });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("admin feedback inbox", () => {
  it("lets support agents list, filter, read and triage messages", async () => {
    const t = createBackend();
    await enableAdminPanel(t);
    await t.mutation(api.support.submitTicket, guestMessage);
    await t.mutation(api.support.submitTicket, { ...guestMessage, category: "feature_request", email: "two@example.com" });
    const { client: agent, userId: agentId } = await createUser(t, { role: "support_agent", admin: true });

    const all = await agent.query(api.admin.support.listTickets, { paginationOpts: { numItems: 10, cursor: null } });
    expect(all.page).toHaveLength(2);
    const bugs = await agent.query(api.admin.support.listTickets, { paginationOpts: { numItems: 10, cursor: null }, category: "bug" });
    expect(bugs.page).toHaveLength(1);

    const ticketId = bugs.page[0].id;
    await agent.mutation(api.admin.support.updateTicketStatus, { ticketId, status: "resolved" });
    await agent.mutation(api.admin.support.addTicketNote, { ticketId, body: "Fixed in the latest release." });

    const detail = await agent.query(api.admin.support.getTicket, { ticketId });
    expect(detail?.ticket).toMatchObject({ status: "resolved", message: guestMessage.message });
    expect(detail?.ticket.resolvedAt).toEqual(expect.any(Number));
    expect(detail?.notes.map((note) => note.kind)).toEqual(["status", "note"]);
    expect(detail?.notes[0]).toMatchObject({ actorId: agentId, body: "Status changed from New to Resolved" });

    const resolved = await agent.query(api.admin.support.listTickets, { paginationOpts: { numItems: 10, cursor: null }, status: "resolved", category: "bug" });
    expect(resolved.page).toHaveLength(1);

    const audit = await t.run((ctx) => ctx.db.query("auditEvents").take(10));
    expect(audit.map((event) => event.action).sort()).toEqual(["support_ticket.note_added", "support_ticket.status_changed"]);
  });

  it("keeps read-only roles out of triage and other users out entirely", async () => {
    const t = createBackend();
    await enableAdminPanel(t);
    await t.mutation(api.support.submitTicket, guestMessage);
    const [ticket] = await t.run((ctx) => ctx.db.query("supportTickets").take(1));

    const { client: auditor } = await createUser(t, { role: "auditor", admin: true });
    await expect(auditor.query(api.admin.support.listTickets, { paginationOpts: { numItems: 10, cursor: null } })).resolves.toMatchObject({ page: [expect.anything()] });
    await expect(auditor.mutation(api.admin.support.updateTicketStatus, { ticketId: ticket._id, status: "closed" })).rejects.toThrow();

    const { client: member } = await createUser(t);
    await expect(member.query(api.admin.support.listTickets, { paginationOpts: { numItems: 10, cursor: null } })).rejects.toThrow();
    await expect(t.query(api.admin.support.getTicket, { ticketId: ticket._id })).rejects.toThrow();
  });
});
