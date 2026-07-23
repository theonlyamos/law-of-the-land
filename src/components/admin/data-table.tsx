import Link from "next/link";
import type { ReactNode } from "react";

export type AdminDataColumn = {
  key: string;
  label: string;
  align?: "start" | "end";
};

export type AdminDataRow = {
  id: string;
  cells: Record<string, ReactNode>;
};

export type AdminDataFilter =
  | {
      name: string;
      label: string;
      value: string;
      placeholder?: string;
      options?: never;
    }
  | {
      name: string;
      label: string;
      value: string;
      options: ReadonlyArray<{ value: string; label: string }>;
      placeholder?: never;
    };

type DataTableProps = {
  ariaLabel: string;
  basePath: string;
  columns: readonly AdminDataColumn[];
  rows: readonly AdminDataRow[];
  filters?: readonly AdminDataFilter[];
  currentCursor: string | null;
  previousCursors: readonly string[];
  nextCursor: string;
  isDone: boolean;
  state?: "ready" | "loading" | "error";
  emptyMessage?: string;
  errorMessage?: string;
};

export type AdminTableSearchParams = Record<
  string,
  string | string[] | undefined
>;

export function readAdminTableNavigation(
  searchParams: AdminTableSearchParams,
): {
  cursor: string | null;
  previousCursors: string[];
  isValid: boolean;
} {
  const cursorValue = searchParams.cursor;
  if (Array.isArray(cursorValue)) {
    return { cursor: null, previousCursors: [], isValid: false };
  }

  const historyValue = searchParams.history;
  const previousCursors =
    historyValue === undefined
      ? []
      : Array.isArray(historyValue)
        ? historyValue
        : [historyValue];
  if (
    previousCursors.length > 25 ||
    previousCursors.some((cursor) => !cursor)
  ) {
    return { cursor: null, previousCursors: [], isValid: false };
  }

  return {
    cursor: cursorValue || null,
    previousCursors,
    isValid: true,
  };
}

const FIRST_PAGE_MARKER = "~";

function pageHref({
  basePath,
  filters,
  cursor,
  history,
}: {
  basePath: string;
  filters: readonly AdminDataFilter[];
  cursor: string | null;
  history: readonly string[];
}) {
  const parameters = new URLSearchParams();
  for (const filter of filters) {
    if (filter.value) {
      parameters.set(filter.name, filter.value);
    }
  }
  for (const previousCursor of history) {
    parameters.append("history", previousCursor);
  }
  if (cursor) {
    parameters.set("cursor", cursor);
  }
  const query = parameters.toString();
  return query ? `${basePath}?${query}` : basePath;
}

function DataState({
  role,
  message,
  basePath,
}: {
  role: "status" | "alert";
  message: string;
  basePath?: string;
}) {
  return (
    <div
      role={role}
      className="border-y border-[oklch(74%_0.028_78)] bg-[oklch(96%_0.014_82)] px-5 py-10 sm:px-7"
    >
      <p className="max-w-[62ch] text-sm leading-6 text-[oklch(36%_0.04_252)]">
        {message}
      </p>
      {basePath ? (
        <Link
          href={basePath}
          className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-[oklch(30%_0.065_252)] underline decoration-[oklch(56%_0.11_68)] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
        >
          Clear filters
        </Link>
      ) : null}
    </div>
  );
}

