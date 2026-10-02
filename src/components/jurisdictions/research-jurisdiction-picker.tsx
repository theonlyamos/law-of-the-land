"use client";

import { api } from "@/convex/_generated/api";
import { authClient } from "@/lib/auth-client";
import type { ResearchJurisdiction, ResearchJurisdictionKind } from "@/lib/countries";
import { useConvex, useConvexAuth } from "convex/react";
import { Check, ChevronDown, Search } from "lucide-react";
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
  organization?: { id: string; name: string };
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
  const result = sections.map(section => ({ ...section, rows: [...section.rows] }));
  for (const row of unique) {
    let section = result.find(item => item.group === group && item.organization?.id === row.organization?.id);
    if (!section) { section = { group, organization: row.organization, rows: [] }; result.push(section); }
    section.rows.push(row);
  }
  if (!result.length) result.push({group, rows:[]});
  return result;
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
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLFieldSetElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const expanded = open && !disabled && !authLoading;
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
  const nameCounts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.organization?.id ?? ""}/${row.name}`;
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const selectedOrganization = value?.organization?.name;
  const selectionLabel = value && selectedOrganization && !value.name.startsWith(selectedOrganization)
    ? `${selectedOrganization} / ${value.name}`
    : value?.name;

  useEffect(() => {
    if (!expanded) return;
    searchInput.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);

  useEffect(() => {
    if (activeIndex >= 0) {
      document.getElementById(`${listboxId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, listboxId]);

  const runSearch = useCallback(
    async (nextCursor: string | null, append: boolean) => {
      if (!open || !kind || authLoading || disabled) return;
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
          appendPage(append ? current : [], result.group, result.page),
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
    }, [authLoading, client, disabled, kind, normalizedInput, open]);

  useEffect(() => {
    requestController.current?.abort();
    requestGeneration.current += 1;
    setSections([]);
    setCursor(null);
    setIsDone(true);
    setError(false);
    setActiveIndex(-1);
    setLoading(open && !!kind && !authLoading && !disabled);
    if (!open || !kind || authLoading || disabled) return;
    const timer = window.setTimeout(() => void runSearch(null, false), 250);
    return () => {
      window.clearTimeout(timer);
      requestController.current?.abort();
    };
  }, [authKey, authLoading, disabled, kind, normalizedInput, open, runSearch]);

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
    setOpen(false);
    trigger.current?.focus();
  }

  function openPicker() {
    if (value) setKind(value.kind);
    setInput("");
    setOpen(true);
  }

  return (
    <fieldset
      ref={root}
      className="grid min-w-0 gap-3"
      disabled={disabled || authLoading}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <legend className="mb-2 text-sm font-semibold">Jurisdiction</legend>
      {(!value || expanded) && (
        <div className="flex w-fit max-w-full flex-wrap gap-1 rounded bg-muted/50 p-1" role="radiogroup" aria-label="Jurisdiction type">
          {(["geographic", "organizational"] as const).map((option) => (
            <label key={option} className="relative cursor-pointer text-sm">
              <input
                type="radio"
                name={`${listboxId}-kind`}
                value={option}
                checked={kind === option}
                onChange={() => {
                  setKind(option);
                  setInput("");
                  setOpen(true);
                  searchInput.current?.focus();
                }}
                className="peer absolute inset-0 m-0 h-full w-full cursor-pointer opacity-0"
              />
              <span className="pointer-events-none flex min-h-11 items-center rounded px-3 peer-checked:bg-[var(--ink,hsl(var(--primary)))] peer-checked:text-[var(--paper-light,hsl(var(--primary-foreground)))] peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                {option === "geographic" ? "Geographic" : "Organizational"}
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="relative min-w-0">
        <button
          ref={trigger}
          type="button"
          aria-label={value ? "Change jurisdiction" : "Choose jurisdiction"}
          aria-describedby={value ? `${listboxId}-selection` : undefined}
          aria-haspopup="dialog"
          aria-expanded={expanded}
          aria-controls={`${listboxId}-panel`}
          disabled={!kind || disabled || authLoading}
          onClick={() => expanded ? setOpen(false) : openPicker()}
          className="flex min-h-12 w-full items-center justify-between gap-3 rounded border border-input px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span id={`${listboxId}-selection`} className="min-w-0 break-words" aria-live="polite">
            {value ? <><span className="sr-only">Selected: </span>{selectionLabel}</> : kind ? "Choose jurisdiction" : "Choose a type first"}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {value && <span className="text-xs underline underline-offset-4">Change</span>}
            <ChevronDown className="size-4" aria-hidden="true" />
          </span>
        </button>

        {expanded && (
          <div
            id={`${listboxId}-panel`}
            role="dialog"
            aria-label="Choose jurisdiction"
            className="absolute left-0 top-full z-50 mt-2 grid w-full min-w-0 gap-2 rounded border border-input p-2 shadow-xl"
            style={{ backgroundColor: "var(--paper-light, hsl(var(--popover)))" }}
          >
            <div className="flex items-center gap-2 rounded border border-input px-3">
              <Search className="size-4 shrink-0" aria-hidden="true" />
              <label htmlFor={`${listboxId}-input`} className="sr-only">Find jurisdiction</label>
              <input
                ref={searchInput}
                id={`${listboxId}-input`}
                role="combobox"
                aria-controls={listboxId}
                aria-expanded={expanded}
                aria-autocomplete="list"
                aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
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
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    if (activeIndex >= 0 && rows[activeIndex]) choose(rows[activeIndex]);
                  }
                }}
                placeholder={kind === "organizational" ? "Search organizations or jurisdictions" : "Search by jurisdiction name"}
                className="min-h-11 w-full min-w-0 bg-transparent text-base text-inherit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            <div id={listboxId} role="listbox" aria-label="Jurisdiction results" aria-busy={loading} className="grid max-h-[min(15rem,40dvh)] gap-2 overflow-y-auto overscroll-contain p-1">
              {sections.map((section) => (
                <div key={`${section.group}:${section.organization?.id ?? "geographic"}`} role="group" aria-label={section.organization?.name ?? GROUP_LABELS[section.group]}>
                  {section.organization && section.rows.length > 1 && (
                    <p className="mb-1 px-2 text-xs font-semibold text-muted-foreground">{section.organization.name}</p>
                  )}
                  {section.rows.map((row) => {
                    const index = rows.findIndex((candidate) => candidate.id === row.id);
                    const kindLabel = row.kind === "geographic" ? "Geographic" : "Organizational";
                    const organization = row.organization && !row.name.startsWith(row.organization.name) ? row.organization.name : undefined;
                    const duplicateName = (nameCounts.get(`${row.organization?.id ?? ""}/${row.name}`) ?? 0) > 1;
                    return (
                      <div
                        id={`${listboxId}-${index}`}
                        key={row.id}
                        role="option"
                        aria-label={[row.name, kindLabel, organization, duplicateName ? row.slug : undefined].filter(Boolean).join(", ")}
                        aria-selected={value?.id === row.id}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => choose(row)}
                        className={`min-h-11 cursor-pointer rounded border px-2 py-2 text-sm hover:border-input ${
                          activeIndex === index ? "border-input bg-muted ring-2 ring-ring" : "border-transparent"
                        }`}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="min-w-0 break-words font-medium">{row.name}</span>
                          {value?.id === row.id && <Check className="size-4 shrink-0" aria-hidden="true" />}
                        </span>
                        {organization && section.rows.length === 1 && <span className="block text-xs text-muted-foreground">{organization}</span>}
                        {row.visibility === "members" && <span className="block text-xs text-muted-foreground">Private · Your organization</span>}
                        {duplicateName && <span className="block break-all text-xs text-muted-foreground">{row.slug}</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            <div aria-live="polite" className="text-sm">
              {loading ? <p role="status" className="px-2">Loading jurisdictions…</p> : null}
              {error ? (
                <div className="grid justify-items-start gap-2">
                  <p role="status">Jurisdictions could not be loaded. Try again.</p>
                  <button type="button" onClick={() => { searchInput.current?.focus(); void runSearch(null, false); }} className="min-h-11 rounded border border-input px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Retry jurisdiction search
                  </button>
                </div>
              ) : null}
              {!loading && !error && sections.length > 0 && rows.length === 0 ? <p role="status" className="px-2">No matching jurisdictions found.</p> : null}
            </div>

            {!isDone && cursor ? (
              <button type="button" onClick={() => { searchInput.current?.focus(); void runSearch(cursor, true); }} disabled={loading} className="min-h-11 rounded border border-input px-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
                Load more jurisdictions
              </button>
            ) : null}
          </div>
        )}
      </div>
    </fieldset>
  );
}
