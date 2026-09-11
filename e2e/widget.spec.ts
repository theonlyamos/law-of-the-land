import { createServer, request as proxyRequest, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { cpus, platform } from "node:os";
import { expect, test, type Page } from "@playwright/test";
import { controlBrowserFixtures, installSessionCookie, loadBrowserFixtureManifest, type BrowserFixtureManifest } from "./admin/fixtures";

test.skip(process.env.WIDGET_E2E !== "true", "Requires the isolated widget fixture environment.");
test.use({ actionTimeout: 20000, trace: process.env.WIDGET_PERF === "1" ? "off" : "retain-on-failure", screenshot: process.env.WIDGET_PERF === "1" ? "off" : "only-on-failure" });
let fixture: BrowserFixtureManifest;
let provider: Server;
let tlsProxy: Server;
let providerCalls = 0;
const answer = "The published organization policy applies. Check the cited document for details.";
test.beforeEach(async ({ context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["local-network-access"]);
});

test.beforeAll(async () => {
  fixture = await loadBrowserFixtureManifest();
  if (!fixture.records.widget) throw new Error("Widget fixture missing");
  tlsProxy = createHttpsServer({ key: await readFile(".env.widget-key.pem"), cert: await readFile(".env.widget-cert.pem") }, (request, response) => {
    const upstream = proxyRequest({ hostname: "127.0.0.1", port: 3100, path: request.url, method: request.method, headers: request.headers }, result => {
      response.writeHead(result.statusCode ?? 502, result.headers);
      result.pipe(response);
    });
    upstream.on("error", () => response.writeHead(502).end());
    request.pipe(upstream);
  });
  await new Promise<void>(resolve => tlsProxy.listen(3110, "127.0.0.1", resolve));
  provider = createServer(async (request, response) => {
    if (request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      const stores = input.tools?.[0]?.file_search_store_names;
      if (JSON.stringify(stores) !== JSON.stringify(["fileSearchStores/e2e-public-org"])) {
        response.writeHead(400).end(); return;
      }
      providerCalls++;
      const events = [
        { event_type: "interaction.created", interaction: { id: "fixture-interaction", status: "in_progress" } },
        { event_type: "step.start", index: 0, step: { type: "model_output" } },
        { event_type: "step.delta", index: 0, delta: { type: "text", text: answer } },
        { event_type: "step.stop", index: 0 },
        { event_type: "interaction.completed", interaction: { id: "fixture-interaction", status: "completed" } },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map(event => `event: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "fixture-interaction", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: answer, annotations: [{ type: "file_citation", document_uri: "fileSearchStores/e2e-public-org", custom_metadata: { jurisdiction_id: fixture.records.publicOrganizationJurisdictionId, resource_id: fixture.records.resourceId, version_id: fixture.records.publishedVersionId } }] }] }] }));
    }
  });
  await new Promise<void>(resolve => provider.listen(3219, "127.0.0.1", resolve));
});
test.afterAll(async () => {
  for (const server of [provider, tlsProxy]) if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

async function host(page: Page, origin = "https://allowed.widget.test", directFrame = false, includeWidget = true) {
  await page.route(`${origin}/**`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><title>Organization website</title></head><body><h1>Organization website</h1>${!includeWidget ? "" : directFrame ? `<iframe src="https://127.0.0.1:3110/embed/${fixture.records.widget!.publicId}?parentOrigin=${encodeURIComponent("https://allowed.widget.test")}&instanceId=direct-frame-test"></iframe>` : `<script src="https://127.0.0.1:3110/widget.js" data-embed-id="${fixture.records.widget!.publicId}" async></script>`}</body></html>` }));
  await page.goto(origin);
}

test("manager saves settings, independent reviewer cannot edit appearance", async ({ page, context }, testInfo) => {
  await installSessionCookie(context, fixture.jurisdictionUsers.member.cookie, true);
  await page.goto(`/organizations/${fixture.records.widget!.organizationId}/website-chat`);
  await expect(page.getByRole("heading", { name: "Website chat", exact: true })).toBeVisible();
  await expect(page.getByText("Design preview only. No questions are sent.")).toBeVisible();
  await page.getByLabel("Welcome message").fill("Ask about our published policies.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Settings saved." })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Welcome message")).toHaveValue("Ask about our published policies.");
  await page.screenshot({ path: testInfo.outputPath("widget-management.png"), fullPage: true });
  await context.clearCookies();
  await installSessionCookie(context, fixture.jurisdictionUsers.formerMember.cookie, true);
  await page.reload();
  await expect(page.getByLabel("Chat title")).toBeDisabled();
});

test("manager uploads, independent reviewer publishes, manager changes visibility", async ({ page, context, request }) => {
  await installSessionCookie(context, fixture.jurisdictionUsers.member.cookie, true);
  const base = `/organizations/${fixture.records.widget!.organizationId}`;
  await page.goto(`${base}/resources`);
  await page.getByRole("button", { name: "Add document", exact: true }).click();
  for (const [label, value] of [["Document title", "Visitor policy"], ["Issuing organization", "Organization"], ["Official citation or reference", "POLICY-2026"], ["Official source URL", "https://example.org/policy"], ["Effective date", "2026-01-01"], ["Reason for adding", "Publish visitor policy"]]) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole("button", { name: "Create document", exact: true }).click();
  await page.getByRole("link", { name: "Visitor policy" }).click();
  await page.getByLabel("Original legal file").setInputFiles({ name: "policy.txt", mimeType: "text/plain", buffer: Buffer.from("Visitors can contact the organization for policy assistance.") });
  const upload = page.waitForResponse(response => response.url().endsWith("/upload") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Upload version", exact: true }).click();
  const uploaded = await upload;
  expect(uploaded.status()).toBe(200);
  await expect(page.getByText("Version recorded and ready for review.")).toBeVisible();
  const versionId = (await page.locator('section[aria-labelledby$="-original"]').getAttribute("aria-labelledby"))!.replace(/-original$/, "");
  await expect(page.getByRole("button", { name: "Approve version" })).toHaveCount(0);
  await context.clearCookies();
  await installSessionCookie(context, fixture.jurisdictionUsers.formerMember.cookie, true);
  await page.reload();
  for (const label of ["Official source authenticated", "Metadata is accurate", "Original text reviewed", "Citations verified", "Search evaluation passed"]) await page.getByLabel(label, { exact: true }).check();
  await page.getByLabel("Evaluation run ID").fill("isolated-widget-acceptance");
  await page.getByLabel("Decision reason").fill("Reviewed the original visitor policy.");
  await page.getByRole("button", { name: "Approve version" }).click();
  await page.getByRole("button", { name: "Publish version", exact: true }).click();
  await controlBrowserFixtures(fixture, "arm_provider_outcome", { versionId, publicationOperation: "publish", providerOutcome: "succeeded" });
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason for this action").fill("Publish reviewed visitor policy.");
  await dialog.getByLabel("Exact confirmation").fill(`PUBLISH ${versionId}`);
  await dialog.getByLabel("Confirm your password").fill(process.env.ADMIN_E2E_ACCOUNT_PASSWORD!);
  await dialog.getByRole("button", { name: "Queue publish" }).click();
  await expect(page.getByRole("button", { name: "Unpublish version", exact: true })).toBeVisible({ timeout: 30000 });
  await context.clearCookies();
  await installSessionCookie(context, fixture.jurisdictionUsers.member.cookie, true);
  await page.goto(`${base}/settings`);
  for (const [button, confirmation, expectedStatus] of [["Make private", "PRIVATE", 404], ["Make public", "PUBLIC", 200]] as const) {
    await page.getByRole("button", { name: button, exact: true }).click();
    await dialog.getByLabel("Reason for this action").fill("Verify jurisdiction visibility controls.");
    await dialog.getByLabel("Exact confirmation").fill(`${confirmation} ${fixture.records.publicOrganizationJurisdictionId}`);
    await dialog.getByLabel("Confirm your password").fill(process.env.ADMIN_E2E_ACCOUNT_PASSWORD!);
    await dialog.getByRole("button", { name: "Change visibility" }).click();
    await expect(dialog).not.toBeVisible();
    expect((await request.get(`/api/embed/${fixture.records.widget!.publicId}/config`, { headers: { origin: "https://allowed.widget.test" } })).status()).toBe(expectedStatus);
  }
});

test("@cross-browser lazy iframe, cited persisted answer, close/reopen, blocked storage", async ({ page, context }) => {
  await context.setExtraHTTPHeaders({ "x-vercel-forwarded-for": "127.0.0.1" });
  await context.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("Storage blocked"); } });
    Object.defineProperty(window, "sessionStorage", { get() { throw new Error("Storage blocked"); } });
  });
  let sessions = 0;
  page.on("request", request => { if (request.url().endsWith("/session") && request.method() === "POST") sessions++; });
  await host(page);
  const launcher = page.getByRole("button", { name: "Open Ask our organization" });
  await expect(launcher).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(sessions).toBe(0);
  await launcher.click();
  const frame = page.frameLocator("iframe");
  await expect(frame.getByRole("textbox")).toBeEnabled();
  expect(sessions).toBe(0);
  const before = providerCalls;
  await frame.getByRole("textbox").fill("Which policy applies?");
  await frame.getByRole("textbox").press("Enter");
  await expect(frame.getByText(answer, { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(frame.getByText("Sources (1)", { exact: true })).toBeVisible();
  expect(providerCalls).toBe(before + 1);
  expect(sessions).toBe(1);
  await frame.getByRole("textbox").press("Escape");
  await expect(launcher).toBeFocused();
  await launcher.click();
  await expect(frame.getByText(answer, { exact: true })).toBeVisible();
  expect(sessions).toBe(1);
  expect(await context.cookies()).toEqual([]);
});

test("@cross-browser denied host gets no launcher and cannot frame an allowed origin", async ({ page, request }) => {
  const deniedConfig = await request.get(`/api/embed/${fixture.records.widget!.publicId}/config`, { headers: { origin: "https://denied.widget.test" } });
  expect(deniedConfig.status()).toBe(404);
  const loader = page.waitForResponse(response => response.url().endsWith("/widget.js"));
  await host(page, "https://denied.widget.test");
  await loader;
  await page.waitForFunction(() => !(window as Window & { LotlWidget?: unknown }).LotlWidget);
  await expect(page.locator("#lotl-widget-host")).toHaveCount(0);
  const response = page.waitForResponse(response => response.url().includes("/embed/") && !response.url().includes("/api/"));
  await host(page, "https://denied.widget.test", true);
  const policy = (await response).headers()["content-security-policy"];
  expect(policy).toContain("https://allowed.widget.test");
  expect(policy).not.toContain("https://denied.widget.test");
  await expect(page.frameLocator("iframe").getByRole("textbox")).toHaveCount(0);
});

test.describe("Widget performance", () => {
 test("@performance 20 cold opens and 20 warm cycles", async ({ browser, browserName }, testInfo) => {
  test.skip(process.env.WIDGET_PERF !== "1" || browserName !== "chromium", "Opt-in final-build measurement.");
  test.setTimeout(240000);
  const cold: number[] = [], warm: number[] = [], shell: number[] = [], beforeOpenRequests: number[] = [];
  const parentMetrics: Array<{ shifts: number; longTasks: number[] }> = [];
  const controlMetrics: typeof parentMetrics = [];
  for (let index = 0; index < 20; index++) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true, permissions: ["local-network-access"] });
    try {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8 });
      await page.addInitScript(() => {
        const metrics = { shifts: 0, longTasks: [] as number[] };
        Object.assign(window, { widgetMetrics: metrics });
        new PerformanceObserver(list => { for (const entry of list.getEntries()) metrics.shifts += (entry as PerformanceEntry & { value: number }).value; }).observe({ type: "layout-shift", buffered: true });
        new PerformanceObserver(list => { for (const entry of list.getEntries()) metrics.longTasks.push(entry.duration); }).observe({ type: "longtask", buffered: true });
        const ready = new MutationObserver(() => {
          const composer = document.querySelector<HTMLTextAreaElement>("#guest-question");
          if (composer && !composer.disabled) {
            Object.assign(window, { widgetComposerReadyAt: performance.timeOrigin + performance.now() });
            ready.disconnect();
          }
        });
        ready.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
      });
      let requests = 0;
      page.on("request", request => { if (request.url().startsWith("https://127.0.0.1:3110")) requests++; });
      await host(page, "https://allowed.widget.test", false, false);
      await expect(page.getByRole("heading", { name: "Organization website" })).toBeVisible();
      controlMetrics.push(await page.evaluate(() => (window as Window & { widgetMetrics?: { shifts: number; longTasks: number[] } }).widgetMetrics!));
      await host(page);
      await expect(page.getByRole("button", { name: "Open Ask our organization" })).toBeVisible();
      beforeOpenRequests.push(requests);
      parentMetrics.push(await page.evaluate(() => (window as Window & { widgetMetrics?: { shifts: number; longTasks: number[] } }).widgetMetrics!));
      const opened = await page.evaluate(async () => {
        const start = performance.now();
        (document.querySelector("#lotl-widget-host")!.shadowRoot!.querySelector("button[aria-haspopup]") as HTMLButtonElement).click();
        await new Promise(requestAnimationFrame);
        return { at: performance.timeOrigin + start, feedback: performance.now() - start };
      });
      shell.push(opened.feedback);
      const frame = page.frameLocator("iframe");
      await expect(frame.getByRole("textbox")).toBeEnabled();
      const embedded = page.frames().find(frame => frame.url().includes("/embed/"))!;
      cold.push(await embedded.evaluate(() => (window as Window & { widgetComposerReadyAt?: number }).widgetComposerReadyAt!) - opened.at);
      await embedded.evaluate(() => document.fonts.ready);
      await frame.getByRole("button", { name: "Close chat" }).click();
      const before = requests, warmStart = performance.now();
      await page.getByRole("button", { name: "Open Ask our organization" }).click();
      await expect(frame.getByRole("textbox")).toBeVisible();
      warm.push(performance.now() - warmStart);
      expect(requests).toBe(before);
    } finally { await context.close(); }
  }
  const stats = (samples: number[]) => { const sorted = [...samples].sort((a, b) => a - b); return { median: (sorted[9] + sorted[10]) / 2, p95: sorted[18] }; };
  const evidence = { commit: process.env.ADMIN_E2E_LOCAL_HEAD_SHA, buildId: (await readFile(".next/BUILD_ID", "utf8")).trim(), browser: browser.version(), machine: `${platform()} ${cpus()[0]?.model}`, conditions: { viewport: "390x844", cpuSlowdown: 4, latencyMs: 150, downloadMbps: 1.6 }, gzipBytes: { loader: gzipSync(await readFile("public/widget.js")).length, css: gzipSync(await readFile("public/widget.css")).length }, raw: { cold, warm, shell, beforeOpenRequests, parentMetrics, controlMetrics }, summaries: { cold: stats(cold), warm: stats(warm), shell: stats(shell) } };
  await writeFile(testInfo.outputPath("widget-performance.json"), JSON.stringify(evidence, null, 2));
  await testInfo.attach("widget-performance", { body: JSON.stringify(evidence), contentType: "application/json" });
  expect(Math.max(...beforeOpenRequests)).toBeLessThanOrEqual(3);
  // Raw long tasks include browser automation; compare with the host-only control instead of attributing every task to the loader.
  expect(parentMetrics.every(sample => sample.shifts === 0)).toBe(true);
  expect(stats(shell).p95).toBeLessThanOrEqual(100);
  expect(stats(cold).p95).toBeLessThanOrEqual(2500);
});

});
