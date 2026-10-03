import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Sidebar } from "./sidebar";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: () => ({ name: "Amos Amissah" }),
}));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: vi.fn() } }));
vi.mock("@/components/providers/theme-provider", () => ({
  useTheme: () => ({ theme: "light", setTheme: vi.fn() }),
}));

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("groups history by calendar day and preserves new chat, pagination and confirmed deletion", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 3, 0, 5));
  const dates = [
    new Date(2026, 9, 3, 0, 1),
    new Date(2026, 9, 2, 23, 55),
    new Date(2026, 8, 26, 0, 0),
    new Date(2026, 8, 25, 23, 59),
  ];
  const sessions = dates.map((timestamp, index) => ({
    id: `chat-${index}`, title: `Question ${index}`, timestamp,
    lastMessage: "", messageCount: 1, messages: [],
  }));
  const onNewSession = vi.fn();
  const onLoadMoreSessions = vi.fn();
  const onDeleteSession = vi.fn();
  render(<Sidebar sessions={sessions} sessionPaginationStatus="CanLoadMore" activeSession="chat-0"
    isOpen onClose={vi.fn()} onNewSession={onNewSession}
    onLoadMoreSessions={onLoadMoreSessions} onDeleteSession={onDeleteSession} />);

  ["Today", "Yesterday", "Previous 7 days", "Older"].forEach((group, index) => {
    expect(within(screen.getByRole("region", { name: group })).getByRole("link", { name: `Question ${index}` }))
      .toHaveAttribute("href", `/chat-${index}`);
  });
  expect(screen.getByRole("link", { name: "Question 0" })).toHaveAttribute("aria-current", "page");
  fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
  fireEvent.click(screen.getByRole("button", { name: "Load more chats" }));
  expect(onNewSession).toHaveBeenCalledOnce();
  expect(onLoadMoreSessions).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Delete chat: Question 1" }));
  expect(onDeleteSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep" }));
  expect(onDeleteSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete chat: Question 1" }));
  fireEvent.click(screen.getByRole("button", { name: /^Delete chat$/ }));
  expect(onDeleteSession).toHaveBeenCalledWith("chat-1");
});
