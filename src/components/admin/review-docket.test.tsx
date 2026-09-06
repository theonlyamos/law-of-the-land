import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewDocket } from "./review-docket";

const mocks = vi.hoisted(() => ({ query: vi.fn(), loadMore: vi.fn() }));
vi.mock("convex/react", () => ({ usePaginatedQuery: mocks.query }));
vi.mock("../../../convex/_generated/api", () => ({ api: { admin: { reviews: { listReviewQueue: "reviews" } } } }));
vi.mock("./document-review", () => ({ DocumentReview: ({ onPublicationQueued }: { onPublicationQueued: () => void }) => <button onClick={onPublicationQueued}>Simulate queued publication</button> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

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
