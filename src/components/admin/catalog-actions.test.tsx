import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../convex/_generated/api";
import { getFunctionName } from "convex/server";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  createGeographic: vi.fn(),
  createOrganizational: vi.fn(),
  createOrganization: vi.fn(),
  updateGeographic: vi.fn(),
  updateOrganizational: vi.fn(),
  enableJurisdiction: vi.fn(),
  archiveJurisdiction: vi.fn(),
  provisionGemini: vi.fn(),
  deleteGemini: vi.fn(),
  queryResult: vi.fn(),
}));

vi.mock("convex/react", () => ({ useQuery_experimental: (options: unknown) => mocks.queryResult(options), useMutation: (reference: Parameters<typeof getFunctionName>[0]) => {
  const name = getFunctionName(reference);
  if (name === "admin/jurisdictions:createGeographicJurisdiction") return mocks.createGeographic;
  if (name === "admin/jurisdictions:createOrganizationalJurisdiction") return mocks.createOrganizational;
  if (name === "admin/jurisdictions:updateGeographicJurisdiction") return mocks.updateGeographic;
  if (name === "admin/jurisdictions:updateOrganizationalJurisdiction") return mocks.updateOrganizational;
  if (name === "admin/jurisdictions:enableJurisdiction") return mocks.enableJurisdiction;
  if (name === "admin/jurisdictions:archiveJurisdiction") return mocks.archiveJurisdiction;
  if (name === "admin/jobs:provisionJurisdictionGeminiStore") return mocks.provisionGemini;
  if (name === "admin/jobs:deleteJurisdictionGeminiStore") return mocks.deleteGemini;
  if (name === "admin/organizations:createOrganization") return mocks.createOrganization;
  return vi.fn();
} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("./geographic-place-picker", () => ({ GeographicPlacePicker: ({ onChange }: { onChange(value: unknown): void }) => (<>
  <button type="button" onClick={() => onChange({
    place: { placeId: "accra", displayName: "Accra", formattedAddress: "Accra, Ghana", latitude: 5.6, longitude: -0.2, types: ["locality"], countryCode: "GH", addressComponents: [{ longText: "Ghana", shortText: "GH", types: ["country"] }] },
    verifiedPlaceClaim: "signed-claim",
    expiresAt: Date.now() + 60_000,
  })}>Select verified Accra</button>
  <button type="button" onClick={() => onChange(null)}>Expire verified Accra</button>
</>) }));

import { JurisdictionEditor, JurisdictionLifecycleActions, ResourceEditor } from "./catalog-actions";

const organizations = [{ id: "org_1", name: "World Health Organization", slug: "who", class: "intergovernmental" as const }];
const geographies = [{ id: "geo_1", name: "Ghana", level: "country" as const, parent: null }];

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.createOrganization.mockResolvedValue("org_new");
  mocks.createGeographic.mockResolvedValue("jurisdiction_geo");
  mocks.createOrganizational.mockResolvedValue("jurisdiction_org");
  mocks.updateGeographic.mockResolvedValue({ status: "draft" });
  mocks.updateOrganizational.mockResolvedValue({ status: "draft" });
  mocks.enableJurisdiction.mockResolvedValue({ status: "enabled" });
  mocks.archiveJurisdiction.mockResolvedValue({ status: "archived" });
  mocks.provisionGemini.mockResolvedValue({ jobId: "job_1", duplicate: false });
  mocks.deleteGemini.mockResolvedValue({ jobId: "job_2", duplicate: false });
  mocks.queryResult.mockReturnValue({ status: "pending" });
});
afterEach(cleanup);

describe("typed jurisdiction creation", () => {
  it("starts type-first and removes legacy identity inputs", () => {
    render(<JurisdictionEditor organizations={organizations} geographicOptions={geographies} />);
    expect(screen.getByRole("radio", { name: "Geographic" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "Organizational" })).toBeVisible();
    expect(screen.queryByLabelText("ISO country code")).toBeNull();
    expect(screen.queryByLabelText("URL slug")).toBeNull();
    expect(screen.queryByLabelText("Default jurisdiction")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Geographic" }));
    expect(screen.queryByText(/bucket/i)).toBeNull();
  });

  it("creates a country draft from only a verified claim and shared fields", async () => {
    render(<JurisdictionEditor organizations={organizations} geographicOptions={geographies} />);
    fireEvent.click(screen.getByRole("radio", { name: "Geographic" }));
    fireEvent.click(await screen.findByRole("button", { name: "Select verified Accra" }));
    fireEvent.change(screen.getByLabelText("Geographic level"), { target: { value: "country" } });
    fireEvent.change(screen.getByLabelText("Audit reason"), { target: { value: "Add governed country" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft jurisdiction" }));
    await waitFor(() => expect(mocks.createGeographic).toHaveBeenCalledWith({
      verifiedPlaceClaim: "signed-claim",
      level: "country",
      reason: "Add governed country",
    }));
  });

  it("requires an explicit permitted parent for a non-root geography", async () => {
    render(<JurisdictionEditor organizations={organizations} geographicOptions={geographies} />);
    fireEvent.click(screen.getByRole("radio", { name: "Geographic" }));
    fireEvent.click(await screen.findByRole("button", { name: "Select verified Accra" }));
    fireEvent.change(screen.getByLabelText("Geographic level"), { target: { value: "city" } });
    fireEvent.change(screen.getByLabelText("Audit reason"), { target: { value: "Add governed city" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft jurisdiction" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/parent/i);
    expect(mocks.createGeographic).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Governed parent"), { target: { value: "geo_1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft jurisdiction" }));
    await waitFor(() => expect(mocks.createGeographic).toHaveBeenCalledWith(expect.objectContaining({ parentJurisdictionId: "geo_1" })));
  });

  it("uses verified address aliases only to request parent suggestions", async () => {
    render(<JurisdictionEditor organizations={organizations} geographicOptions={geographies} />);
    fireEvent.click(screen.getByRole("radio", { name: "Geographic" }));
    fireEvent.click(await screen.findByRole("button", { name: "Select verified Accra" }));
    fireEvent.change(screen.getByLabelText("Geographic level"), { target: { value: "city" } });
    const aliasCall = mocks.queryResult.mock.calls.find((call) => getFunctionName(call[0].query) === "admin/jurisdictions:suggestGeographicParentsByAliases");
    expect(aliasCall?.[0].args).toEqual({ childLevel: "city", aliases: ["Ghana", "GH"] });
    expect(screen.getByLabelText("Governed parent")).toHaveValue("");
  });

  it("submits a member organization with distinct linked geographies and never mounts Places", async () => {
    render(<JurisdictionEditor organizations={organizations} geographicOptions={geographies} />);
    fireEvent.click(screen.getByRole("radio", { name: "Organizational" }));
    expect(screen.queryByLabelText("Find place")).toBeNull();
    fireEvent.change(screen.getByLabelText("Organization"), { target: { value: "org_1" } });
    fireEvent.change(screen.getByLabelText("Visibility"), { target: { value: "members" } });
    fireEvent.change(screen.getByLabelText("Scope mode"), { target: { value: "linked_geographies" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Ghana" }));
    fireEvent.change(screen.getByLabelText("Audit reason"), { target: { value: "Add member scope" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft jurisdiction" }));
    await waitFor(() => expect(mocks.createOrganizational).toHaveBeenCalledWith({
      organizationId: "org_1",
      visibility: "members",
      scopeMode: "linked_geographies",
      geographicJurisdictionIds: ["geo_1"],
      reason: "Add member scope",
    }));
  });

  it("does not create a jurisdiction when inline organization creation fails", async () => {
    mocks.createOrganization.mockRejectedValue(new Error("denied"));
    render(<JurisdictionEditor organizations={organizations} geographicOptions={geographies} />);
    fireEvent.click(screen.getByRole("radio", { name: "Organizational" }));
    fireEvent.click(screen.getByRole("radio", { name: "Create organization" }));
    fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "New Body" } });
    fireEvent.change(screen.getByLabelText("Organization slug"), { target: { value: "new-body" } });
    fireEvent.change(screen.getByLabelText("Audit reason"), { target: { value: "Add organization" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft jurisdiction" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(mocks.createOrganizational).not.toHaveBeenCalled();
  });

  it("uses the returned organization ID only after inline creation succeeds", async () => {
    render(<JurisdictionEditor organizations={organizations} geographicOptions={geographies} />);
    fireEvent.click(screen.getByRole("radio", { name: "Organizational" }));
    fireEvent.click(screen.getByRole("radio", { name: "Create organization" }));
    fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "New Body" } });
    fireEvent.change(screen.getByLabelText("Organization slug"), { target: { value: "new-body" } });
    fireEvent.change(screen.getByLabelText("Audit reason"), { target: { value: "Add organization" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft jurisdiction" }));
    await waitFor(() => expect(mocks.createOrganizational).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org_new" })));
    expect(mocks.createOrganization.mock.invocationCallOrder[0]).toBeLessThan(mocks.createOrganizational.mock.invocationCallOrder[0]);
  });

  it("retries only jurisdiction creation after an inline organization succeeds", async () => {
    mocks.createOrganizational.mockRejectedValueOnce(new Error("provider unavailable")).mockResolvedValueOnce("jurisdiction_org");
    render(<JurisdictionEditor organizations={organizations} geographicOptions={geographies} />);
    fireEvent.click(screen.getByRole("radio", { name: "Organizational" }));
    fireEvent.click(screen.getByRole("radio", { name: "Create organization" }));
    fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "New Body" } });
    fireEvent.change(screen.getByLabelText("Organization slug"), { target: { value: "new-body" } });
    fireEvent.change(screen.getByLabelText("Audit reason"), { target: { value: "Add organization" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft jurisdiction" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Create draft jurisdiction" }));
    await waitFor(() => expect(mocks.createOrganizational).toHaveBeenCalledTimes(2));
    expect(mocks.createOrganization).toHaveBeenCalledTimes(1);
    expect(mocks.createOrganizational).toHaveBeenLastCalledWith(expect.objectContaining({ organizationId: "org_new" }));
  });

  it("resets every branch-owned control when switching kinds and after success", async () => {
    render(<JurisdictionEditor organizations={organizations} geographicOptions={geographies} />);
    fireEvent.click(screen.getByRole("radio", { name: "Geographic" }));
    fireEvent.change(screen.getByLabelText("Geographic level"), { target: { value: "city" } });
    fireEvent.click(screen.getByRole("radio", { name: "Organizational" }));
    fireEvent.click(screen.getByRole("radio", { name: "Create organization" }));
    fireEvent.change(screen.getByLabelText("Scope mode"), { target: { value: "linked_geographies" } });
    fireEvent.click(screen.getByRole("radio", { name: "Geographic" }));
    expect(screen.getByLabelText("Geographic level")).toHaveValue("country");
    fireEvent.click(screen.getByRole("radio", { name: "Organizational" }));
    expect(screen.getByRole("radio", { name: "Choose organization" })).toBeChecked();
    expect(screen.getByLabelText("Scope mode")).toHaveValue("global");

    fireEvent.change(screen.getByLabelText("Organization"), { target: { value: "org_1" } });
    fireEvent.change(screen.getByLabelText("Audit reason"), { target: { value: "Add global body" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft jurisdiction" }));
    await waitFor(() => expect(mocks.createOrganizational).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("radio", { name: "Geographic" }));
    expect(screen.getByLabelText("Geographic level")).toHaveValue("country");
  });

  it("does not claim no parent exists before bounded parent search is exhausted", async () => {
    render(<JurisdictionEditor geographicOptions={[{ id: "city_1", name: "Accra", level: "city", parent: null }]} geographicPage={{ nextCursor: "more", isDone: false }} />);
    fireEvent.click(screen.getByRole("radio", { name: "Geographic" }));
    fireEvent.click(screen.getByRole("button", { name: "Select verified Accra" }));
    fireEvent.change(screen.getByLabelText("Geographic level"), { target: { value: "city" } });
    expect(screen.queryByRole("link", { name: /create the parent/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Load more parents" })).toBeVisible();
  });

  it("clears an expired claim and parent and blocks geographic creation", async () => {
    render(<JurisdictionEditor geographicOptions={geographies} />);
    fireEvent.click(screen.getByRole("radio", { name: "Geographic" }));
    fireEvent.click(screen.getByRole("button", { name: "Select verified Accra" }));
    fireEvent.change(screen.getByLabelText("Geographic level"), { target: { value: "city" } });
    fireEvent.change(screen.getByLabelText("Governed parent"), { target: { value: "geo_1" } });
    fireEvent.click(screen.getByRole("button", { name: "Expire verified Accra" }));
    expect(screen.getByLabelText("Governed parent")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Audit reason"), { target: { value: "Add expired city" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft jurisdiction" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/expired/i);
    expect(mocks.createGeographic).not.toHaveBeenCalled();
  });

  it("submits global organization scope with no geographic IDs", async () => {
    render(<JurisdictionEditor organizations={organizations} geographicOptions={geographies} />);
    fireEvent.click(screen.getByRole("radio", { name: "Organizational" }));
    fireEvent.change(screen.getByLabelText("Organization"), { target: { value: "org_1" } });
    fireEvent.change(screen.getByLabelText("Audit reason"), { target: { value: "Add global body" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft jurisdiction" }));
    await waitFor(() => expect(mocks.createOrganizational).toHaveBeenCalledWith(expect.objectContaining({ scopeMode: "global", geographicJurisdictionIds: [] })));
  });

  it("searches and loads more organizations without duplicates or losing the selection", async () => {
    const nextPage = {
      page: [organizations[0], { id: "org_2", name: "African Union", slug: "african-union", class: "intergovernmental" as const }],
      continueCursor: "",
      isDone: true,
    };
    mocks.queryResult.mockImplementation((options) => {
      if (options.args === "skip") return { status: "pending" };
      if (getFunctionName(options.query) === "admin/organizations:listActiveOrganizationOptions") return { status: "success", data: nextPage };
      return { status: "pending" };
    });
    render(<JurisdictionEditor organizations={organizations} organizationPage={{ nextCursor: "org-next", isDone: false }} />);
    fireEvent.click(screen.getByRole("radio", { name: "Organizational" }));
    fireEvent.change(screen.getByLabelText("Organization"), { target: { value: "org_1" } });
    fireEvent.click(screen.getByRole("button", { name: "Load more organizations" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /African Union/ })).toBeVisible());
    expect(mocks.queryResult.mock.calls.some((call) => call[0].args?.paginationOpts?.cursor === "org-next")).toBe(true);
    fireEvent.change(screen.getByLabelText("Find organization"), { target: { value: "African" } });
    fireEvent.click(screen.getByRole("button", { name: "Search organizations" }));
    expect(screen.getByLabelText("Organization")).toHaveValue("org_1");
    expect(screen.getByLabelText("Organization").querySelectorAll("option")).toHaveLength(3);
    expect(mocks.queryResult.mock.calls.some((call) => call[0].args?.query === "African" && call[0].args.paginationOpts?.cursor === null)).toBe(true);
  });

  it("recovers a failed organization query while preserving the current selection", async () => {
    let shouldFail = true;
    const nextPage = {
      page: [{ id: "org_2", name: "African Union", slug: "african-union", class: "intergovernmental" as const }],
      continueCursor: "",
      isDone: true,
    };
    mocks.queryResult.mockImplementation((options) => {
      if (options.args === "skip") return { status: "pending" };
      if (getFunctionName(options.query) === "admin/organizations:listActiveOrganizationOptions") {
        return shouldFail ? { status: "error", error: new Error("denied") } : { status: "success", data: nextPage };
      }
      return { status: "pending" };
    });
    render(<JurisdictionEditor organizations={organizations} organizationPage={{ nextCursor: "org-next", isDone: false }} />);
    fireEvent.click(screen.getByRole("radio", { name: "Organizational" }));
    fireEvent.change(screen.getByLabelText("Organization"), { target: { value: "org_1" } });
    fireEvent.click(screen.getByRole("button", { name: "Load more organizations" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/selection is preserved/i);
    expect(screen.getByLabelText("Organization")).toHaveValue("org_1");

    shouldFail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry organizations" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /African Union/ })).toBeVisible());
    expect(screen.getByLabelText("Organization")).toHaveValue("org_1");
  });

  it("recovers a failed parent query while preserving the governed parent", async () => {
    let shouldFail = true;
    const nextPage = {
      page: [{ id: "geo_2", name: "Nigeria", level: "country" as const, parent: null }],
      continueCursor: "",
      isDone: true,
    };
    mocks.queryResult.mockImplementation((options) => {
      if (options.args === "skip") return { status: "pending" };
      if (getFunctionName(options.query) === "admin/jurisdictions:listGeographicJurisdictionOptions") {
        return shouldFail ? { status: "error", error: new Error("denied") } : { status: "success", data: nextPage };
      }
      return { status: "pending" };
    });
    render(<JurisdictionEditor geographicOptions={geographies} />);
    fireEvent.click(screen.getByRole("radio", { name: "Geographic" }));
    fireEvent.click(screen.getByRole("button", { name: "Select verified Accra" }));
    fireEvent.change(screen.getByLabelText("Geographic level"), { target: { value: "city" } });
    fireEvent.change(screen.getByLabelText("Governed parent"), { target: { value: "geo_1" } });
    fireEvent.click(screen.getByRole("button", { name: "Load more parents" }));
    expect(await screen.findByText(/governed parents could not be loaded/i)).toBeVisible();
    expect(screen.getByLabelText("Governed parent")).toHaveValue("geo_1");

    shouldFail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry parents" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /Nigeria/ })).toBeVisible());
    expect(screen.getByLabelText("Governed parent")).toHaveValue("geo_1");
  });

  it("recovers failed parent suggestions without collapsing the parent selector", async () => {
    let shouldFail = true;
    const suggestion = [{ id: "geo_2", name: "Nigeria", level: "country" as const, parent: null }];
    mocks.queryResult.mockImplementation((options) => {
      if (options.args === "skip") return { status: "pending" };
      if (getFunctionName(options.query) === "admin/jurisdictions:suggestGeographicParentsByAliases") {
        return shouldFail ? { status: "error", error: new Error("denied") } : { status: "success", data: suggestion };
      }
      return { status: "pending" };
    });
    render(<JurisdictionEditor geographicOptions={geographies} />);
    fireEvent.click(screen.getByRole("radio", { name: "Geographic" }));
    fireEvent.click(screen.getByRole("button", { name: "Select verified Accra" }));
    fireEvent.change(screen.getByLabelText("Geographic level"), { target: { value: "city" } });
    expect(await screen.findByText(/parent suggestions could not be loaded/i)).toBeVisible();
    expect(screen.getByRole("option", { name: /Ghana/ })).toBeVisible();

    shouldFail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry parent suggestions" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /Nigeria/ })).toBeVisible());
    expect(screen.getByRole("option", { name: /Ghana/ })).toBeVisible();
  });

  it("recovers a failed linked-geography query without clearing checked scopes", async () => {
    let shouldFail = true;
    const nextPage = {
      page: [{ id: "geo_2", name: "Nigeria", level: "country" as const, parent: null }],
      continueCursor: "",
      isDone: true,
    };
    mocks.queryResult.mockImplementation((options) => {
      if (options.args === "skip") return { status: "pending" };
      if (getFunctionName(options.query) === "admin/jurisdictions:listGeographicJurisdictionOptions") {
        return shouldFail ? { status: "error", error: new Error("denied") } : { status: "success", data: nextPage };
      }
      return { status: "pending" };
    });
    render(<JurisdictionEditor organizations={organizations} geographicOptions={geographies} geographicPage={{ nextCursor: "geo-next", isDone: false }} />);
    fireEvent.click(screen.getByRole("radio", { name: "Organizational" }));
    fireEvent.change(screen.getByLabelText("Scope mode"), { target: { value: "linked_geographies" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Ghana" }));
    fireEvent.click(screen.getByRole("button", { name: "Load more geographies" }));
    expect(await screen.findByText(/linked geographies could not be loaded/i)).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Ghana" })).toBeChecked();

    shouldFail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry geographies" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Nigeria" })).toBeVisible());
    expect(screen.getByRole("checkbox", { name: "Ghana" })).toBeChecked();
  });

  it("rejects sensitive audit text before either mutation", async () => {
    render(<JurisdictionEditor organizations={organizations} geographicOptions={geographies} />);
    fireEvent.click(screen.getByRole("radio", { name: "Geographic" }));
    fireEvent.click(await screen.findByRole("button", { name: "Select verified Accra" }));
    fireEvent.change(screen.getByLabelText("Audit reason"), { target: { value: "Rotate secret token" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft jurisdiction" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/without URLs, email addresses, or sensitive terms/i);
    expect(mocks.createGeographic).not.toHaveBeenCalled();
  });
});

describe("jurisdiction lifecycle actions", () => {
  it("explains paused search and links a needs-review jurisdiction to provider jobs", () => {
    render(<JurisdictionLifecycleActions jurisdiction={{
      id: "geo_1", name: "Ghana", slug: "ghana", status: "draft", kind: "geographic", visibility: "public", scopeMode: null,
      provider: { syncState: "drifted", setupState: "needs_review", storeConfigured: true }, geographic: { level: "country", parent: null },
    }} />);

    expect(screen.getByText("Search is paused for Ghana because its index needs review.")).toBeVisible();
    expect(screen.getByRole("link", { name: "View provider job" })).toHaveAttribute(
      "href",
      "/admin/operations?status=manual_review",
    );
  });

  it("does not offer manual Gemini setup for a new draft jurisdiction", () => {
    render(<JurisdictionLifecycleActions jurisdiction={{
      id: "geo_1", name: "Ghana", slug: "ghana", status: "draft", kind: "geographic", visibility: "public", scopeMode: null,
      provider: { syncState: "pending", setupState: "not_set_up", storeConfigured: false }, geographic: { level: "country", parent: null },
    }} />);

    expect(screen.queryByRole("button", { name: "Set up Gemini search" })).toBeNull();
  });

  it("blocks enablement until Gemini search setup is ready", () => {
    render(<JurisdictionLifecycleActions jurisdiction={{
      id: "geo_1", name: "Ghana", slug: "ghana", status: "draft", kind: "geographic", visibility: "public", scopeMode: null,
      provider: { syncState: "pending", setupState: "setting_up", storeConfigured: false }, geographic: { level: "country", parent: null },
    }} />);

    expect(screen.getByRole("button", { name: "Enable Ghana" })).toBeDisabled();
  });

  it("refreshes while Gemini search setup is pending", () => {
    vi.useFakeTimers();
    try {
      render(<JurisdictionLifecycleActions jurisdiction={{
        id: "geo_1", name: "Ghana", slug: "ghana", status: "draft", kind: "geographic", visibility: "public", scopeMode: null,
        provider: { syncState: "pending", setupState: "setting_up", storeConfigured: false }, geographic: { level: "country", parent: null },
      }} />);

      vi.advanceTimersByTime(2_000);
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enables a draft jurisdiction with an auditable reason", async () => {
    render(<JurisdictionLifecycleActions jurisdiction={{
      id: "geo_1", name: "Ghana", slug: "ghana", status: "draft", kind: "geographic", visibility: "public", scopeMode: null,
      provider: { syncState: "synced", setupState: "ready", storeConfigured: true, embeddingModel: "models/gemini-embedding-2" }, geographic: { level: "country", parent: null },
    }} />);

    expect(screen.getByRole("group", { name: "Lifecycle actions for Ghana" })).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Audit reason for Ghana" }), { target: { value: "Verified provider readiness" } });
    fireEvent.click(screen.getByRole("button", { name: "Enable Ghana" }));

    await waitFor(() => expect(mocks.enableJurisdiction).toHaveBeenCalledWith({
      id: "geo_1",
      reason: "Verified provider readiness",
    }));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("updates a geographic jurisdiction from a fresh verified place", async () => {
    render(<JurisdictionLifecycleActions jurisdiction={{
      id: "geo_1", name: "Ghana", slug: "ghana", status: "draft", kind: "geographic", visibility: "public", scopeMode: null,
      provider: { syncState: "pending", setupState: "not_set_up", storeConfigured: false }, geographic: { level: "country", parent: null },
    }} geographicOptions={geographies} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit geographic settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Select verified Accra" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Audit reason for Ghana" }), { target: { value: "Correct verified place" } });
    fireEvent.click(screen.getByRole("button", { name: "Save geographic changes" }));

    await waitFor(() => expect(mocks.updateGeographic).toHaveBeenCalledWith({
      id: "geo_1", verifiedPlaceClaim: "signed-claim", level: "country", reason: "Correct verified place",
    }));
  });

  it("updates organizational scope only from an explicit replacement selection", async () => {
    render(<JurisdictionLifecycleActions jurisdiction={{
      id: "org_1", name: "World Health Organization", slug: "who", status: "draft", kind: "organizational", visibility: "members", scopeMode: "linked_geographies",
      provider: { syncState: "pending", setupState: "not_set_up", storeConfigured: false }, geographic: null,
    }} geographicOptions={geographies} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit organizational settings" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Ghana" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Audit reason for World Health Organization" }), { target: { value: "Replace governed scope" } });
    fireEvent.click(screen.getByRole("button", { name: "Save organizational changes" }));

    await waitFor(() => expect(mocks.updateOrganizational).toHaveBeenCalledWith({
      id: "org_1", visibility: "members", scopeMode: "linked_geographies", geographicJurisdictionIds: ["geo_1"], reason: "Replace governed scope",
    }));
  });

  it("keeps archived jurisdiction settings read-only while offering controlled store teardown", () => {
    render(<JurisdictionLifecycleActions jurisdiction={{
      id: "geo_1", name: "Ghana", slug: "ghana", status: "archived", kind: "geographic", visibility: "public", scopeMode: null,
      provider: { syncState: "synced", setupState: "ready", storeConfigured: true, embeddingModel: "models/gemini-embedding-2" }, geographic: { level: "country", parent: null },
    }} />);

    expect(screen.getByRole("group", { name: "Lifecycle actions for Ghana" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit geographic settings" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete Gemini store" }));
    expect(screen.getByText("DELETE GEMINI STORE ghana")).toBeVisible();
    expect(screen.getByLabelText("Exact confirmation")).toBeVisible();
  });

  it("keeps legacy migration rows on transitions without typed edit controls", () => {
    render(<JurisdictionLifecycleActions jurisdiction={{
      id: "geo_1", name: "Ghana", slug: "ghana", status: "draft", kind: "geographic", visibility: "public", scopeMode: null,
      provider: { syncState: "synced", setupState: "ready", storeConfigured: true, embeddingModel: "models/gemini-embedding-2" }, geographic: null,
    }} editable={false} />);

    expect(screen.getByRole("group", { name: "Lifecycle actions for Ghana" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Enable Ghana" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit geographic settings" })).toBeNull();
  });
});

describe("resource regression", () => {
  it("retains canonical resource creation controls", () => {
    render(<ResourceEditor jurisdictionIds={["jurisdiction_1"]} />);
    expect(screen.getByRole("textbox", { name: "Official citation" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Create legal resource" })).toBeVisible();
  });

  it("retains bounded option search and cursor navigation", () => {
    const jurisdictions = Array.from({ length: 25 }, (_, index) => ({
      id: `jurisdiction_${index + 1}`,
      code: `X${String(index).padStart(2, "0")}`,
      name: `Jurisdiction ${index + 1}`,
    }));
    render(<ResourceEditor
      jurisdictionIds={jurisdictions.map((row) => row.id)}
      jurisdictionOptions={jurisdictions}
      jurisdictionPicker={{ searchCode: "", nextCursor: "cursor-25", isDone: false }}
    />);
    expect(screen.getByLabelText("Jurisdiction ID").querySelectorAll("option")).toHaveLength(25);
    expect(screen.getByRole("textbox", { name: "Find jurisdiction by ISO code" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Next jurisdictions" })).toHaveAttribute("href", "/admin/documents?jurisdictionCursor=cursor-25");
  });
});
