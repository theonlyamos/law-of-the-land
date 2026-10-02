import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import GuestResearchPage from "./page";

vi.mock("@/components/chat/guest-research", () => ({
  GuestResearch: ({ initialQuery, initialJurisdiction }: { initialQuery: string; initialJurisdiction: string }) => <p>{initialQuery} in {initialJurisdiction}</p>,
}));
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe("guest research route", () => {
  it("uses one string per repeated URL parameter", async () => {
    vi.stubEnv("GUEST_RESEARCH_ENABLED", "true");
    render(await GuestResearchPage({ searchParams: Promise.resolve({ q: ["Tenant rights?", "ignored"], jurisdiction: ["ghana-id", "ignored"] }) }));
    expect(screen.getByText("Tenant rights? in ghana-id")).toBeVisible();
  });

  it("preserves the question and jurisdiction through signup when the trial is disabled", async () => {
    vi.stubEnv("GUEST_RESEARCH_ENABLED", "false");
    render(await GuestResearchPage({ searchParams: Promise.resolve({ q: "Tenant rights?", jurisdiction: "ghana-id" }) }));
    const href = screen.getByRole("link", { name: "Create a free account" }).getAttribute("href")!;
    const signin = new URL(href, "https://example.org");
    expect(signin.searchParams.get("mode")).toBe("signup");
    const destination = new URL(signin.searchParams.get("redirect")!, "https://example.org");
    expect(destination.searchParams.get("q")).toBe("Tenant rights?");
    expect(destination.searchParams.get("jurisdiction")).toBe("ghana-id");
  });
});
