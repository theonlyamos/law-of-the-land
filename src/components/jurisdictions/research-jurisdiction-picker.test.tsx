import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchJurisdiction } from "@/lib/countries";
import { ResearchJurisdictionPicker } from "./research-jurisdiction-picker";

type SearchPage = {
  page: ResearchJurisdiction[];
  group: "geographic" | "your_organizations" | "public_organizations";
  isDone: boolean;
  continueCursor: string | null;
};

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  return {
    query,
    client: { query },
    auth: { isAuthenticated: false, isLoading: false },
    sessionUserId: null as string | null,
  };
});

vi.mock("convex/react", () => ({
  useConvex: () => mocks.client,
  useConvexAuth: () => mocks.auth,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: mocks.sessionUserId ? { user: { id: mocks.sessionUserId } } : null,
    }),
  },
}));

const ghana: ResearchJurisdiction = {
  id: "ghana-id",
  name: "Ghana",
  slug: "ghana",
  kind: "geographic",
  isDefault: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.query.mockReset();
  mocks.auth = { isAuthenticated: false, isLoading: false };
  mocks.sessionUserId = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ResearchJurisdictionPicker", () => {
  it("waits for type selection and the exact 250ms debounce", async () => {
    mocks.query.mockResolvedValue({
      page: [ghana],
      group: "geographic",
      isDone: true,
      continueCursor: null,
    } satisfies SearchPage);
    render(<ResearchJurisdictionPicker value={null} onChange={vi.fn()} />);

    expect(screen.getByRole("combobox", { name: "Find jurisdiction" })).toBeDisabled();
    expect(mocks.query).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Geographic" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Find jurisdiction" }), {
      target: { value: "  Ghana  " },
    });

    await act(async () => vi.advanceTimersByTime(249));
    expect(mocks.query).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    await act(async () => Promise.resolve());

    expect(mocks.query).toHaveBeenCalledWith(expect.anything(), {
      kind: "geographic",
      query: "Ghana",
      cursor: null,
    });
  });

  it("selects with the keyboard and forwards the opaque load-more cursor", async () => {
    mocks.query
      .mockResolvedValueOnce({
        page: [ghana],
        group: "geographic",
        isDone: false,
        continueCursor: "opaque-next",
      } satisfies SearchPage)
      .mockResolvedValueOnce({
        page: [
          ghana,
          { ...ghana, id: "accra-id", name: "Accra", slug: "accra", isDefault: false },
        ],
        group: "geographic",
        isDone: true,
        continueCursor: null,
      } satisfies SearchPage);
    const onChange = vi.fn();
    render(<ResearchJurisdictionPicker value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "Geographic" }));
    await act(async () => vi.advanceTimersByTime(250));
    await act(async () => Promise.resolve());

    const search = screen.getByRole("combobox", { name: "Find jurisdiction" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(ghana);

    fireEvent.click(screen.getByRole("button", { name: "Load more jurisdictions" }));
    await act(async () => Promise.resolve());
    expect(mocks.query).toHaveBeenLastCalledWith(expect.anything(), {
      kind: "geographic",
      query: "",
      cursor: "opaque-next",
    });
    expect(
      screen.getAllByRole("option", { name: "Ghana, Geographic, ghana" }),
    ).toHaveLength(1);
  });

  it("ignores an older response and preserves the controlled selection", async () => {
    const oldSearch = deferred<SearchPage>();
    const newSearch = deferred<SearchPage>();
    mocks.query.mockReturnValueOnce(oldSearch.promise).mockReturnValueOnce(newSearch.promise);
    const { rerender } = render(<ResearchJurisdictionPicker value={ghana} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Geographic" }));
    await act(async () => vi.advanceTimersByTime(250));
    fireEvent.change(screen.getByRole("combobox", { name: "Find jurisdiction" }), {
      target: { value: "Accra" },
    });
    await act(async () => vi.advanceTimersByTime(250));

    newSearch.resolve({
      page: [{ ...ghana, id: "accra-id", name: "Accra", slug: "accra", isDefault: false }],
      group: "geographic",
      isDone: true,
      continueCursor: null,
    });
    await act(async () => Promise.resolve());
    oldSearch.resolve({
      page: [{ ...ghana, id: "old-id", name: "Old result", slug: "old", isDefault: false }],
      group: "geographic",
      isDone: true,
      continueCursor: null,
    });
    await act(async () => Promise.resolve());
    rerender(<ResearchJurisdictionPicker value={ghana} onChange={vi.fn()} />);

    expect(screen.getByText("Selected: Ghana")).toBeVisible();
    expect(screen.getByRole("option", { name: "Accra, Geographic, accra" })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "Old result, Geographic, old" }),
    ).not.toBeInTheDocument();
  });

  it("announces member groups, empty results, and recoverable errors", async () => {
    mocks.auth = { isAuthenticated: true, isLoading: false };
    mocks.sessionUserId = "member-a";
    mocks.query
      .mockResolvedValueOnce({
        page: [{ ...ghana, kind: "organizational", name: "Member Council" }],
        group: "your_organizations",
        isDone: true,
        continueCursor: null,
      } satisfies SearchPage)
      .mockRejectedValueOnce(new Error("private backend detail"))
      .mockResolvedValueOnce({
        page: [],
        group: "public_organizations",
        isDone: true,
        continueCursor: null,
      } satisfies SearchPage);
    render(<ResearchJurisdictionPicker value={null} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Organizational" }));
    await act(async () => vi.advanceTimersByTime(250));
    await act(async () => Promise.resolve());

    expect(screen.getByRole("group", { name: "Your organizations" })).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "Find jurisdiction" }), {
      target: { value: "missing" },
    });
    await act(async () => vi.advanceTimersByTime(250));
    await act(async () => Promise.resolve());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Jurisdictions could not be loaded. Try again.",
    );
    expect(screen.queryByText("private backend detail")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry jurisdiction search" }));
    await act(async () => Promise.resolve());
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });

  it("clears member-derived options when the authenticated account changes", async () => {
    mocks.auth = { isAuthenticated: true, isLoading: false };
    mocks.sessionUserId = "member-a";
    mocks.query
      .mockResolvedValueOnce({
        page: [{ ...ghana, kind: "organizational", name: "Member Council" }],
        group: "your_organizations",
        isDone: true,
        continueCursor: null,
      } satisfies SearchPage)
      .mockReturnValue(new Promise(() => undefined));
    const { rerender } = render(
      <ResearchJurisdictionPicker value={null} onChange={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Organizational" }));
    await act(async () => vi.advanceTimersByTime(250));
    await act(async () => Promise.resolve());
    expect(
      screen.getByRole("option", { name: "Member Council, Organizational, ghana" }),
    ).toBeVisible();

    mocks.sessionUserId = "member-b";
    rerender(<ResearchJurisdictionPicker value={null} onChange={vi.fn()} />);
    expect(
      screen.queryByRole("option", { name: "Member Council, Organizational, ghana" }),
    ).not.toBeInTheDocument();
  });

  it("clears a controlled member selection on account switch and sign-out but not initially", () => {
    mocks.auth = { isAuthenticated: true, isLoading: false };
    mocks.sessionUserId = "member-a";
    mocks.query.mockReturnValue(new Promise(() => undefined));
    const selected = { ...ghana, kind: "organizational" as const, name: "Private Council" };
    const onChange = vi.fn();
    const { rerender } = render(
      <ResearchJurisdictionPicker value={selected} onChange={onChange} />,
    );
    expect(onChange).not.toHaveBeenCalled();

    mocks.sessionUserId = "member-b";
    rerender(<ResearchJurisdictionPicker value={selected} onChange={onChange} />);
    expect(onChange).toHaveBeenLastCalledWith(null);

    onChange.mockClear();
    mocks.auth = { isAuthenticated: false, isLoading: false };
    mocks.sessionUserId = null;
    rerender(<ResearchJurisdictionPicker value={selected} onChange={onChange} />);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("clears selection on sign-out even while the session user ID is unresolved", () => {
    mocks.auth = { isAuthenticated: true, isLoading: false };
    mocks.sessionUserId = null;
    mocks.query.mockReturnValue(new Promise(() => undefined));
    const selected = { ...ghana, kind: "organizational" as const, name: "Private Council" };
    const onChange = vi.fn();
    const { rerender } = render(
      <ResearchJurisdictionPicker value={selected} onChange={onChange} />,
    );
    expect(onChange).not.toHaveBeenCalled();

    mocks.auth = { isAuthenticated: false, isLoading: false };
    rerender(<ResearchJurisdictionPicker value={selected} onChange={onChange} />);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("distinguishes duplicate names and visibly tracks keyboard-active results", async () => {
    mocks.query.mockResolvedValue({
      page: [
        { ...ghana, id: "council-one", name: "Council", slug: "council-global", isDefault: false },
        { ...ghana, id: "council-two", name: "Council", slug: "council-local", isDefault: false },
      ],
      group: "geographic",
      isDone: true,
      continueCursor: null,
    } satisfies SearchPage);
    render(<ResearchJurisdictionPicker value={null} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Geographic" }));
    await act(async () => vi.advanceTimersByTime(250));
    await act(async () => Promise.resolve());

    const global = screen.getByRole("option", {
      name: "Council, Geographic, council-global",
    });
    expect(
      screen.getByRole("option", { name: "Council, Geographic, council-local" }),
    ).toBeVisible();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Find jurisdiction" }), {
      key: "ArrowDown",
    });
    expect(global).toHaveClass("ring-2");
  });
});
