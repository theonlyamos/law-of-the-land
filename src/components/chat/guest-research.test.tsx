import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestSessionView, GuestTurnView } from "@/convex/lib/guestResearchContracts";
import { readGuestResearchDraft, saveGuestResearchDraft } from "@/lib/guest-research-draft";
import { GuestResearch } from "./guest-research";

const mocks = vi.hoisted(() => ({
  auth: { isAuthenticated: false, isLoading: false },
  router: { push: vi.fn(), replace: vi.fn() },
  fetch: vi.fn(),
}));
vi.mock("convex/react", () => ({ useConvexAuth: () => mocks.auth }));
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));

function completed(requestId: string, query = "Tenant rights?"): GuestTurnView {
  return { requestId, query, status: "completed", result: {
    requestId, answer: "A complete answer with **legal context**.", completedAt: Date.now(), answerKind: "legal", partialCoverage: false,
    citations: [{ label: "Rent Act, section 3", jurisdictionId: "ghana-id" as never,
      jurisdictionName: "Ghana", jurisdictionKind: "geographic", relation: "selected",
      issuer: "Parliament", officialCitation: "Act 220", effectiveDate: null, sourceUrl: "https://example.org/rent-act" }],
  } };
}
function session(turns: GuestTurnView[] = []): GuestSessionView {
  return { jurisdictionId: "ghana-id", jurisdictionName: "Ghana", jurisdictionKind: "geographic",
    remaining: 2 - turns.filter((turn) => turn.status === "completed").length,
    expiresAt: Date.now() + 86_400_000, turns };
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function mount(initialQuery: string | null = null, strict = false) {
  const element = <GuestResearch initialQuery={initialQuery} initialJurisdiction="ghana-id" />;
  return render(strict ? <StrictMode>{element}</StrictMode> : element);
}
function submit(query: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: query } });
  fireEvent.click(screen.getByRole("button", { name: "Send question" }));
}

