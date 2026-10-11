import { cpSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const assetDirectories = ["cmaps", "standard_fonts", "wasm", "iccs"];
const requiredFiles = [
  "cmaps/Adobe-Japan1-UCS2.bcmap",
  "standard_fonts/LiberationSans-Regular.ttf",
  "wasm/openjpeg.wasm", "wasm/qcms_bg.wasm", "wasm/jbig2.wasm",
  "wasm/openjpeg_nowasm_fallback.js", "wasm/jbig2_nowasm_fallback.js",
  "iccs/CGATS001Compat-v2-micro.icc",
];

/** Copy the installed PDF.js version's complete public assets, including licenses.
 * @param {{projectRoot?: string, packageRoot?: string}} [options]
 */
export function prepareCitationPdfAssets({
  projectRoot = resolve(dirname(scriptPath), ".."),
  packageRoot = dirname(require.resolve("pdfjs-dist/package.json")),
} = {}) {
  const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error("Invalid PDF.js package version for public asset path.");
  }
  // A broken installation must fail the build before replacing existing assets.
  for (const directory of assetDirectories) {
    if (!statSync(join(packageRoot, directory)).isDirectory()) {
      throw new Error(`Missing PDF.js asset directory: ${directory}`);
    }
  }
  for (const file of requiredFiles) {
    const stat = statSync(join(packageRoot, file));
    if (!stat.isFile() || stat.size === 0) throw new Error(`Missing PDF.js asset: ${file}`);
  }
  const assetRoot = join(projectRoot, "public", "pdfjs", version);
  rmSync(assetRoot, { recursive: true, force: true });
  mkdirSync(assetRoot, { recursive: true });
  for (const directory of assetDirectories) {
    cpSync(join(packageRoot, directory), join(assetRoot, directory), { recursive: true });
  }
  return { version, assetRoot };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const { version, assetRoot } = prepareCitationPdfAssets();
  console.log(`Prepared PDF.js ${version} local assets at ${assetRoot}`);
}
