import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type FormEvent } from "react";
import type { ResearchJurisdiction } from "@/lib/countries";
import { ResearchJurisdictionPicker } from "./research-jurisdiction-picker";
import { ChatInput } from "@/components/ui/chat-input";

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

function ControlledPicker({ initialValue = null }: { initialValue?: ResearchJurisdiction | null }) {
  const [value, setValue] = useState(initialValue);
  return <ResearchJurisdictionPicker value={value} onChange={setValue} />;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.useFakeTimers();
  mocks.query.mockReset();
  mocks.auth = { isAuthenticated: false, isLoading: false };
  mocks.sessionUserId = null;
});

afterEach(() => {
  cleanup();
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  vi.useRealTimers();
});

describe("ResearchJurisdictionPicker", () => {
  it("keeps the excluded-document coverage notice visible after selection", () => {
    const restricted: ResearchJurisdiction & { coverageWarning: { excludedDocumentCount: number } } = {
      ...ghana,
      coverageWarning: { excludedDocumentCount: 2 },
    };
    render(<ControlledPicker initialValue={restricted} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Search excludes 2 documents whose indexing failed.",
    );
    expect(screen.getByRole("button", { name: "Change jurisdiction" })).toHaveTextContent("Ghana");
  });

  it("omits the coverage notice for an unrestricted selection", () => {
    render(<ControlledPicker initialValue={ghana} />);
    expect(screen.queryByText(/documents? whose indexing failed/)).not.toBeInTheDocument();
  });

  it("allows drafting before a compact jurisdiction selection and enables sending only after selection", async () => {
    mocks.query.mockResolvedValue({
      page: [ghana], group: "geographic", isDone: true, continueCursor: null,
    } satisfies SearchPage);
    const onSearch = vi.fn();
    function Composer() {
      const [query, setQuery] = useState("");
      const [value, setValue] = useState<ResearchJurisdiction | null>(null);
      return <ChatInput variant="editorial" query={query} onQueryChange={setQuery}
        onSearch={onSearch} onKeyDown={() => {}} isLoading={false} submitDisabled={!value}
        footer={<ResearchJurisdictionPicker compact value={value} onChange={setValue} />} />;
    }
    render(<Composer />);

    const question = screen.getByRole("textbox", { name: "Your legal question" });
    const send = screen.getByRole("button", { name: "Send question" });
    fireEvent.change(question, { target: { value: "What are my rights as a tenant?" } });
    expect(question).toBeEnabled();
    expect(send).toBeDisabled();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Choose jurisdiction" }));
    const dialog = screen.getByRole("dialog", { name: "Choose jurisdiction" });
    const geographic = within(dialog).getByRole("radio", { name: "Geographic" });
    expect(geographic).toHaveFocus();
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(mocks.query).not.toHaveBeenCalled();
    fireEvent.click(geographic);
    const search = screen.getByRole("combobox", { name: "Find jurisdiction" });
    expect(search).toHaveFocus();
    await act(async () => vi.advanceTimersByTime(250));
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });

    const change = screen.getByRole("button", { name: "Change jurisdiction" });
    expect(change).toHaveTextContent("Ghana");
    expect(change).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(question).toHaveValue("What are my rights as a tenant?");
    expect(send).toBeEnabled();
    fireEvent.click(send);
    expect(onSearch).toHaveBeenCalledOnce();

    fireEvent.click(change);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(change).toHaveFocus();
    expect(change).toHaveTextContent("Ghana");
  });

  it("waits for type selection and the exact 250ms debounce", async () => {
    mocks.query.mockResolvedValue({
      page: [ghana],
      group: "geographic",
      isDone: true,
      continueCursor: null,
    } satisfies SearchPage);
    render(<ResearchJurisdictionPicker value={null} onChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Choose jurisdiction" })).toBeDisabled();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
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

  it("collapses a selection, restores focus, and preserves it when changing is cancelled", async () => {
    mocks.query.mockResolvedValue({
      page: [ghana],
      group: "geographic",
      isDone: true,
      continueCursor: null,
    } satisfies SearchPage);
    render(<ControlledPicker />);

    fireEvent.click(screen.getByRole("radio", { name: "Geographic" }));
    expect(screen.getByRole("dialog", { name: "Choose jurisdiction" })).toBeVisible();
    const search = screen.getByRole("combobox", { name: "Find jurisdiction" });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "Ghana" } });
    await act(async () => vi.advanceTimersByTime(250));
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("option", { name: "Ghana, Geographic" }));

    const change = screen.getByRole("button", { name: "Change jurisdiction" });
    expect(change).toHaveTextContent("Ghana");
    expect(change).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    fireEvent.click(change);
    const reopenedSearch = screen.getByRole("combobox", { name: "Find jurisdiction" });
    expect(reopenedSearch).toHaveValue("");
    expect(reopenedSearch).toHaveFocus();
    await act(async () => vi.advanceTimersByTime(250));
    expect(mocks.query).toHaveBeenLastCalledWith(expect.anything(), {
      kind: "geographic", query: "", cursor: null,
    });
    fireEvent.change(reopenedSearch, { target: { value: "Accra" } });
    fireEvent.keyDown(reopenedSearch, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(change).toHaveTextContent("Ghana");
    expect(change).toHaveFocus();
  });

  it("dismisses on an outside pointer or focus leaving the picker", () => {
    mocks.query.mockReturnValue(new Promise(() => undefined));
    render(<><ControlledPicker initialValue={ghana} /><button type="button">Outside action</button></>);
    const change = screen.getByRole("button", { name: "Change jurisdiction" });
    const outside = screen.getByRole("button", { name: "Outside action" });

    fireEvent.click(change);
    fireEvent.pointerDown(outside);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(change).toHaveTextContent("Ghana");

    fireEvent.click(change);
    fireEvent.blur(screen.getByRole("combobox", { name: "Find jurisdiction" }), { relatedTarget: outside });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(change).toHaveTextContent("Ghana");
  });

  it("does not submit the research form when Enter has no matching option", async () => {
    mocks.query.mockResolvedValue({
      page: [], group: "geographic", isDone: true, continueCursor: null,
    } satisfies SearchPage);
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    render(<form onSubmit={onSubmit}><ControlledPicker initialValue={ghana} /><button type="submit">Research</button></form>);
    fireEvent.click(screen.getByRole("button", { name: "Change jurisdiction" }));
    const search = screen.getByRole("combobox", { name: "Find jurisdiction" });
    fireEvent.change(search, { target: { value: "missing" } });
    await act(async () => vi.advanceTimersByTime(250));
    await act(async () => Promise.resolve());

    expect(screen.getByRole("status")).toHaveTextContent("No matching jurisdictions found.");
    expect(fireEvent.keyDown(search, { key: "Enter" })).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Change jurisdiction" })).toHaveTextContent("Ghana");
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
    const loadMore = screen.getByRole("button", { name: "Load more jurisdictions" });
    act(() => loadMore.focus());
    fireEvent.click(loadMore);
    expect(search).toHaveFocus();
    await act(async () => Promise.resolve());
    expect(mocks.query).toHaveBeenLastCalledWith(expect.anything(), {
      kind: "geographic",
      query: "",
      cursor: "opaque-next",
    });
    expect(
      screen.getAllByRole("option", { name: "Ghana, Geographic" }),
    ).toHaveLength(1);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(ghana);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("ignores an older response and preserves the controlled selection", async () => {
    const oldSearch = deferred<SearchPage>();
    const newSearch = deferred<SearchPage>();
    mocks.query.mockReturnValueOnce(oldSearch.promise).mockReturnValueOnce(newSearch.promise);
    const { rerender } = render(<ResearchJurisdictionPicker value={ghana} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change jurisdiction" }));
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

    expect(screen.getByRole("button", { name: "Change jurisdiction" })).toHaveTextContent("Ghana");
    expect(screen.getByRole("option", { name: "Accra, Geographic" })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "Old result, Geographic" }),
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

    expect(screen.getByRole("option", { name: "Member Council, Organizational" })).toBeVisible();
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
    const retry = screen.getByRole("button", { name: "Retry jurisdiction search" });
    act(() => retry.focus());
    fireEvent.click(retry);
    expect(screen.getByRole("combobox", { name: "Find jurisdiction" })).toHaveFocus();
    await act(async () => Promise.resolve());
    expect(mocks.query).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("status")).toHaveTextContent("No matching jurisdictions found.");
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
      screen.getByRole("option", { name: "Member Council, Organizational" }),
    ).toBeVisible();

    mocks.sessionUserId = "member-b";
    rerender(<ResearchJurisdictionPicker value={null} onChange={vi.fn()} />);
    expect(
      screen.queryByRole("option", { name: "Member Council, Organizational" }),
    ).not.toBeInTheDocument();
  });

  it("keeps useful organization context without repeating a sole jurisdiction name", async () => {
    mocks.auth = { isAuthenticated: true, isLoading: false };
    mocks.sessionUserId = "member-a";
    const organizational = { ...ghana, kind: "organizational" as const, isDefault: false };
    const university = { id: "northstar", name: "Northstar University" };
    mocks.query.mockResolvedValue({
      page: [
        { ...organizational, id: "au", name: "African Union (AU)", slug: "au-african-union-au", organization: { id: "au-org", name: "African Union" }, visibility: "public" },
        { ...organizational, id: "council-employment", name: "Employment", slug: "council-employment", organization: { id: "council", name: "Member Council" }, visibility: "members" },
        { ...organizational, id: "northstar-employment", name: "Employment", slug: "northstar-employment", organization: university, visibility: "public" },
        { ...organizational, id: "northstar-campus", name: "Campus", slug: "northstar-campus", organization: university, visibility: "public" },
      ],
      group: "your_organizations",
      isDone: true,
      continueCursor: null,
    } satisfies SearchPage);
    render(<ControlledPicker />);
    fireEvent.click(screen.getByRole("radio", { name: "Organizational" }));
    await act(async () => vi.advanceTimersByTime(250));
    await act(async () => Promise.resolve());

    const africanUnion = screen.getByRole("option", { name: "African Union (AU), Organizational" });
    expect(within(africanUnion).getByText("African Union (AU)")).toBeVisible();
    expect(screen.queryByText("African Union", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("au-african-union-au")).not.toBeInTheDocument();
    expect(screen.queryByText("Public", { exact: true })).not.toBeInTheDocument();
    const memberEmployment = screen.getByRole("option", { name: "Employment, Organizational, Member Council" });
    expect(within(memberEmployment).getByText("Member Council")).toBeVisible();
    expect(within(memberEmployment).getByText("Private · Your organization")).toBeVisible();
    const universityGroup = screen.getByRole("group", { name: "Northstar University" });
    expect(within(universityGroup).getAllByText("Northstar University")).toHaveLength(1);
    expect(within(universityGroup).getAllByRole("option")).toHaveLength(2);

    fireEvent.click(africanUnion);
    expect(screen.getByRole("button", { name: "Change jurisdiction" })).toHaveTextContent("Selected: African Union (AU)");
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
