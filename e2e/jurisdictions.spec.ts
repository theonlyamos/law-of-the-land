import { expect, test, type Page } from "@playwright/test";
import {
  E2E_JURISDICTION_QUESTIONS,
  decodeRetrievalObservationV1,
  type E2EProviderScenario,
} from "../shared/e2e-jurisdiction-provider-contract";
import {
  controlBrowserFixtures,
  installSessionCookie,
  loadBrowserFixtureManifest,
  type BrowserFixtureManifest,
} from "./admin/fixtures";

const SEARCH_PATH = "/api/search";

async function chooseJurisdiction(
  page: Page,
  kind: "Geographic" | "Organizational",
  name: string,
) {
  await page.getByRole("radio", { name: kind }).click();
  const search = page.getByRole("combobox", { name: "Find jurisdiction" });
  await search.fill(name);
  const options = page
    .getByRole("listbox", { name: "Jurisdiction results" })
    .getByRole("option");
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactFixtureOption = options.filter({
    has: page.locator("span", { hasText: new RegExp(`^${escapedName}$`) }),
  });
  await expect(exactFixtureOption).toHaveCount(1);
  await expect(exactFixtureOption).toHaveAccessibleName(
    new RegExp(`^${escapedName}, ${kind}, `),
  );
  const optionCount = await options.count();
  expect(optionCount).toBeGreaterThan(0);
  expect(optionCount).toBeLessThanOrEqual(20);
  await exactFixtureOption.click();
  await expect(exactFixtureOption).toHaveAttribute("aria-selected", "true");
}

async function parentObservedSearch(
  fixture: BrowserFixtureManifest,
  input: { cookie: string; scenario: E2EProviderScenario; jurisdictionId: string },
) {
  const observationSecret = process.env.ADMIN_E2E_PROVIDER_OBSERVATION_SECRET;
  if (!observationSecret) throw new Error("Parent-only retrieval observation secret is unavailable.");
  const response = await fetch("http://127.0.0.1:3000/api/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: input.cookie,
      "x-admin-e2e-provider-observation": observationSecret,
    },
    body: JSON.stringify({
      query: E2E_JURISDICTION_QUESTIONS[input.scenario],
      jurisdictionId: input.jurisdictionId,
    }),
  });
  const encoded = response.headers.get("x-admin-e2e-retrieval-plan-v1");
  if (!encoded) throw new Error("Authorized retrieval response omitted its bounded observation.");
  const body = await response.json() as Record<string, unknown>;
  return { response, body, observation: decodeRetrievalObservationV1(encoded) };
}

