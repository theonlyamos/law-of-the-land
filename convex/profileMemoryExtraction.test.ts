import { describe, expect, it } from "vitest";
import { interactionText, parseProfileExtraction } from "./lib/profileMemoryExtraction";

const question = "I'm a landlord in Kumasi. Please keep it short: can I raise rent mid-tenancy?";

describe("profile memory extraction parsing", () => {
  it("keeps catalogue facts about the person that quote the question", () => {
    const text = JSON.stringify({ observations: [
      { type: "role", value: "landlord", kind: "stated", about_self: true, quote: "I’m a landlord" },
      { type: "answer_preference", value: "brief", kind: "stated", about_self: true, quote: "keep it short" },
      { type: "topic", value: "tenancy", kind: "implied", about_self: true, quote: "raise rent mid-tenancy" },
    ] });
    expect(parseProfileExtraction(text, question)).toEqual([
      { type: "role", value: "landlord", kind: "stated", quote: "I’m a landlord" },
      { type: "answer_preference", value: "brief", kind: "stated", quote: "keep it short" },
      { type: "topic", value: "tenancy", kind: "implied", quote: "raise rent mid-tenancy" },
    ]);
  });

  it("drops paraphrased quotes, other people, unknown values and stated topics", () => {
    const text = JSON.stringify({ observations: [
      { type: "role", value: "landlord", kind: "stated", about_self: true, quote: "I own rental property" },
      { type: "role", value: "tenant", kind: "implied", about_self: false, quote: "raise rent" },
      { type: "role", value: "landlord", kind: "stated", about_self: true, quote: "Kumasi", extra: 1 },
      { type: "sector", value: "landlord", kind: "stated", about_self: true, quote: "landlord" },
      { type: "topic", value: "tenancy", kind: "stated", about_self: true, quote: "rent" },
    ] });
    expect(parseProfileExtraction(text, question)).toEqual([
      { type: "role", value: "landlord", kind: "stated", quote: "Kumasi" },
    ]);
    expect(parseProfileExtraction("not json", question)).toEqual([]);
    expect(parseProfileExtraction("{\"observations\":{}}", question)).toEqual([]);
  });

  it("reads only one completed text output", () => {
    const step = { type: "model_output", content: [{ type: "text", text: "{}" }] };
    expect(interactionText({ status: "completed", steps: [{ type: "thought" }, step] })).toBe("{}");
    expect(interactionText({ status: "in_progress", steps: [step] })).toBeNull();
    expect(interactionText({ status: "completed", steps: [step, step] })).toBeNull();
    expect(interactionText({ status: "completed", steps: [{ type: "file_search_call" }] })).toBeNull();
  });
});
