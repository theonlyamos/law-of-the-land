import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewDocket } from "./review-docket";

const mocks = vi.hoisted(() => ({ query: vi.fn(), counts: vi.fn(), loadMore: vi.fn(), loadCounts: vi.fn() }));
vi.mock("convex/react", () => ({ usePaginatedQuery: (...args: unknown[]) => args[0] === "statuses" ? mocks.counts(...args) : mocks.query(...args) }));
vi.mock("../../../convex/_generated/api", () => ({ api: { admin: { reviews: { listReviewQueue: "reviews", listReviewStatuses: "statuses" } } } }));
vi.mock("./document-review", () => ({ DocumentReview: ({ onPublicationQueued }: { onPublicationQueued: () => void }) => <button onClick={onPublicationQueued}>Simulate queued publication</button> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => { mocks.counts.mockReturnValue({ results: [], status: "LoadingFirstPage", loadMore: mocks.loadCounts }); });

it("counts every loaded status, waits for all pages, and updates totals when a version moves", () => {
  mocks.query.mockReturnValue({ results: [], status: "Exhausted", loadMore: mocks.loadMore });
  mocks.counts.mockReturnValue({ results: ["approved"], status: "CanLoadMore", loadMore: mocks.loadCounts });
  const { rerender } = render(<ReviewDocket />);
  expect(mocks.loadCounts).toHaveBeenCalledWith(200);
  expect(screen.getByRole("button", { name: "Approved" })).toHaveTextContent("…");

  mocks.counts.mockReturnValue({ results: ["approved", "approved", "published", "draft", "rejected"], status: "Exhausted", loadMore: mocks.loadCounts });
  rerender(<ReviewDocket />);
  expect(screen.getByRole("button", { name: "Approved (2)" })).toHaveTextContent("2");
  expect(screen.getByRole("button", { name: "Published (1)" })).toHaveTextContent("1");
  for (const label of ["Unapproved", "Queued for publishing", "Superseded"]) {
    expect(screen.getByRole("button", { name: `${label} (0)` })).toHaveTextContent("0");
  }
  mocks.counts.mockReturnValue({ results: ["approved", "publishing", "published"], status: "Exhausted", loadMore: mocks.loadCounts });
  rerender(<ReviewDocket />);
  expect(screen.getByRole("button", { name: "Approved (1)" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Queued for publishing (1)" })).toBeInTheDocument();
});

it("queries each selected stage and loads additional records", () => {
  mocks.query.mockReturnValue({ results: [], status: "CanLoadMore", loadMore: mocks.loadMore });
  render(<ReviewDocket />);
  for (const [label, status] of [["Unapproved", "ready_for_review"], ["Approved", "approved"], ["Published", "published"], ["Queued for publishing", "publishing"]]) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(mocks.query).toHaveBeenLastCalledWith("reviews", { status }, { initialNumItems: 12 });
    expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
  }
  fireEvent.click(screen.getByRole("button", { name: "Load more documents" }));
  expect(mocks.loadMore).toHaveBeenCalledWith(12);
});

it("moves to the publishing stage after a successful queue request", () => {
  mocks.query.mockReturnValue({ results: [{ id: "version" }], status: "Exhausted", loadMore: mocks.loadMore });
  render(<ReviewDocket />);
  fireEvent.click(screen.getByRole("button", { name: "Approved" }));
  fireEvent.click(screen.getByRole("button", { name: "Simulate queued publication" }));
  expect(mocks.query).toHaveBeenLastCalledWith("reviews", { status: "publishing" }, { initialNumItems: 12 });
});