test.describe.serial("unified jurisdiction rollout evidence", () => {
  test("keeps the legacy Ghana single-library journey usable with the flag off", async ({ context, page }) => {
    const fixture = await loadBrowserFixtureManifest();
    await controlBrowserFixtures(fixture, "set_unified_jurisdictions_flag", { enabled: false });

    await context.clearCookies();
    await page.goto("/");
    await expect(page.getByRole("combobox", { name: "Research jurisdiction" })).toHaveValue("GH");
    await expect(page.getByRole("radiogroup", { name: "Jurisdiction type" })).toHaveCount(0);

    await installSessionCookie(context, fixture.jurisdictionUsers.member.cookie);
    await page.goto("/");
    await page.getByLabel("Your legal question").fill(E2E_JURISDICTION_QUESTIONS.complete);
    const chatResponsePromise = page.waitForResponse(
      (response) => response.url().endsWith("/api/chat") && response.request().method() === "POST",
      { timeout: 30_000 },
    );
    await page.getByRole("button", { name: /Research this question/ }).click();
    const chatResponse = await chatResponsePromise;
    expect(chatResponse.status()).toBe(200);
    await expect(chatResponse.json()).resolves.toMatchObject({
      result: expect.stringMatching(/Isolated Accra complete legal answer/i),
    });
    await expect(page.getByText(/Isolated Accra complete legal answer/i)).toBeVisible();
  });

  test("discovers bounded public type-first results without invoking Places for organizations", async ({ context, page }) => {
    const fixture = await loadBrowserFixtureManifest();
    await controlBrowserFixtures(fixture, "set_unified_jurisdictions_flag", { enabled: true });
    await context.clearCookies();
    const placesRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/admin/geographic-places/")) placesRequests.push(request.url());
    });
    await page.goto("/");

    await chooseJurisdiction(page, "Geographic", `${fixture.tag} Ghana`);
    await chooseJurisdiction(page, "Organizational", `${fixture.tag} Public Organization`);
    expect(placesRequests).toEqual([]);
  });

  test("gives only the active member access and preserves parent-aware provenance", async ({ context, page }) => {
    const fixture = await loadBrowserFixtureManifest();
    const memberName = `${fixture.tag} Member Organization`;

    await installSessionCookie(context, fixture.jurisdictionUsers.member.cookie);
    await page.goto("/");
    await chooseJurisdiction(page, "Organizational", memberName);
    await page.getByLabel("Your legal question").fill(E2E_JURISDICTION_QUESTIONS.complete);
    const searchRequest = page.waitForRequest((request) => request.url().endsWith(SEARCH_PATH));
    await page.getByRole("button", { name: /Research this question/ }).click();
    expect((await searchRequest).postDataJSON()).toMatchObject({
      jurisdictionId: fixture.records.jurisdictionMemberOnlyId,
    });
    await expect(page.getByText(/Isolated Accra complete legal answer/i)).toBeVisible();
    const sources = page.getByRole("region", { name: "Sources" });
    await expect(sources).toContainText(`${fixture.tag} Member Organization`);
    await expect(sources).toContainText("selected");
    await expect(page.getByText(/Partial coverage:/)).toHaveCount(0);

    const observed = await parentObservedSearch(fixture, {
      cookie: fixture.jurisdictionUsers.member.cookie,
      scenario: "complete",
      jurisdictionId: fixture.records.jurisdictionMemberOnlyId,
    });
    expect(observed.response.status).toBe(200);
    expect(observed.body.jurisdictionId).toBe(fixture.records.jurisdictionMemberOnlyId);
    expect(observed.observation).toMatchObject({
      authorizedScopeSize: 3,
      planSize: 3,
      coverageState: "complete",
      libraries: [
        { ordinal: 0, relation: "selected", status: "fulfilled" },
        { ordinal: 1, relation: "organizational_geography", status: "fulfilled" },
        { ordinal: 2, relation: "geographic_ancestor", status: "fulfilled" },
      ],
      unexpectedRealProviderCallCount: 0,
    });

    for (const identity of [fixture.jurisdictionUsers.formerMember.cookie, null]) {
      if (identity) await installSessionCookie(context, identity);
      else await context.clearCookies();
      await page.goto("/");
      await page.getByRole("radio", { name: "Organizational" }).click();
      await page.getByRole("combobox", { name: "Find jurisdiction" }).fill(`${fixture.tag} Member Organization`);
      await expect(page.getByRole("option", { name: new RegExp(`${memberName}, Organizational`) })).toHaveCount(0);
    }
  });

  test("reports deterministic supplementary and selected failures without disclosure", async () => {
    const fixture = await loadBrowserFixtureManifest();
    const partial = await parentObservedSearch(fixture, {
      cookie: fixture.jurisdictionUsers.member.cookie,
      scenario: "supplementary_failure",
      jurisdictionId: fixture.records.jurisdictionMemberOnlyId,
    });
    expect(partial.response.status).toBe(200);
    expect(partial.observation.coverageState).toBe("supplementary_incomplete");
    expect(partial.body).toMatchObject({
      jurisdictionId: fixture.records.jurisdictionMemberOnlyId,
      partialCoverage: expect.any(Array),
    });
    expect(partial.observation.libraries).toEqual([
      expect.objectContaining({ ordinal: 0, relation: "selected", status: "fulfilled" }),
      expect.objectContaining({ ordinal: 1, relation: "organizational_geography", status: "rejected" }),
      expect.objectContaining({ ordinal: 2, relation: "geographic_ancestor", status: "fulfilled" }),
    ]);
    const partialContext = JSON.parse(String(partial.body.result)) as {
      sources: Array<{ jurisdictionId: string; relation: string }>;
    };
    expect(partialContext.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ jurisdictionId: fixture.records.jurisdictionMemberOnlyId, relation: "selected" }),
      expect.objectContaining({ jurisdictionId: fixture.records.jurisdictionCountryId, relation: "geographic_ancestor" }),
    ]));
    expect(partial.body.partialCoverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ jurisdictionId: fixture.records.jurisdictionTownId, relation: "organizational_geography" }),
    ]));

    const selected = await parentObservedSearch(fixture, {
      cookie: fixture.jurisdictionUsers.member.cookie,
      scenario: "selected_failure",
      jurisdictionId: fixture.records.jurisdictionMemberOnlyId,
    });
    expect(selected.response.status).toBe(500);
    expect(selected.observation.coverageState).toBe("selected_unavailable");
    expect(selected.body).toEqual({ error: "We couldn't search the legal library. Please try again." });
    expect(JSON.stringify(selected.body)).not.toMatch(/bucket|membership|provider|organization/i);
  });

  test("revokes selected member access on a fresh server check", async ({ context, page }) => {
    const fixture = await loadBrowserFixtureManifest();
    await installSessionCookie(context, fixture.jurisdictionUsers.member.cookie);
    await page.goto("/");
    await chooseJurisdiction(page, "Organizational", `${fixture.tag} Member Organization`);
    const staleSearch = await parentObservedSearch(fixture, {
      cookie: fixture.jurisdictionUsers.member.cookie,
      scenario: "complete",
      jurisdictionId: fixture.records.jurisdictionMemberOnlyId,
    });
    expect(staleSearch.response.status).toBe(200);
    await controlBrowserFixtures(fixture, "deactivate_jurisdiction_member", {
      membershipId: fixture.records.jurisdictionMemberId,
    });

    const denied = await fetch("http://127.0.0.1:3000/api/search", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: fixture.jurisdictionUsers.member.cookie },
      body: JSON.stringify({
        query: E2E_JURISDICTION_QUESTIONS.complete,
        jurisdictionId: fixture.records.jurisdictionMemberOnlyId,
      }),
    });
    expect(denied.ok).toBe(false);
    expect(await denied.text()).not.toMatch(/bucket|membership|provider/i);

    const staleBody = staleSearch.body;
    expect(staleBody).toMatchObject({
      result: expect.any(String),
      correlationToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    const staleChat = await fetch("http://127.0.0.1:3000/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: fixture.jurisdictionUsers.member.cookie },
      body: JSON.stringify({
        query: E2E_JURISDICTION_QUESTIONS.complete,
        messages: [],
        context: staleBody.result,
        correlationToken: staleBody.correlationToken,
        jurisdictionId: fixture.records.jurisdictionMemberOnlyId,
        externalId: `${fixture.tag}-revocation`,
        assistantClientId: crypto.randomUUID(),
      }),
    });
    expect(staleChat.ok).toBe(false);
    expect(await staleChat.text()).not.toMatch(/bucket|membership|provider|organization/i);

    await page.reload();
    await page.getByRole("radio", { name: "Organizational" }).click();
    await page.getByRole("combobox", { name: "Find jurisdiction" }).fill(`${fixture.tag} Member Organization`);
    await expect(page.getByRole("option", { name: new RegExp(`${fixture.tag} Member Organization`) })).toHaveCount(0);
  });

  test("restores flag-off Ghana behavior before global teardown", async ({ context, page }) => {
    const fixture = await loadBrowserFixtureManifest();
    await controlBrowserFixtures(fixture, "set_unified_jurisdictions_flag", { enabled: false });
    await context.clearCookies();
    await page.goto("/");
    await expect(page.getByRole("combobox", { name: "Research jurisdiction" })).toHaveValue("GH");
  });
});
