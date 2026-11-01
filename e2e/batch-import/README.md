# Batch import browser fixture

Runs the actual `BatchImport` component against an in-browser Convex stub and generated PDF bytes. It never calls a deployment, account, storage service, review mutation or publication mutation.

```powershell
node node_modules/@playwright/test/cli.js test --config e2e/batch-import/playwright.config.ts
```

The fixture exercises repeated clicks, interrupted uploads, stop/resume, loss of a commit response, navigation and reload recovery, live publication/indexing status, and a 390-pixel layout. It also verifies that a delayed commit result cannot restore a cleared batch after client navigation. The durable test ledger simulates a server receipt across browser navigation. Backend authorization, atomicity and checksums are verified separately by Convex tests.

`?review=1` renders the actual `DocumentReview` with local permission context and mutation recording. Source-review scenarios cover explicit classification and assertions for official originals and independently corroborated reproductions, blocked incomplete evidence, append-only verified corrections, and unresolved corrections withdrawing approval for fresh review. The fixture never calls approval, correction, or publication functions on a deployment.

Run only source-review browser scenarios:

```powershell
node node_modules/@playwright/test/cli.js test --config e2e/batch-import/playwright.config.ts source-review.browser.ts --output test-results/source-review-browser
```
