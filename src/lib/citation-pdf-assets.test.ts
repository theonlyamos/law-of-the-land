// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCitationPdfAssets } from "../../scripts/prepare-citation-pdf-assets.mjs";

let root: string;
let packageRoot: string;
const fixtureFiles = [
  "cmaps/Adobe-Japan1-UCS2.bcmap", "cmaps/LICENSE",
  "standard_fonts/LiberationSans-Regular.ttf", "standard_fonts/LICENSE_FOXIT",
  "wasm/openjpeg.wasm", "wasm/qcms_bg.wasm", "wasm/jbig2.wasm",
  "wasm/openjpeg_nowasm_fallback.js", "wasm/jbig2_nowasm_fallback.js", "wasm/LICENSE_OPENJPEG",
  "iccs/CGATS001Compat-v2-micro.icc", "iccs/LICENSE",
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "citation-pdf-assets-"));
  packageRoot = join(root, "package");
  for (const file of fixtureFiles) {
    const path = join(packageRoot, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `original bytes: ${file}`);
  }
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version: "6.4.299" }));
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("prepareCitationPdfAssets", () => {
  it("copies fonts, CMaps, image decoders, color profiles, and licenses into the installed version path", () => {
    const result = prepareCitationPdfAssets({ projectRoot: root, packageRoot });
    expect(result.version).toBe("6.4.299");
    expect(result.assetRoot).toBe(join(root, "public/pdfjs/6.4.299"));
    for (const file of fixtureFiles) {
      expect(readFileSync(join(result.assetRoot, file))).toEqual(readFileSync(join(packageRoot, file)));
    }
  });

  it("replaces stale generated assets on repeated builds while keeping other version paths", () => {
    const assetRoot = join(root, "public/pdfjs/6.4.299");
    const olderRoot = join(root, "public/pdfjs/5.0.0");
    mkdirSync(assetRoot, { recursive: true });
    mkdirSync(olderRoot, { recursive: true });
    writeFileSync(join(assetRoot, "stale.txt"), "stale");
    writeFileSync(join(olderRoot, "old.txt"), "old");
    prepareCitationPdfAssets({ projectRoot: root, packageRoot });
    expect(() => readFileSync(join(assetRoot, "stale.txt"))).toThrow();
    expect(readFileSync(join(olderRoot, "old.txt"), "utf8")).toBe("old");
    prepareCitationPdfAssets({ projectRoot: root, packageRoot });
    expect(readFileSync(join(assetRoot, "wasm/openjpeg.wasm"), "utf8")).toBe("original bytes: wasm/openjpeg.wasm");
  });

  it("fails before replacing assets when an installed decoder is missing", () => {
    const assetRoot = join(root, "public/pdfjs/6.4.299");
    mkdirSync(assetRoot, { recursive: true });
    writeFileSync(join(assetRoot, "previous.txt"), "previous");
    rmSync(join(packageRoot, "wasm/openjpeg.wasm"));
    expect(() => prepareCitationPdfAssets({ projectRoot: root, packageRoot })).toThrow(/openjpeg/);
    expect(readFileSync(join(assetRoot, "previous.txt"), "utf8")).toBe("previous");
  });

  it("rejects unsafe package versions before choosing any output path", () => {
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version: "../../outside" }));
    expect(() => prepareCitationPdfAssets({ projectRoot: root, packageRoot })).toThrow(/version/i);
  });
});
