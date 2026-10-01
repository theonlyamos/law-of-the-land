import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentFilters } from "./document-filters";

const jurisdictionProps = { jurisdictionId: "", jurisdictions: [{ id: "ghana", name: "Ghana" }, { id: "kenya", name: "Kenya" }] };

const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
afterEach(() => { cleanup(); vi.useRealTimers(); replace.mockReset(); });

it("debounces typing and retains the state filter without old pagination", () => {
  vi.useFakeTimers();
  render(<DocumentFilters {...jurisdictionProps} name="" status="active" />);
  const input = screen.getByRole("searchbox");
  fireEvent.change(input, { target: { value: "lab" } });
  act(() => vi.advanceTimersByTime(200));
  fireEvent.change(input, { target: { value: "LABOUR" } });
  act(() => vi.advanceTimersByTime(349));
  expect(replace).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(replace).toHaveBeenCalledExactlyOnceWith("/admin/documents?name=LABOUR&status=active", { scroll: false });
  fireEvent.change(input, { target: { value: "" } });
  act(() => vi.advanceTimersByTime(350));
  expect(replace).toHaveBeenLastCalledWith("/admin/documents?status=active", { scroll: false });
});

it("submits immediately and cancels the pending debounce", () => {
  vi.useFakeTimers();
  render(<DocumentFilters {...jurisdictionProps} name="" status="" />);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Act" } });
  fireEvent.submit(screen.getByRole("search"));
  act(() => vi.advanceTimersByTime(400));
  expect(replace).toHaveBeenCalledTimes(1);
});

it("syncs URL changes and cancels a stale search when filters are cleared", () => {
  vi.useFakeTimers();
  const { rerender } = render(<DocumentFilters {...jurisdictionProps} name="Labour" status="active" />);
  const input = screen.getByRole("searchbox");
  fireEvent.change(input, { target: { value: "Labour Act" } });
  rerender(<DocumentFilters {...jurisdictionProps} name="" status="" />);
  expect(input).toHaveValue("");
  expect(screen.getByRole("combobox", { name: "Catalog state" })).toHaveValue("");
  act(() => vi.advanceTimersByTime(400));
  expect(replace).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("combobox", { name: "Catalog state" }), { target: { value: "archived" } });
  expect(replace).toHaveBeenLastCalledWith("/admin/documents?status=archived", { scroll: false });
  rerender(<DocumentFilters {...jurisdictionProps} name="Constitution" status="repealed" />);
  expect(input).toHaveValue("Constitution");
  expect(screen.getByRole("combobox", { name: "Catalog state" })).toHaveValue("repealed");
  fireEvent.submit(screen.getByRole("search"));
  expect(replace).toHaveBeenLastCalledWith("/admin/documents?name=Constitution&status=repealed", { scroll: false });
});

it("searches and pages jurisdiction options while retaining document filters", () => {
  render(<DocumentFilters {...jurisdictionProps} name="Act" status="unpublished" jurisdictionId="ghana" jurisdictionSearch="Ghana" jurisdictionCursor="current" jurisdictionNextCursor="next" />);
  fireEvent.click(screen.getByRole("button", { name: "Next jurisdictions" }));
  expect(replace).toHaveBeenLastCalledWith("/admin/documents?name=Act&status=unpublished&jurisdictionId=ghana&filterJurisdictionName=Ghana&filterJurisdictionCursor=next", { scroll: false });
  fireEvent.change(screen.getByRole("textbox", { name: "Find jurisdiction by name" }), { target: { value: "Kenya" } });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Find jurisdiction by name" }), { key: "Enter" });
  expect(replace).toHaveBeenLastCalledWith("/admin/documents?name=Act&status=unpublished&jurisdictionId=ghana&filterJurisdictionName=Kenya", { scroll: false });
  fireEvent.change(screen.getByRole("textbox", { name: "Find jurisdiction by name" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Find jurisdiction" }));
  expect(replace).toHaveBeenLastCalledWith("/admin/documents?name=Act&status=unpublished&jurisdictionId=ghana", { scroll: false });
});

it("combines jurisdiction, unpublished state, and search, and syncs cleared URL filters", () => {
  vi.useFakeTimers();
  const { rerender } = render(<DocumentFilters {...jurisdictionProps} name="Act" status="unpublished" jurisdictionId="ghana" />);
  const jurisdiction = screen.getByRole("combobox", { name: "Jurisdiction" });
  const input = screen.getByRole("searchbox");
  expect(jurisdiction.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.change(input, { target: { value: "Labour Act" } });
  fireEvent.change(jurisdiction, { target: { value: "kenya" } });
  act(() => vi.advanceTimersByTime(400));
  expect(replace).toHaveBeenCalledExactlyOnceWith("/admin/documents?name=Labour+Act&status=unpublished&jurisdictionId=kenya", { scroll: false });
  fireEvent.change(input, { target: { value: "Pending search" } });
  rerender(<DocumentFilters {...jurisdictionProps} name="" status="" />);
  expect(jurisdiction).toHaveValue("");
  expect(input).toHaveValue("");
  act(() => vi.advanceTimersByTime(400));
  expect(replace).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole("combobox", { name: "Catalog state" }), { target: { value: "unpublished" } });
  expect(replace).toHaveBeenLastCalledWith("/admin/documents?status=unpublished", { scroll: false });
});
