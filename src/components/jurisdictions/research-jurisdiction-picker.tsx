"use client";

import { api } from "@/convex/_generated/api";
import { authClient } from "@/lib/auth-client";
import type { ResearchJurisdiction, ResearchJurisdictionKind } from "@/lib/countries";
import { useConvex, useConvexAuth } from "convex/react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

type SearchGroup = "geographic" | "your_organizations" | "public_organizations";
type SearchPage = {
  page: ResearchJurisdiction[];
  group: SearchGroup;
  isDone: boolean;
  continueCursor: string | null;
};

interface ResultSection {
  group: SearchGroup;
  rows: ResearchJurisdiction[];
}

interface ResearchJurisdictionPickerProps {
  value: ResearchJurisdiction | null;
  onChange: (selection: ResearchJurisdiction | null) => void;
  disabled?: boolean;
}

const GROUP_LABELS: Record<SearchGroup, string> = {
  geographic: "Geographic jurisdictions",
  your_organizations: "Your organizations",
  public_organizations: "Public organizations",
};

function normalizeQuery(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function appendPage(
  sections: readonly ResultSection[],
  group: SearchGroup,
  rows: readonly ResearchJurisdiction[],
): ResultSection[] {
  const seen = new Set(sections.flatMap((section) => section.rows.map((row) => row.id)));
  const unique = rows.slice(0, 20).filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  const existing = sections.findIndex((section) => section.group === group);
  if (existing < 0) return [...sections, { group, rows: unique }];
  return sections.map((section, index) =>
    index === existing ? { ...section, rows: [...section.rows, ...unique] } : section,
  );
}

export function ResearchJurisdictionPicker({
  value,
  onChange,
  disabled = false,
}: ResearchJurisdictionPickerProps) {
  const client = useConvex();
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const session = authClient.useSession();
  const sessionUserId = session.data?.user.id ?? null;
  const authKey = sessionUserId ?? (isAuthenticated ? "authenticated" : "anonymous");
  const listboxId = useId();
  const [kind, setKind] = useState<ResearchJurisdictionKind | null>(value?.kind ?? null);
  const [input, setInput] = useState("");
  const [sections, setSections] = useState<ResultSection[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isDone, setIsDone] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const requestGeneration = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const previousIdentity = useRef({ isAuthenticated, userId: sessionUserId });
  const normalizedInput = normalizeQuery(input);
  const rows = sections.flatMap((section) => section.rows);

  const runSearch = useCallback(
    async (nextCursor: string | null, append: boolean) => {
      if (!kind || authLoading || disabled) return;
      requestController.current?.abort();
      const controller = new AbortController();
      requestController.current = controller;
      const generation = ++requestGeneration.current;
      setLoading(true);
      setError(false);
      try {
        const result = (await client.query(api.jurisdictions.searchAccessible, {
          kind,
          query: normalizedInput,
          cursor: nextCursor,
        })) as SearchPage;
        if (controller.signal.aborted || generation !== requestGeneration.current) return;
        setSections((current) =>
          append ? appendPage(current, result.group, result.page) : [
            { group: result.group, rows: result.page.slice(0, 20) },
          ],
        );
        setCursor(result.continueCursor);
        setIsDone(result.isDone);
        setActiveIndex(-1);
      } catch {
        if (controller.signal.aborted || generation !== requestGeneration.current) return;
        setError(true);
      } finally {
        if (!controller.signal.aborted && generation === requestGeneration.current) {
          setLoading(false);
        }
      }
    }, [authLoading, client, disabled, kind, normalizedInput]);

  useEffect(() => {
    requestController.current?.abort();
    requestGeneration.current += 1;
    setSections([]);
    setCursor(null);
    setIsDone(true);
    setError(false);
    setActiveIndex(-1);
    if (!kind || authLoading || disabled) return;
    const timer = window.setTimeout(() => void runSearch(null, false), 250);
    return () => {
      window.clearTimeout(timer);
      requestController.current?.abort();
    };
  }, [authKey, authLoading, disabled, kind, normalizedInput, runSearch]);

  useEffect(
    () => () => {
      requestGeneration.current += 1;
      requestController.current?.abort();
    },
    [],
  );

  useEffect(() => {
    const previous = previousIdentity.current;
    const authenticationChanged = previous.isAuthenticated !== isAuthenticated;
    const accountChanged =
      previous.userId !== null &&
      sessionUserId !== null &&
      previous.userId !== sessionUserId;
    previousIdentity.current = {
      isAuthenticated,
      userId: sessionUserId ?? (isAuthenticated ? previous.userId : null),
    };
    if ((authenticationChanged || accountChanged) && value) {
      onChange(null);
    }
  }, [isAuthenticated, onChange, sessionUserId, value]);

  function choose(row: ResearchJurisdiction) {
    onChange(row);
    setActiveIndex(rows.findIndex((candidate) => candidate.id === row.id));
  }

  return (
    <fieldset className="grid gap-4" disabled={disabled || authLoading}>
      <legend className="text-sm font-semibold">Jurisdiction type</legend>
      <div className="flex flex-wrap gap-5" role="radiogroup" aria-label="Jurisdiction type">
        {(["geographic", "organizational"] as const).map((option) => (
          <label key={option} className="inline-flex min-h-11 items-center gap-2 text-sm">
            <input
              type="radio"
              name="research-jurisdiction-kind"
              value={option}
              checked={kind === option}
              onChange={() => {
                setKind(option);
                setInput("");
              }}
              className="size-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {option === "geographic" ? "Geographic" : "Organizational"}
          </label>
        ))}
      </div>

      <div className="grid gap-2">
        <label htmlFor={`${listboxId}-input`} className="text-sm font-semibold">
          Find jurisdiction
        </label>
        <input
          id={`${listboxId}-input`}
          role="combobox"
          aria-controls={listboxId}
          aria-expanded={rows.length > 0}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
          disabled={!kind || disabled || authLoading}
          value={input}
          maxLength={120}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && rows.length > 0) {
              event.preventDefault();
              setActiveIndex((current) => (current + 1) % rows.length);
            } else if (event.key === "ArrowUp" && rows.length > 0) {
              event.preventDefault();
              setActiveIndex((current) => (current <= 0 ? rows.length - 1 : current - 1));
            } else if (event.key === "Enter" && activeIndex >= 0 && rows[activeIndex]) {
              event.preventDefault();
              choose(rows[activeIndex]);
            } else if (event.key === "Escape") {
              setActiveIndex(-1);
            }
          }}
          placeholder={kind ? "Search by jurisdiction name" : "Choose a type first"}
          className="min-h-11 w-full border border-input bg-transparent px-3 text-inherit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>

      {value ? (
        <p className="text-sm font-medium" aria-live="polite">
          Selected: {value.name}
        </p>
      ) : null}

      <div id={listboxId} role="listbox" aria-label="Jurisdiction results" className="grid gap-3">
        {sections.map((section) => (
          <div key={section.group} role="group" aria-label={GROUP_LABELS[section.group]}>
            <p className="mb-2 text-xs font-bold uppercase tracking-wide">
              {GROUP_LABELS[section.group]}
            </p>
            <ul className="grid gap-1">
              {section.rows.map((row) => {
                const index = rows.findIndex((candidate) => candidate.id === row.id);
                const kindLabel = row.kind === "geographic" ? "Geographic" : "Organizational";
                return (
                  <li
                    id={`${listboxId}-${index}`}
                    key={row.id}
                    role="option"
                    aria-label={`${row.name}, ${kindLabel}, ${row.slug}`}
                    aria-selected={value?.id === row.id}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(row)}
                    className={`min-h-11 cursor-pointer border px-3 py-2 text-sm hover:border-input ${
                      activeIndex === index
                        ? "border-input bg-muted ring-2 ring-ring"
                        : "border-transparent"
                    }`}
                  >
                    <span className="block font-medium">{row.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {kindLabel} <span aria-hidden>·</span> {row.slug}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <div aria-live="polite">
        {loading ? <p role="status">Loading jurisdictions…</p> : null}
        {error ? (
          <div className="grid justify-items-start gap-2">
            <p role="status">Jurisdictions could not be loaded. Try again.</p>
            <button
              type="button"
              onClick={() => void runSearch(null, false)}
              className="min-h-11 border border-input px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Retry jurisdiction search
            </button>
          </div>
        ) : null}
        {!loading && !error && kind && sections.length > 0 && rows.length === 0 ? (
          <p role="status">No matching jurisdictions found.</p>
        ) : null}
      </div>

      {!isDone && cursor ? (
        <button
          type="button"
          onClick={() => void runSearch(cursor, true)}
          disabled={loading}
          className="min-h-11 justify-self-start border border-input px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          Load more jurisdictions
        </button>
      ) : null}
    </fieldset>
  );
}
