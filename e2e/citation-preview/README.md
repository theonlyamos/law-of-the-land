# Isolated citation preview browser QA

Run from the repository root:

```sh
node node_modules/@playwright/test/cli.js test --config e2e/citation-preview/playwright.config.ts
```

This harness uses the production preview components and production Tailwind styles in a development-only Vite entrypoint. Playwright generates PDFs with `pdf-lib` and fulfills only the same-origin authenticated source route. All other API routes are rejected by the assertion and all external network requests are aborted. It does not start Next.js, Convex, an AI provider, or access live user data. None of its fixture routes are part of the production application.

The harness prepares the same pinned local PDF.js auxiliary assets as the app and serves them from the repository public directory.

Chromium uses `PLAYWRIGHT_CHROMIUM_EXECUTABLE` when provided, `/usr/bin/chromium` when present, or the normal Playwright browser installation. Screenshots and traces are written under the ignored `test-results/citation-preview` directory.

The spec uses the `.browser.ts` suffix so the repository's default, backend-connected Playwright configuration does not discover it. Use the dedicated configuration above. `--list` checks discovery without launching a browser.

Coverage includes original PDF canvas content, exact text-layer marks with surrounding context, page-only/missing/mismatched/ambiguous/image-only cases, source authorization failure, page and passage navigation, zoom, page-number entry, focus containment and restoration, repeated open/close, narrow mobile layout, and rotated pages. Desktop/mobile/rotated screenshots are saved during a successful run for visual inspection.
