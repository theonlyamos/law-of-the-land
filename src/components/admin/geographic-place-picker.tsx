"use client";

import type { VerifiedPlace } from "@/lib/google-places";
import { type ChangeEvent, type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";

type PlaceSuggestion = {
  placeId: string;
  primaryText: string;
  secondaryText: string;
  types: string[];
};

export type GeographicPlaceSelection = {
  place: VerifiedPlace;
  verifiedPlaceClaim: string;
  expiresAt: number;
};

export type GeographicPlacePickerProps = {
  value: GeographicPlaceSelection | null;
  onChange(value: GeographicPlaceSelection | null): void;
  disabled?: boolean;
};

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 3;
const MAX_QUERY_LENGTH = 200;

function requestError(response: Response) {
  return response.status === 401 || response.status === 403
    ? "Your administration session can no longer search places. Sign in again and retry."
    : "Place search is temporarily unavailable. Check the query and retry.";
}

export function GeographicPlacePicker({ value, onChange, disabled = false }: GeographicPlacePickerProps) {
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const sessionToken = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const onChangeRef = useRef(onChange);
  const detailsInFlight = useRef(false);
  const suppressAutocomplete = useRef(false);

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const startSession = useCallback(() => {
    if (!sessionToken.current) sessionToken.current = crypto.randomUUID();
    return sessionToken.current;
  }, []);

  useEffect(() => () => {
    generation.current += 1;
    controller.current?.abort();
  }, []);

  useEffect(() => {
    if (!value) return;
    const remaining = value.expiresAt - Date.now();
    if (remaining <= 0) {
      onChangeRef.current(null);
      setStatus("The verified place selection expired. Search and select it again.");
      return;
    }
    const timeout = window.setTimeout(() => {
      onChangeRef.current(null);
      setStatus("The verified place selection expired. Search and select it again.");
    }, remaining);
    return () => window.clearTimeout(timeout);
  }, [value]);

  useEffect(() => {
    const normalized = query.trim();
    generation.current += 1;
    const requestGeneration = generation.current;
    controller.current?.abort();
    if (suppressAutocomplete.current) {
      suppressAutocomplete.current = false;
      setLoading(false);
      return;
    }
    if (normalized.length < MIN_QUERY_LENGTH || normalized.length > MAX_QUERY_LENGTH) {
      setSuggestions([]);
      setActiveIndex(-1);
      setLoading(false);
      return;
    }
    const timeout = window.setTimeout(async () => {
      const token = startSession();
      const nextController = new AbortController();
      controller.current = nextController;
      setLoading(true);
      setError("");
      try {
        const response = await fetch("/api/admin/geographic-places/autocomplete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: normalized, sessionToken: token }),
          signal: nextController.signal,
        });
        if (requestGeneration !== generation.current || nextController.signal.aborted) return;
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            setSuggestions([]);
            onChangeRef.current(null);
          }
          throw new Error(requestError(response));
        }
        const payload = await response.json() as { suggestions?: PlaceSuggestion[] };
        if (requestGeneration !== generation.current || nextController.signal.aborted) return;
        const next = Array.isArray(payload.suggestions) ? payload.suggestions.slice(0, 5) : [];
        setSuggestions(next);
        setActiveIndex(-1);
        setStatus(next.length === 0 ? "No Google Places suggestions found." : `${next.length} place suggestions available.`);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        if (requestGeneration !== generation.current) return;
        setError(cause instanceof Error ? cause.message : "Place search is temporarily unavailable. Retry shortly.");
      } finally {
        if (requestGeneration === generation.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [query, startSession]);

  async function selectSuggestion(suggestion: PlaceSuggestion) {
    const token = startSession();
    const nextController = new AbortController();
    controller.current?.abort();
    controller.current = nextController;
    generation.current += 1;
    const requestGeneration = generation.current;
    detailsInFlight.current = true;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/geographic-places/details", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ placeId: suggestion.placeId, sessionToken: token }),
        signal: nextController.signal,
      });
      if (requestGeneration !== generation.current || nextController.signal.aborted) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          setSuggestions([]);
          onChangeRef.current(null);
        }
        throw new Error(requestError(response));
      }
      const selection = await response.json() as GeographicPlaceSelection;
      if (requestGeneration !== generation.current || nextController.signal.aborted) return;
      onChangeRef.current(selection);
      if (selection.place.displayName !== query) {
        suppressAutocomplete.current = true;
        setQuery(selection.place.displayName);
      }
      setSuggestions([]);
      setActiveIndex(-1);
      setStatus(`${selection.place.formattedAddress} selected and verified.`);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        if (requestGeneration !== generation.current) return;
        setError(cause instanceof Error ? cause.message : "Place details are temporarily unavailable. Retry the search.");
      }
    } finally {
      detailsInFlight.current = false;
      if (sessionToken.current === token) sessionToken.current = null;
      if (requestGeneration === generation.current) setLoading(false);
    }
  }

  function onInput(event: ChangeEvent<HTMLInputElement>) {
    generation.current += 1;
    controller.current?.abort();
    if (detailsInFlight.current) {
      sessionToken.current = null;
      detailsInFlight.current = false;
    }
    setQuery(event.target.value.slice(0, MAX_QUERY_LENGTH));
    setSuggestions([]);
    setActiveIndex(-1);
    setError("");
    if (value) onChange(null);
    setStatus("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      void selectSuggestion(suggestions[activeIndex]);
    } else if (event.key === "Escape") {
      generation.current += 1;
      controller.current?.abort();
      setSuggestions([]);
      setActiveIndex(-1);
    }
  }

  return (
    <div className="grid gap-3 sm:col-span-2 lg:col-span-4">
      <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.11em] text-[oklch(39%_0.045_252)]">
        Find place
        <input
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls={suggestions.length > 0 ? listboxId : undefined}
          aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
          aria-autocomplete="list"
          value={query}
          disabled={disabled}
          maxLength={MAX_QUERY_LENGTH}
          onFocus={startSession}
          onChange={onInput}
          onKeyDown={onKeyDown}
          className="min-h-11 w-full border border-[oklch(61%_0.035_252)] bg-[oklch(98%_0.01_82)] px-3 text-base font-normal normal-case tracking-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
        />
      </label>
      {suggestions.length > 0 ? (
        <div className="grid gap-2">
          <ul id={listboxId} role="listbox" aria-label="Google Places suggestions" className="border-y border-[oklch(73%_0.03_77)] bg-[oklch(98%_0.01_82)]">
            {suggestions.map((suggestion, index) => (
              <li key={suggestion.placeId} role="presentation">
                <button id={`${listboxId}-${index}`} role="option" aria-selected={index === activeIndex} type="button" disabled={disabled || loading} onClick={() => void selectSuggestion(suggestion)} className="grid min-h-11 w-full gap-1 px-3 py-2 text-left hover:bg-[oklch(92%_0.025_79)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-amber-700">
                  <strong>{suggestion.primaryText}</strong>
                  {suggestion.secondaryText ? <span className="text-sm">{suggestion.secondaryText}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          <p className="text-xs font-semibold text-[oklch(39%_0.045_252)]">Powered by Google</p>
        </div>
      ) : null}
      {value ? <p role="status" className="break-words text-sm"><strong>Verified place:</strong> {value.place.formattedAddress}</p> : null}
      {loading ? <p role="status" aria-live="polite" className="text-sm">Searching places…</p> : null}
      {status ? <p role="status" aria-live="polite" className="text-sm">{status}</p> : null}
      {error ? <p role="alert" className="text-sm text-red-800">{error}</p> : null}
    </div>
  );
}
