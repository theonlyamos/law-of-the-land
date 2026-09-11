import { describe, expect, it } from "vitest";
import { normalizeWidgetOrigin, parseWidgetChatBody, normalizeWidgetSettings } from "./widgetContracts";

describe("widget boundaries", () => {
  it("accepts exact secure origins, not paths, credentials or wildcard hosts", () => {
    expect(normalizeWidgetOrigin("https://EXAMPLE.org:443/", "production")).toBe("https://example.org");
    for (const value of ["http://example.org", "https://u:p@example.org", "https://example.org/help", "https://*.example.org", "null", "https://example.org/#", "https://example.org/?"]) {
      expect(() => normalizeWidgetOrigin(value, "production")).toThrow();
    }
    expect(normalizeWidgetOrigin("http://127.0.0.1:3101", "test")).toBe("http://127.0.0.1:3101");
    expect(() => normalizeWidgetOrigin("http://example.org", "test")).toThrow();
  });
  it("bounds actual bytes and characters and rejects caller authority", () => {
    const requestId = crypto.randomUUID();
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(parseWidgetChatBody(encode({ requestId, query: " How do I join? " }))).toEqual({ requestId, query: "How do I join?" });
    expect(() => parseWidgetChatBody(encode({ requestId, query: "x", history: [] }))).toThrow();
    expect(() => parseWidgetChatBody(encode({ requestId, query: "x".repeat(4001) }))).toThrow();
    expect(() => parseWidgetChatBody(new Uint8Array(32769))).toThrow();
  });
  it("keeps appearance bounded and does not permit enabled empty allowlists", () => {
    const settings = { enabled: true, allowedOrigins: ["https://EXAMPLE.org/"], title: "Ask us", welcomeMessage: "Welcome", suggestedQuestions: [], accent: "#123abc", side: "right" as const };
    expect(normalizeWidgetSettings(settings).allowedOrigins).toEqual(["https://example.org"]);
    expect(() => normalizeWidgetSettings({ ...settings, allowedOrigins: [] })).toThrow();
    expect(() => normalizeWidgetSettings({ ...settings, accent: "red;display:none" })).toThrow();
  });
});
