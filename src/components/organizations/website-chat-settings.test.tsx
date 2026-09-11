import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { ChatWidgetSettings } from "./website-chat-settings";
import { getFunctionName } from "convex/server";
const { save, saveUsage, usageQuery } = vi.hoisted(() => ({ save: vi.fn().mockResolvedValue("widget-id"), saveUsage: vi.fn().mockResolvedValue(null), usageQuery: vi.fn() }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) => getFunctionName(ref).endsWith(":saveUsageLimits") ? saveUsage : save,
  useQuery: (ref: Parameters<typeof getFunctionName>[0]) => {
    if (getFunctionName(ref).endsWith(":getUsage")) { usageQuery(); return { day: 0, month: 0, dailyLimit: 100, monthlyLimit: 1000, platformDailyLimit: 100, platformMonthlyLimit: 1000, shared: true, canManage: true }; }
    return { publicId: "widget-id", jurisdictionName: "Private policies", jurisdictionVisibility: "members", canManage: true, ready: false, readiness: "Allow visitor access", dailyLimit: 100, monthlyLimit: 1000, platformDailyLimit: 100, platformMonthlyLimit: 1000, settings: { enabled: false, allowedOrigins: ["https://example.org"], title: "Ask us", welcomeMessage: "Welcome", suggestedQuestions: [], accent: "#123abc", side: "right" } };
  },
}));
vi.mock("@/components/embed/guest-chat", () => ({ GuestChat: () => null }));
vi.mock("@/components/embed/saved-widget-test", () => ({ SavedWidgetTest: () => null }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("enables private chat widget with the single widget switch", async () => {
  render(<ChatWidgetSettings organizationId={"organization" as Id<"organizations">} jurisdictionId={"jurisdiction" as Id<"jurisdictions">} />);
  fireEvent.click(screen.getByRole("button", { name: "Websites" }));
  const enabled = screen.getByLabelText("Enable chat widget");
  expect(enabled).toBeEnabled();
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  fireEvent.click(enabled);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ enabled: true }) })));
  expect(save.mock.calls[0][0]).not.toHaveProperty("dailyLimit");
  expect(saveUsage).not.toHaveBeenCalled();
  expect(usageQuery).not.toHaveBeenCalled();
});
it("loads shared usage only when opened and saves limits separately", async () => {
  render(<ChatWidgetSettings jurisdictionId={"jurisdiction" as Id<"jurisdictions">} />);
  expect(usageQuery).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Usage" }));
  expect(usageQuery).toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Daily question limit"), { target: { value: "50" } });
  fireEvent.click(screen.getByRole("button", { name: "Save usage limits" }));
  await waitFor(() => expect(saveUsage).toHaveBeenCalledWith({ jurisdictionId: "jurisdiction", dailyLimit: 50, monthlyLimit: 1000 }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
});
it("preserves failed settings edits and resets drafts when changing jurisdictions", async () => {
  save.mockRejectedValueOnce(new Error("offline"));
  const { rerender } = render(<ChatWidgetSettings jurisdictionId={"first" as Id<"jurisdictions">} />);
  fireEvent.change(screen.getByLabelText("Chat title"), { target: { value: "First draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText(/Settings couldn't be saved/);
  expect(screen.getByLabelText("Chat title")).toHaveValue("First draft");
  rerender(<ChatWidgetSettings jurisdictionId={"second" as Id<"jurisdictions">} />);
  expect(screen.getByLabelText("Chat title")).toHaveValue("Ask us");
});
