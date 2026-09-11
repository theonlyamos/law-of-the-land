import { expect, it } from "vitest";
import { readAnswer, frameMessage } from "./client";
it("ignores provisional text and accepts only a matching terminal answer", async () => {
  const id = crypto.randomUUID();
  const stream = (events: unknown[]) => new Response(events.map(v => JSON.stringify(v)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
  const statuses: string[] = [];
  expect(await readAnswer(stream([{ type: "status", status: "validating" }]), id, text => statuses.push(text))).toBeNull();
  expect(statuses).toEqual(["Checking sources…"]);
  const result = { requestId: id, answer: "Verified answer", citations: [], completedAt: 1 };
  expect(await readAnswer(stream([{ type: "done", ...result }]), id, () => {})).toEqual(result);
  await expect(readAnswer(stream([{ type: "done", ...result, requestId: crypto.randomUUID() }]), id, () => {})).rejects.toThrow("Answer mismatch");
  expect(frameMessage({ namespace: "lotl-widget", version: 1, embedId: "widget", instanceId: "instance", type: "init", payload: {} }, "widget", "instance", ["init"])).toBe(true);
  expect(frameMessage({ namespace: "lotl-widget", version: 1, embedId: "widget", instanceId: "instance", type: "init", payload: { token: "injected" } }, "widget", "instance", ["init"])).toBe(false);
});
