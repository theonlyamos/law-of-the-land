import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../../convex/_generated/api";
import { getFunctionName } from "convex/server";

const mocks = vi.hoisted(() => ({ authorizeAdminPage: vi.fn(), fetchAuthQuery: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/admin/server", () => ({ authorizeAdminPage: mocks.authorizeAdminPage }));
vi.mock("@/lib/auth-server", () => ({ fetchAuthQuery: mocks.fetchAuthQuery }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/components/admin/catalog-actions", () => ({
  JurisdictionEditor: (props: unknown) => <output data-testid="editor-props">{JSON.stringify(props)}</output>,
  JurisdictionLifecycleActions: (props: unknown) => <output data-testid="lifecycle-props">{JSON.stringify(props)}</output>,
}));
import JurisdictionsPage from "./page";

beforeEach(() => {
  mocks.authorizeAdminPage.mockReset();
  mocks.fetchAuthQuery.mockReset();
  mocks.redirect.mockReset();
  mocks.redirect.mockImplementation(() => { throw new Error("NEXT_REDIRECT"); });
});
afterEach(cleanup);

describe("typed jurisdiction register", () => {
  it("redirects denied users before any catalog fetch", async () => {
    mocks.authorizeAdminPage.mockResolvedValue({ status: "denied" });
    await expect(JurisdictionsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.fetchAuthQuery).not.toHaveBeenCalled();
  });

  it("loads one safe 20-row table page and writer-only bounded options", async () => {
    mocks.authorizeAdminPage.mockResolvedValue({ status: "authorized", currentAdmin: { userId: "manager", roles: ["content_manager"] } });
    mocks.fetchAuthQuery.mockImplementation((reference: Parameters<typeof getFunctionName>[0]) => {
      const name = getFunctionName(reference);
      if (name === "admin/jurisdictions:listAdminJurisdictions") return Promise.resolve({ page: [], isDone: true, continueCursor: "" });
      if (name === "admin/organizations:listActiveOrganizationOptions") return Promise.resolve({ page: [{ id: "org_1", name: "WHO", slug: "who", class: "intergovernmental" }], isDone: true, continueCursor: "" });
      return Promise.resolve({ page: [{ id: "geo_1", name: "Ghana", level: "country", parent: null }], isDone: true, continueCursor: "" });
    });
    render(await JurisdictionsPage({ searchParams: Promise.resolve({ status: "draft", kind: "organizational", query: "health" }) }));
    const calls = mocks.fetchAuthQuery.mock.calls;
    expect(getFunctionName(calls[0][0])).toBe("admin/jurisdictions:listAdminJurisdictions");
    expect(calls[0][1]).toEqual({
      status: "draft", kind: "organizational", query: "health", paginationOpts: { numItems: 20, cursor: null },
    });
    expect(calls.map((call) => getFunctionName(call[0]))).toEqual([
      "admin/jurisdictions:listAdminJurisdictions",
      "admin/organizations:listActiveOrganizationOptions",
      "admin/jurisdictions:listGeographicJurisdictionOptions",
    ]);
    expect(calls[1][1]).toEqual({ paginationOpts: { numItems: 20, cursor: null } });
    expect(calls[2][1]).toEqual({ purpose: "linked_scope", paginationOpts: { numItems: 20, cursor: null } });
    expect(screen.getByTestId("editor-props")).toHaveTextContent("org_1");
  });

  it("passes no selector projections to a read-only administrator", async () => {
    mocks.authorizeAdminPage.mockResolvedValue({ status: "authorized", currentAdmin: { userId: "auditor", roles: ["auditor"] } });
    mocks.fetchAuthQuery.mockResolvedValue({ page: [{
      id: "geo_1", name: "Ghana", slug: "ghana", status: "enabled", kind: "geographic", visibility: "public",
      provider: { syncState: "synced", stagingConfigured: true, productionConfigured: true }, migrationState: "typed",
      geographic: { level: "country", parent: null }, organization: null, scopeMode: null,
    }], isDone: true, continueCursor: "" });
    render(await JurisdictionsPage({ searchParams: Promise.resolve({}) }));
    expect(mocks.fetchAuthQuery).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("editor-props")).toBeNull();
    expect(screen.getByText("Staging: Configured")).toBeVisible();
    expect(screen.getByText("Production: Configured")).toBeVisible();
    expect(screen.queryByText(/bucket/i)).toBeNull();
    expect(screen.queryByText(/place/i)).toBeNull();
  });

  it("passes draft jurisdictions to lifecycle controls for a writer", async () => {
    mocks.authorizeAdminPage.mockResolvedValue({ status: "authorized", currentAdmin: { userId: "manager", roles: ["content_manager"] } });
    mocks.fetchAuthQuery.mockImplementation((reference: Parameters<typeof getFunctionName>[0]) => {
      if (getFunctionName(reference) === "admin/jurisdictions:listAdminJurisdictions") return Promise.resolve({ page: [{
        id: "geo_1", name: "Ghana", slug: "ghana", status: "draft", kind: "geographic", visibility: "public",
        provider: { syncState: "pending", stagingConfigured: false, productionConfigured: false }, migrationState: "typed",
        geographic: { level: "country", parent: null }, organization: null, scopeMode: null,
      }], isDone: true, continueCursor: "" });
      return Promise.resolve({ page: [], isDone: true, continueCursor: "" });
    });

    render(await JurisdictionsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByTestId("lifecycle-props")).toHaveTextContent('"id":"geo_1"');
    expect(screen.getByTestId("lifecycle-props")).toHaveTextContent('"status":"draft"');
    expect(screen.getByTestId("lifecycle-props")).toHaveTextContent('"editable":true');
  });

  it("keeps legacy migration rows on lifecycle transitions without typed editing", async () => {
    mocks.authorizeAdminPage.mockResolvedValue({ status: "authorized", currentAdmin: { userId: "manager", roles: ["content_manager"] } });
    mocks.fetchAuthQuery.mockImplementation((reference: Parameters<typeof getFunctionName>[0]) => {
      if (getFunctionName(reference) === "admin/jurisdictions:listAdminJurisdictions") return Promise.resolve({ page: [{
        id: "legacy_1", name: "Ghana", slug: "ghana", status: "draft", kind: "geographic", visibility: "public",
        provider: { syncState: "pending", stagingConfigured: false, productionConfigured: true }, migrationState: "legacy",
        geographic: null, organization: null, scopeMode: null,
      }], isDone: true, continueCursor: "" });
      return Promise.resolve({ page: [], isDone: true, continueCursor: "" });
    });

    render(await JurisdictionsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByTestId("lifecycle-props")).toHaveTextContent('"id":"legacy_1"');
    expect(screen.getByTestId("lifecycle-props")).toHaveTextContent('"editable":false');
  });

  it("keeps the safe table available when writer selector options fail", async () => {
    mocks.authorizeAdminPage.mockResolvedValue({ status: "authorized", currentAdmin: { userId: "manager", roles: ["content_manager"] } });
    mocks.fetchAuthQuery.mockImplementation((reference: Parameters<typeof getFunctionName>[0]) => {
      const name = getFunctionName(reference);
      if (name === "admin/jurisdictions:listAdminJurisdictions") return Promise.resolve({ page: [{
        id: "geo_1", name: "Ghana", slug: "ghana", status: "draft", kind: "geographic", visibility: "public",
        provider: { syncState: "pending", stagingConfigured: false, productionConfigured: false }, migrationState: "typed",
        geographic: { level: "country", parent: null }, organization: null, scopeMode: null,
      }], isDone: true, continueCursor: "" });
      if (name === "admin/organizations:listActiveOrganizationOptions") return Promise.reject(new Error("outage"));
      return Promise.resolve({ page: [], isDone: true, continueCursor: "" });
    });
    render(await JurisdictionsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("Ghana")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/creation options/i);
    expect(screen.queryByTestId("editor-props")).toBeNull();
  });
});
