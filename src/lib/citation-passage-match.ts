export type CitationTextItem = { str: string; hasEOL?: boolean };
export type CitationTextRange = { itemIndex: number; start: number; end: number };
export type CitationPassageMatch = {
  status: "matched" | "no-match" | "ambiguous" | "no-text";
  ranges: CitationTextRange[];
};

const LIGATURES: Record<string, string> = {
  "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st",
};

type SourceOffset = { start: number; end: number };

/** Only typography is normalized. Case, punctuation, hyphens and wording remain exact. */
function normalizeWithOffsets(source: string) {
  let text = "";
  const offsets: SourceOffset[] = [];
  let position = 0;
  for (const character of source) {
    const start = position;
    position += character.length;
    if (/\s/u.test(character)) {
      if (text.endsWith(" ")) {
        offsets[offsets.length - 1].end = position;
      } else {
        text += " ";
        offsets.push({ start, end: position });
      }
      continue;
    }
    const normalized = LIGATURES[character] ?? character;
    text += normalized;
    for (let index = 0; index < normalized.length; index++) {
      offsets.push({ start, end: position });
    }
  }
  return { text, offsets };
}

const wordCharacter = /[\p{L}\p{N}\p{M}_]/u;

/**
 * Finds exactly one complete quoted passage in a page's original text runs.
 * Never accepts question keywords, approximate language, or an ambiguous location.
 * Ranges use UTF-16 offsets, matching DOM text nodes and PDF.js TextLayer strings.
 */
export function matchCitationPassage(
  items: readonly CitationTextItem[],
  quote: string,
): CitationPassageMatch {
  let source = "";
  const itemStarts: number[] = [];
  for (const item of items) {
    itemStarts.push(source.length);
    source += item.str;
    if (item.hasEOL) source += "\n";
  }
  const { text, offsets } = normalizeWithOffsets(source);
  if (!text.trim()) return { status: "no-text", ranges: [] };
  const needle = normalizeWithOffsets(quote).text.trim();
  if (!needle) return { status: "no-match", ranges: [] };

  let found = -1;
  let cursor = 0;
  while (cursor <= text.length - needle.length) {
    const start = text.indexOf(needle, cursor);
    if (start < 0) break;
    const end = start + needle.length;
    cursor = start + 1; // Include overlapping matches when detecting ambiguity.
    // Never highlight only part of an expanded ligature or Unicode code point.
    if (offsets[start - 1]?.start === offsets[start].start
      || offsets[end]?.end === offsets[end - 1].end) continue;
    const before = text.slice(0, start).match(/.$/u)?.[0] ?? "";
    const after = text.slice(end).match(/^./u)?.[0] ?? "";
    const first = needle.match(/^./u)?.[0] ?? "";
    const last = needle.match(/.$/u)?.[0] ?? "";
    if ((wordCharacter.test(first) && wordCharacter.test(before))
      || (wordCharacter.test(last) && wordCharacter.test(after))) continue;
    if (found >= 0) return { status: "ambiguous", ranges: [] };
    found = start;
  }
  if (found < 0) return { status: "no-match", ranges: [] };

  const sourceStart = offsets[found].start;
  const sourceEnd = offsets[found + needle.length - 1].end;
  const ranges: CitationTextRange[] = [];
  items.forEach((item, itemIndex) => {
    const start = Math.max(0, sourceStart - itemStarts[itemIndex]);
    const end = Math.min(item.str.length, sourceEnd - itemStarts[itemIndex]);
    if (start < end) ranges.push({ itemIndex, start, end });
  });
  return { status: "matched", ranges };
}
