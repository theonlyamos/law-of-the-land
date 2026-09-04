import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageFooter } from "./assistant-message-footer";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("AssistantMessageFooter", () => {
  it("copies the reply with sources and shows timing without a Completed label", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<AssistantMessageFooter content="An **answer**." citations={[{ label: "Labour Act, page 21", jurisdictionId: "ghana", jurisdictionName: "Ghana", jurisdictionKind: "geographic", relation: "selected" }]} completedAt={1788547338000} savedAt={1788547339000} durationMs={18600} />);
    expect(screen.getByText("18.6 s")).toBeVisible();
    expect(screen.queryByText(/Completed/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy reply" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("An **answer**.\n\nSources\n1. Labour Act, page 21 — Ghana"));
    expect(await screen.findByText("Copied")).toBeVisible();
    vi.unstubAllGlobals();
  });

  it("reports clipboard failure without claiming success and leaves unknown duration empty", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(<AssistantMessageFooter content="Answer" citations={[]} savedAt={1788547339000} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy reply" }));
    expect(await screen.findByText("Could not copy. Try again.")).toBeVisible();
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Duration unavailable")).toBeVisible();
    vi.unstubAllGlobals();
  });
});
