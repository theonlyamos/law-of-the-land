import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorizeAdminPage: vi.fn(), fetchAuthQuery: vi.fn(), redirect: vi.fn(), refresh: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/admin/server", () => ({ authorizeAdminPage: mocks.authorizeAdminPage }));
vi.mock("@/lib/auth-server", () => ({ fetchAuthQuery: mocks.fetchAuthQuery }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("convex/react", () => ({ useMutation: () => mocks.save }));
import AiModelsPage from "./page";

const FEATURES = ["chat", "transcription", "document_review", "document_draft", "profile_memory", "source_verification", "intent_routing", "embedding"];
function rows(overrides: Record<string, string> = {}) {
  return FEATURES.map((feature) => ({ feature, model: overrides[feature] ?? null, convexEffectiveModel: overrides[feature] ?? "gemini-3.8-flash", updatedAt: overrides[feature] ? 1_700_000_000_000 : null, updatedBy: overrides[feature] ? "admin" : null }));
}

beforeEach(() => {
  mocks.authorizeAdminPage.mockResolvedValue({ status: "authorized", currentAdmin: { userId: "root", roles: ["super_admin"] } });
  mocks.fetchAuthQuery.mockResolvedValue(rows({ chat: "gemini-admin-chat" }));
  mocks.redirect.mockImplementation(() => { throw new Error("NEXT_REDIRECT"); });
  mocks.save.mockReset();
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe("AI models settings", () => {
  it("lists every feature with the model in use", async () => {
    vi.stubEnv("GEMINI_TRANSCRIBE_MODEL", "transcribe-env");
    render(await AiModelsPage());
    expect(screen.getByRole("heading", { name: "AI models" })).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByLabelText("Model for chat answers")).toHaveValue("gemini-admin-chat");
    expect(screen.getByText("transcribe-env")).toBeVisible();
    expect(screen.getByRole("button", { name: "Use default" })).toBeVisible();
  });

  it("saves a new model", async () => {
    mocks.save.mockResolvedValue("gemini-new");
    render(await AiModelsPage());
    const input = screen.getByLabelText("Model for voice input");
    fireEvent.change(input, { target: { value: "gemini-new" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ feature: "transcription", model: "gemini-new" }));
    expect(await screen.findByText("Saved. Voice input now uses gemini-new.")).toBeVisible();
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("is read-only without operations write", async () => {
    mocks.authorizeAdminPage.mockResolvedValue({ status: "authorized", currentAdmin: { userId: "auditor", roles: ["auditor"] } });
    render(await AiModelsPage());
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("redirects admins without operations read", async () => {
    mocks.authorizeAdminPage.mockResolvedValue({ status: "authorized", currentAdmin: { userId: "billing", roles: ["billing_manager"] } });
    await expect(AiModelsPage()).rejects.toThrow("NEXT_REDIRECT");
  });
});
