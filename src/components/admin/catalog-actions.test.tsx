import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../convex/_generated/api";
import { getFunctionName } from "convex/server";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  createGeographic: vi.fn(),
  createOrganizational: vi.fn(),
  createOrganization: vi.fn(),
  queryResult: vi.fn(),
}));

vi.mock("convex/react", () => ({ useQuery: (...args: unknown[]) => mocks.queryResult(...args), useMutation: (reference: Parameters<typeof getFunctionName>[0]) => {
  const name = getFunctionName(reference);
  if (name === "admin/jurisdictions:createGeographicJurisdiction") return mocks.createGeographic;
  if (name === "admin/jurisdictions:createOrganizationalJurisdiction") return mocks.createOrganizational;
  if (name === "admin/organizations:createOrganization") return mocks.createOrganization;
  return vi.fn();
} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("./geographic-place-picker", () => ({ GeographicPlacePicker: ({ onChange }: { onChange(value: unknown): void }) => (
  <button type="button" onClick={() => onChange({
    place: { placeId: "accra", displayName: "Accra", formattedAddress: "Accra, Ghana", latitude: 5.6, longitude: -0.2, types: ["locality"], countryCode: "GH", addressComponents: [{ longText: "Ghana", shortText: "GH", types: ["country"] }] },
    verifiedPlaceClaim: "signed-claim",
    expiresAt: Date.now() + 60_000,
  })}>Select verified Accra</button>
) }));

import { JurisdictionEditor, ResourceEditor } from "./catalog-actions";

const organizations = [{ id: "org_1", name: "World Health Organization", slug: "who", class: "intergovernmental" as const }];
const geographies = [{ id: "geo_1", name: "Ghana", level: "country" as const, parent: null }];

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.createOrganization.mockResolvedValue("org_new");
  mocks.createGeographic.mockResolvedValue("jurisdiction_geo");
  mocks.createOrganizational.mockResolvedValue("jurisdiction_org");
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
    const aliasCall = mocks.queryResult.mock.calls.find((call) => getFunctionName(call[0]) === "admin/jurisdictions:suggestGeographicParentsByAliases");
    expect(aliasCall?.[1]).toEqual({ childLevel: "city", aliases: ["Ghana", "GH"] });
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