export function DataTable({
  ariaLabel,
  basePath,
  columns,
  rows,
  filters = [],
  currentCursor,
  previousCursors,
  nextCursor,
  isDone,
  state = "ready",
  emptyMessage = "No records match this view.",
  errorMessage = "These records could not be loaded. Check the filters and try again.",
}: DataTableProps) {
  const previousHistory = previousCursors.slice(0, -1);
  const previousCursor = previousCursors.at(-1);
  const nextHistory = [
    ...previousCursors,
    currentCursor ?? FIRST_PAGE_MARKER,
  ];

  return (
    <section className="@container" aria-label={`${ariaLabel} records`}>
      {filters.length > 0 ? (
        <form
          action={basePath}
          method="get"
          className="mb-7 grid items-end gap-4 border-y border-[oklch(74%_0.028_78)] bg-[oklch(91%_0.028_79)] px-4 py-5 @min-[40rem]:grid-cols-[12rem_minmax(16rem,1fr)_auto] sm:px-6"
        >
          {filters.map((filter) => (
            <label
              key={filter.name}
              className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-[oklch(39%_0.045_252)]"
            >
              {filter.label}
              {filter.options ? (
                <select
                  name={filter.name}
                  defaultValue={filter.value}
                  className="min-h-11 border border-[oklch(61%_0.035_252)] bg-[oklch(98%_0.01_82)] px-3 text-base font-normal normal-case tracking-normal text-[oklch(23%_0.045_252)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
                >
                  {filter.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  name={filter.name}
                  defaultValue={filter.value}
                  placeholder={filter.placeholder}
                  className="min-h-11 border border-[oklch(61%_0.035_252)] bg-[oklch(98%_0.01_82)] px-3 text-base font-normal normal-case tracking-normal text-[oklch(23%_0.045_252)] placeholder:text-[oklch(48%_0.035_252)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
                />
              )}
            </label>
          ))}
          <button
            type="submit"
            className="inline-flex min-h-11 items-center justify-center bg-[oklch(28%_0.055_252)] px-5 text-sm font-semibold text-[oklch(97%_0.012_82)] transition-colors duration-150 hover:bg-[oklch(23%_0.055_252)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
          >
            Apply exact lookup
          </button>
        </form>
      ) : null}

      {state === "loading" ? (
        <DataState
          role="status"
          message={`Loading ${ariaLabel.toLowerCase().replace(/s$/, "")} records…`}
        />
      ) : state === "error" ? (
        <DataState role="alert" message={errorMessage} basePath={basePath} />
      ) : rows.length === 0 ? (
        <DataState role="status" message={emptyMessage} />
      ) : (
        <div className="overflow-x-auto [scrollbar-color:oklch(55%_0.04_252)_oklch(92%_0.02_79)]">
          <table
            aria-label={ariaLabel}
            className="block w-full border-collapse text-left md:table"
          >
            <thead className="hidden border-b-2 border-[oklch(35%_0.055_252)] md:table-header-group">
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={`px-4 py-3 text-xs font-semibold uppercase tracking-[0.13em] text-[oklch(39%_0.045_252)] ${
                      column.align === "end" ? "text-right" : ""
                    }`}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="block divide-y divide-[oklch(78%_0.025_78)] md:table-row-group">
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="block py-3 md:table-row md:py-0 md:hover:bg-[oklch(91%_0.025_79)]"
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      data-label={column.label}
                      className={`grid min-h-11 grid-cols-[minmax(7rem,0.42fr)_minmax(0,1fr)] items-center gap-4 px-4 py-2 text-sm leading-6 text-[oklch(29%_0.04_252)] md:table-cell md:px-4 md:py-4 ${
                        column.align === "end" ? "md:text-right" : ""
                      }`}
                    >
                      <span className="text-xs font-semibold uppercase tracking-[0.11em] text-[oklch(46%_0.035_252)] md:hidden">
                        {column.label}
                      </span>
                      <span className="min-w-0 break-words">
                        {row.cells[column.key] ?? "—"}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav
        aria-label={`${ariaLabel} pagination`}
        className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[oklch(74%_0.028_78)] pt-4"
      >
        {previousCursor === undefined ? (
          <span className="inline-flex min-h-11 items-center px-3 text-sm text-[oklch(52%_0.025_252)]">
            First page
          </span>
        ) : (
          <Link
            href={pageHref({
              basePath,
              filters,
              cursor:
                previousCursor === FIRST_PAGE_MARKER ? null : previousCursor,
              history: previousHistory,
            })}
            className="inline-flex min-h-11 items-center px-3 text-sm font-semibold underline decoration-[oklch(56%_0.11_68)] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
          >
            Previous page
          </Link>
        )}
        {isDone ? (
          <span className="inline-flex min-h-11 items-center px-3 text-sm text-[oklch(52%_0.025_252)]">
            End of results
          </span>
        ) : (
          <Link
            href={pageHref({
              basePath,
              filters,
              cursor: nextCursor,
              history: nextHistory,
            })}
            className="inline-flex min-h-11 items-center px-3 text-sm font-semibold underline decoration-[oklch(56%_0.11_68)] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
          >
            Next page
          </Link>
        )}
      </nav>
    </section>
  );
}
