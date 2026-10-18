import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let stylesheet: HTMLStyleElement;
let surface: HTMLDivElement;

beforeEach(() => {
  stylesheet = document.createElement("style");
  stylesheet.textContent = readFileSync("src/components/chat/citation-pdf-page.css", "utf8");
  document.head.append(stylesheet);
  surface = document.createElement("div");
  surface.className = "citation-pdf-surface";
  document.body.append(surface);
});

afterEach(() => { stylesheet?.remove(); surface?.remove(); });

describe("PDF.js text-layer geometry styles", () => {
  it.each([
    ["90", "rotate(90deg) translateY(-100%)"],
    ["180", "rotate(180deg) translate(-100%, -100%)"],
    ["270", "rotate(270deg) translateX(-100%)"],
  ])("rotates the original text layer with a %s-degree PDF page", (rotation, expected) => {
    const layer = document.createElement("div");
    layer.className = "citation-pdf-text-layer";
    layer.dataset.mainRotation = rotation;
    surface.append(layer);
    expect(getComputedStyle(layer).transform).toBe(expected);
  });

  it("provides the rounding units required for PDF.js 6 layer dimensions", () => {
    const computed = getComputedStyle(surface);
    expect(computed.getPropertyValue("--scale-round-x")).toBe("1px");
    expect(computed.getPropertyValue("--scale-round-y")).toBe("1px");
  });
});
