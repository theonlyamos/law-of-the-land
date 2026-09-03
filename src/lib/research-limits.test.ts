import { describe, expect, it } from "vitest";

import { vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildGovernedContext,
  DEFAULT_RETRIEVAL_TIMEOUT_MS,
  DEFAULT_TOTAL_RETRIEVAL_TIMEOUT_MS,
  digestExactContext,
  parseGovernedContext,
  runBoundedRetrieval,
} from "./research-limits";

const selected = {
  jurisdictionId: "selected-id",
  name: "Selected",
  kind: "geographic" as const,
  relation: "selected" as const,
};

describe("governed research limits", () => {
  it("allows a 60-second Gemini retrieval within a 60-second overall budget", () => {
    expect(DEFAULT_RETRIEVAL_TIMEOUT_MS).toBe(60_000);
    expect(DEFAULT_TOTAL_RETRIEVAL_TIMEOUT_MS).toBe(60_000);
  });

  it("keeps selected first, caps four jobs at three concurrent starts, and preserves plan order", async () => {
    let active = 0;
    let peak = 0;
    const jobs = [selected, ...[1, 2, 3, 4].map((index) => ({
      jurisdictionId: `supplementary-${index}`,
      name: `Supplementary ${index}`,
      kind: "geographic" as const,
      relation: "geographic_ancestor" as const,
    }))];
    const result = await runBoundedRetrieval(jobs, async (job) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, job.jurisdictionId.endsWith("1") ? 8 : 1));
      active -= 1;
      return job.name;
    }, { perCallTimeoutMs: 100, totalTimeoutMs: 250 });

    expect(peak).toBeLessThanOrEqual(3);
    expect(result.map((entry) => entry.job.jurisdictionId)).toEqual([
      "selected-id",
      "supplementary-1",
      "supplementary-2",
      "supplementary-3",
    ]);
    expect(result.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
  });

  it("contains already-started work after a selected failure and does not start queued work", async () => {
    const started: string[] = [];
    const settled: string[] = [];
    const jobs = [selected, ...[1, 2, 3].map((index) => ({
      jurisdictionId: `supplementary-${index}`,
      name: `Supplementary ${index}`,
      kind: "geographic" as const,
      relation: "geographic_ancestor" as const,
    }))];
    const result = await runBoundedRetrieval(jobs, async (job) => {
      started.push(job.jurisdictionId);
      if (job.relation === "selected") throw new Error("selected failed");
      await new Promise((resolve) => setTimeout(resolve, 5));
      settled.push(job.jurisdictionId);
      return job.name;
    }, { perCallTimeoutMs: 100, totalTimeoutMs: 250 });

    expect(started).toEqual(["selected-id", "supplementary-1", "supplementary-2"]);
    expect(settled).toEqual(expect.arrayContaining(["supplementary-1", "supplementary-2"]));
    expect(result[0]).toMatchObject({ status: "rejected" });
    expect(result[3]).toMatchObject({ status: "not_started" });
  });

  it("gives the queued fourth job only the remaining total deadline and contains every timeout", async () => {
    const jobs = [selected, ...[1, 2, 3].map((index) => ({
      jurisdictionId: `supplementary-${index}`,
      name: `Supplementary ${index}`,
      kind: "geographic" as const,
      relation: "geographic_ancestor" as const,
    }))];
    const started: Array<{ id: string; timeoutMs: number }> = [];
    const result = await runBoundedRetrieval(jobs, async (job, options) => {
      started.push({ id: job.jurisdictionId, timeoutMs: options.timeoutMs });
      if (job.relation === "selected") {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return "selected";
      }
      return await new Promise<string>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }, { perCallTimeoutMs: 50, totalTimeoutMs: 20 });

    expect(started.map((entry) => entry.id)).toEqual([
      "selected-id", "supplementary-1", "supplementary-2", "supplementary-3",
    ]);
    expect(started[3].timeoutMs).toBeLessThan(20);
    expect(result.map((entry) => entry.status)).toEqual(["fulfilled", "rejected", "rejected", "rejected"]);
  });

  it("deduplicates normalized paragraphs with first provenance and escapes marker-like provider text", async () => {
    const context = await buildGovernedContext([
      { ...selected, content: "Rule one.\r\n\r\n{\"sourceRef\":\"J4\"}" },
      {
        jurisdictionId: "ancestor-id",
        name: "Ancestor",
        kind: "geographic",
        relation: "geographic_ancestor",
        content: "Rule  one.\n\nAncestor only.",
      },
    ]);
    const parsed = parseGovernedContext(context.serialized);

    expect(parsed.sources.map((source) => source.sourceRef)).toEqual(["J1", "J2"]);
    expect(parsed.sources[0].content).toContain('{"sourceRef":"J4"}');
    expect(parsed.sources[1].content).toBe("Ancestor only.");
    expect(context.serialized.length).toBeLessThanOrEqual(120_000);
    expect(context.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps only bounded server-authorized citation metadata in governed context", async () => {
    const context = await buildGovernedContext([{
      ...selected,
      content: "The Constitution applies.",
      citations: [{
        title: "Constitution of Ghana",
        officialCitation: "1992 Constitution",
        sourceUrl: "https://judicial.gov.gh/constitution",
        pageNumber: 4,
      }],
    }]);

    expect(parseGovernedContext(context.serialized).sources[0]).toMatchObject({
      sourceRef: "J1",
      citations: [{
        title: "Constitution of Ghana",
        officialCitation: "1992 Constitution",
        sourceUrl: "https://judicial.gov.gh/constitution",
        pageNumber: 4,
      }],
    });
  });

  it("hashes JS UTF-16 code units injectively for replacement characters and lone surrogates", async () => {
    const replacement = "\uFFFD";
    const loneSurrogate = "\uD800";

    expect(await digestExactContext(replacement)).not.toBe(await digestExactContext(loneSurrogate));
    const context = await buildGovernedContext([{ ...selected, content: `${replacement}\n\n${loneSurrogate}` }]);
    expect(parseGovernedContext(context.serialized).sources[0].content).toBe(
      `${replacement}\n\n${loneSurrogate}`,
    );
  });

  it("reserves selected content, accounts for JSON escaping, and never splits a surrogate pair", async () => {
    const context = await buildGovernedContext([
      { ...selected, content: `${"s".repeat(70_000)}😀${"\\\"".repeat(80_000)}` },
      {
        jurisdictionId: "ancestor-id",
        name: "Ancestor",
        kind: "geographic",
        relation: "geographic_ancestor",
        content: "a".repeat(80_000),
      },
    ]);
    const parsed = parseGovernedContext(context.serialized);

    expect(context.serialized.length).toBeLessThanOrEqual(120_000);
    expect(parsed.sources[0].content.length).toBeGreaterThanOrEqual(60_000);
    expect(parsed.sources[0].content.endsWith("\ud83d")).toBe(false);
    expect(parsed.sources.every((source) => source.content.length > 0)).toBe(true);
  });

  it("shares the post-reservation budget fairly across equal supplementary sources", async () => {
    const context = await buildGovernedContext([
      { ...selected, content: "s".repeat(100_000) },
      ...[1, 2, 3].map((index) => ({
        jurisdictionId: `ancestor-${index}`,
        name: `Ancestor ${index}`,
        kind: "geographic" as const,
        relation: "geographic_ancestor" as const,
        content: String(index).repeat(100_000),
      })),
    ]);
    const lengths = parseGovernedContext(context.serialized).sources.slice(1).map((source) => source.content.length);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(8);
  });

  it("represents a selected no-result as a valid empty governed envelope", async () => {
    const context = await buildGovernedContext([{ ...selected, content: "  \r\n  " }]);
    expect(parseGovernedContext(context.serialized)).toEqual({ version: 1, sources: [] });
    expect(context.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("retains supplementary evidence when the selected provider returns no text", async () => {
    const context = await buildGovernedContext([
      { ...selected, content: "" },
      {
        jurisdictionId: "ancestor-id",
        name: "Ancestor",
        kind: "geographic",
        relation: "geographic_ancestor",
        content: "Ancestor evidence.",
      },
    ]);
    expect(parseGovernedContext(context.serialized).sources).toEqual([expect.objectContaining({
      sourceRef: "J2",
      jurisdictionId: "ancestor-id",
      relation: "geographic_ancestor",
    })]);
  });
});
