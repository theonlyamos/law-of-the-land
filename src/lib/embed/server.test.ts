import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { applicationOrigin, assertGuestRequest } from "./server";

afterEach(() => vi.unstubAllEnvs());
it("checks the configured public origin behind a proxy and rejects foreign origins", () => {
  vi.stubEnv("SITE_URL", "https://chat.example.org");
  vi.stubEnv("WIDGET_CHAT_ENABLED", "true");
  const request = new Request("http://localhost:3000/api/embed/widget/session", { headers: { origin: "https://chat.example.org", "sec-fetch-site": "same-origin" } });
  expect(applicationOrigin(request)).toBe("https://chat.example.org");
  expect(() => assertGuestRequest(request)).not.toThrow();
  expect(() => assertGuestRequest(new Request(request, { headers: { origin: "https://attacker.example", "x-forwarded-host": "attacker.example" } }))).toThrow("INVALID_REQUEST");
});
