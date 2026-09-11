import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { WebsiteChatSettings } from "./website-chat-settings";
const { save } = vi.hoisted(() => ({ save: vi.fn().mockResolvedValue("widget-id") }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useMutation: () => save,
  useQuery: () => ({ publicId: "widget-id", jurisdictionName: "Private policies", jurisdictionVisibility: "members", canManage: true, ready: false, readiness: "Allow visitor access", dailyLimit: 100, monthlyLimit: 1000, platformDailyLimit: 100, platformMonthlyLimit: 1000, usage: { day: 0, month: 0 }, settings: { enabled: false, allowedOrigins: ["https://example.org"], title: "Ask us", welcomeMessage: "Welcome", suggestedQuestions: [], accent: "#123abc", side: "right" } }),
}));
vi.mock("@/components/embed/guest-chat", () => ({ GuestChat: () => null }));
vi.mock("@/components/embed/saved-widget-test", () => ({ SavedWidgetTest: () => null }));
afterEach(() => { cleanup(); save.mockClear(); });
it("enables private website chat with the single widget switch", async () => {
  render(<WebsiteChatSettings organizationId={"organization" as Id<"organizations">} />);
  fireEvent.click(screen.getByRole("button", { name: "Websites" }));
  const enabled = screen.getByLabelText("Enable website chat");
  expect(enabled).toBeEnabled();
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  fireEvent.click(enabled);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ enabled: true }) })));
});
