import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentFilters } from "./document-filters";

const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
afterEach(() => { cleanup(); vi.useRealTimers(); replace.mockReset(); });

it("debounces typing and retains the state filter without old pagination", () => {
  vi.useFakeTimers();
  render(<DocumentFilters name="" status="active" />);
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
  render(<DocumentFilters name="" status="" />);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Act" } });
  fireEvent.submit(screen.getByRole("search"));
  act(() => vi.advanceTimersByTime(400));
  expect(replace).toHaveBeenCalledTimes(1);
});
