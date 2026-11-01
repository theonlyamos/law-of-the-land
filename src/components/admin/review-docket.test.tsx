import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewDocket } from "./review-docket";

const mocks = vi.hoisted(() => ({ query: vi.fn(), counts: vi.fn(), targeted: vi.fn(), review: vi.fn(), loadMore: vi.fn() }));
vi.mock("convex/react", () => ({ usePaginatedQuery: mocks.query, useQuery: mocks.counts, useQuery_experimental: mocks.targeted }));
vi.mock("../../../convex/_generated/api", () => ({ api: { admin: { reviews: { listReviewQueue: "reviews", getReviewCounts: "counts", getReviewItem: "item" } } } }));
vi.mock("./document-review", () => ({ DocumentReview: (props: { onPublicationQueued?: () => void }) => { mocks.review(props); return <button onClick={props.onPublicationQueued}>Simulate queued publication</button>; } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => { mocks.counts.mockReturnValue(undefined); });

it("shows stored totals, waits for initialization, and updates when a version moves", () => {
  mocks.query.mockReturnValue({ results: [], status: "Exhausted", loadMore: mocks.loadMore });
  mocks.counts.mockReturnValue(null);
  const { rerender } = render(<ReviewDocket />);
  expect(mocks.counts).toHaveBeenCalledWith("counts", {});
  expect(screen.getByRole("button", { name: "Approved" })).toHaveTextContent("…");

  mocks.counts.mockReturnValue({ approved: 2, published: 1, draft: 1, rejected: 1 });
  rerender(<ReviewDocket />);
  expect(screen.getByRole("button", { name: "Approved (2)" })).toHaveTextContent("2");
  expect(screen.getByRole("button", { name: "Published (1)" })).toHaveTextContent("1");
  for (const label of ["Unapproved", "Queued for publishing", "Superseded"]) {
    expect(screen.getByRole("button", { name: `${label} (0)` })).toHaveTextContent("0");
  }
  mocks.counts.mockReturnValue({ approved: 1, publishing: 1, published: 1 });
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

it("loads only the linked version and keeps its existing review component", () => {
  const item = { id: "version_1", status: "ready_for_review" };
  mocks.targeted.mockReturnValue({ status: "success", data: item });
  render(<ReviewDocket versionId="version_1" />);
  expect(mocks.targeted).toHaveBeenCalledWith({ query: "item", args: { versionId: "version_1" } });
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.counts).not.toHaveBeenCalled();
  expect(mocks.review).toHaveBeenCalledWith({ items: [item] });
  expect(screen.getByRole("link", { name: "View full publication docket" })).toHaveAttribute("href", "/admin/review");
});

it("shows a safe unavailable message for versions outside the review lifecycle", () => {
  mocks.targeted.mockReturnValue({ status: "success", data: null });
  render(<ReviewDocket versionId="missing_version" />);
  expect(screen.getByRole("status")).toHaveTextContent("unavailable in the review docket");
  expect(mocks.review).not.toHaveBeenCalled();
});

it("handles a denied or invalid targeted query without rendering review evidence", () => {
  mocks.targeted.mockReturnValue({ status: "error", error: new Error("private detail") });
  render(<ReviewDocket versionId="bad_id" />);
  expect(screen.getByRole("alert")).toHaveTextContent("Check the document link and your access");
  expect(screen.queryByText("private detail")).toBeNull();
  expect(mocks.review).not.toHaveBeenCalled();
});