beforeEach(() => {
  mocks.auth = { isAuthenticated: false, isLoading: false };
  mocks.router.push.mockReset(); mocks.router.replace.mockReset(); mocks.fetch.mockReset();
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal("fetch", mocks.fetch);
  let id = 0;
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}` });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("guest research", () => {
  it("creates a cookie session before one automatic request under StrictMode and exposes sources", async () => {
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return response(session());
      if (init?.method === "POST") return response(session([completed(JSON.parse(init.body as string).requestId)]));
      return response(null);
    });
    mount("Tenant rights?", true);
    expect(await screen.findByText(/A complete answer with/)).toBeVisible();
    const writes = mocks.fetch.mock.calls.filter(([, init]) => init?.method);
    expect(writes.map(([, init]) => init.method)).toEqual(["PUT", "POST"]);
    expect(screen.getByRole("link", { name: /Rent Act, section 3/ })).toHaveAttribute("href", "https://example.org/rent-act");
    expect(screen.getByText("One free follow-up remaining. No account required.")).toBeVisible();
    expect(screen.getByRole("link", { name: /Save this research/ })).toHaveAttribute("href", "/signin?mode=signup&redirect=%2Fresearch");
  });

  it("restores the complete conversation and gates the next question after a follow-up", async () => {
    const first = completed("first");
    mocks.fetch.mockResolvedValueOnce(response(session([first])));
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(init!.body as string);
      return response(session([first, completed(request.requestId, request.query)]));
    });
    mount("Tenant rights?");
    await screen.findByText("One free follow-up remaining. No account required.");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    submit("What notice is required?");
    await screen.findByText(/You’ve used your guest research trial/);
    expect(screen.getAllByText(/A complete answer with/)).toHaveLength(2);
    submit("Does that apply to my lease?");
    expect(mocks.router.push).toHaveBeenCalledWith("/signin?mode=signup&redirect=%2Fresearch");
    expect(readGuestResearchDraft()).toBe("Does that apply to my lease?");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("explains a restored jurisdiction mismatch without automatically sending the new question", async () => {
    mocks.fetch.mockResolvedValueOnce(response(session([completed("first")])));
    render(<GuestResearch initialQuery="A question about another jurisdiction" initialJurisdiction="another-id" />);
    expect(await screen.findByText(/Your guest trial is already in Ghana/)).toBeVisible();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox")).toHaveValue("A question about another jurisdiction");
  });

  it("does not auto-send into an empty session in another jurisdiction", async () => {
    mocks.fetch.mockResolvedValueOnce(response(session()));
    render(<GuestResearch initialQuery="A question about another jurisdiction" initialJurisdiction="another-id" />);
    expect(await screen.findByText(/Your guest trial is already in Ghana/)).toBeVisible();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox")).toHaveValue("A question about another jurisdiction");
  });

  it("reconciles a lost response to the saved answer without spending another request", async () => {
    mocks.fetch.mockResolvedValueOnce(response(session()));
    let requestId = "";
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        requestId = JSON.parse(init.body as string).requestId;
        throw new TypeError("Network disconnected");
      }
      return response(session([completed(requestId)]));
    });
    mount();
    await screen.findByRole("textbox");
    submit("Tenant rights?");
    expect(await screen.findByText(/A complete answer with/)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("uses a new ID after a definitive failure without losing the allowance", async () => {
    mocks.fetch.mockResolvedValueOnce(response(session()));
    const requests: string[] = [];
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(init!.body as string);
      requests.push(request.requestId);
      return response(session(requests.length === 1
        ? [{ requestId: request.requestId, query: request.query, status: "failed", error: { code: "ANSWER_UNAVAILABLE", message: "Please try again." } }]
        : [completed(request.requestId)]));
    });
    mount();
    await screen.findByRole("textbox");
    submit("Tenant rights?");
    await screen.findByText("Please try again.");
    expect(screen.getByRole("textbox")).toHaveValue("Tenant rights?");
    expect(screen.getByText("Try one question and one follow-up free. No account required.")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send question" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await screen.findByText(/A complete answer with/);
    expect(new Set(requests).size).toBe(2);
  });

  it("reuses the request ID after an ambiguous failure", async () => {
    mocks.fetch.mockResolvedValueOnce(response(session()));
    const requests: string[] = [];
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") throw new TypeError("Offline");
      const request = JSON.parse(init.body as string);
      requests.push(request.requestId);
      if (requests.length === 1) throw new TypeError("Offline");
      return response(session([completed(request.requestId)]));
    });
    mount();
    await screen.findByRole("textbox");
    submit("Tenant rights?");
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByRole("button", { name: "Send question" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await screen.findByText(/A complete answer with/);
    expect(requests).toHaveLength(2);
    expect(new Set(requests).size).toBe(1);
  });

  it("claims after signup and carries the unsent draft into the account chat", async () => {
    mocks.auth = { isAuthenticated: true, isLoading: false };
    saveGuestResearchDraft("My next question");
    mocks.fetch.mockResolvedValueOnce(response(session([completed("first")])));
    mocks.fetch.mockResolvedValueOnce(response({ chatId: "claimed-chat" }));
    mount();
    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith("/claimed-chat"));
    expect(readGuestResearchDraft("claimed-chat")).toBe("My next question");
    expect(readGuestResearchDraft()).toBe("");
    expect(mocks.fetch.mock.calls[1][0]).toBe("/api/guest-research/claim");
  });

  it("preserves an existing handoff draft when another authenticated tab replays the claim", async () => {
    mocks.auth = { isAuthenticated: true, isLoading: false };
    saveGuestResearchDraft("An unsent follow-up from the first tab", "claimed-chat");
    mocks.fetch.mockResolvedValueOnce(response(session([completed("first")])));
    mocks.fetch.mockResolvedValueOnce(response({ chatId: "claimed-chat" }));
    mount();
    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith("/claimed-chat"));
    expect(readGuestResearchDraft("claimed-chat")).toBe("An unsent follow-up from the first tab");
  });

  it.each(["empty", "failed"] as const)("continues an authenticated %s trial in a fresh chat with an editable draft", async (state) => {
    mocks.auth = { isAuthenticated: true, isLoading: false };
    const turns: GuestTurnView[] = state === "failed"
      ? [{ requestId: "failed", query: "My unanswered question", status: "failed" }] : [];
    if (state === "empty") saveGuestResearchDraft("My unanswered question");
    mocks.fetch.mockImplementation(async () => response(session(turns)));
    render(<StrictMode><GuestResearch initialQuery={null} initialJurisdiction={null} /></StrictMode>);
    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalled());
    const destination = new URL(mocks.router.replace.mock.calls[0][0], "https://example.org");
    expect(destination.searchParams.get("jurisdiction")).toBe("ghana-id");
    expect(destination.searchParams.has("q")).toBe(false);
    expect(readGuestResearchDraft(destination.pathname.slice(1))).toBe("My unanswered question");
    expect(mocks.router.replace).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it.each([
    { name: "expired", overrides: { expiresAt: 0 } },
    { name: "missing expiry", overrides: { expiresAt: undefined } },
    { name: "excessive expiry", overrides: { expiresAt: Date.now() + 172_800_000 } },
    { name: "invalid UUID", overrides: { requestId: "invalid" } },
    { name: "oversized query", overrides: { query: "q".repeat(4001) } },
    { name: "oversized jurisdiction", overrides: { jurisdictionId: "j".repeat(129) } },
  ])("discards $name remembered requests", async ({ overrides }) => {
    sessionStorage.setItem("guest-research-request", JSON.stringify({
      requestId: "00000000-0000-4000-8000-000000000001", query: "An old question", jurisdictionId: "ghana-id",
      expiresAt: Date.now() + 86_400_000, ...overrides,
    }));
    mocks.fetch.mockResolvedValueOnce(response(session()));
    mount();
    expect(await screen.findByRole("textbox")).toHaveValue("");
    expect(sessionStorage.getItem("guest-research-request")).toBeNull();
  });

  it("restores a valid retry ID and stores its question for at most 24 hours", async () => {
    const requestId = "00000000-0000-4000-8000-000000000009";
    sessionStorage.setItem("guest-research-request", JSON.stringify({ requestId, query: "Tenant rights?", jurisdictionId: "ghana-id", expiresAt: Date.now() + 86_400_000 }));
    mocks.fetch.mockResolvedValueOnce(response(session())).mockRejectedValue(new TypeError("Offline"));
    mount();
    expect(await screen.findByRole("textbox")).toHaveValue("Tenant rights?");
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await screen.findByRole("alert");
    const body = JSON.parse(mocks.fetch.mock.calls[1][1].body);
    expect(body).toEqual({ requestId, query: "Tenant rights?", jurisdictionId: "ghana-id" });
    const stored = JSON.parse(sessionStorage.getItem("guest-research-request")!);
    expect(stored.expiresAt).toBeGreaterThan(Date.now());
    expect(stored.expiresAt).toBeLessThanOrEqual(Date.now() + 86_400_000);
  });

  it("polls a restored pending turn without sending another question", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockResolvedValueOnce(response(session([{ requestId: "pending", query: "Tenant rights?", status: "pending" }])));
    mocks.fetch.mockResolvedValueOnce(response(session([completed("pending")])));
    await act(async () => { mount("Tenant rights?"); });
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.queryByRole("link", { name: /Save this research/ })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByText(/A complete answer with/)).toBeVisible();
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(mocks.fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
});
