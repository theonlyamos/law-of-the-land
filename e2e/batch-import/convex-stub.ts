import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";
import { useEffect, useState } from "react";
import { recordReviewFixtureMutation } from "./review-fixture";

type Input = Record<string, unknown>;
type Receipt = { resourceId: string; versionId: string; status: string; indexed: boolean };
type FixtureState = {
  uploads: number; commits: number; receipts: Record<string, Receipt>;
  failedUpload?: boolean; lostCommitResponse?: boolean;
};
const stateKey = "batch-import-fixture-backend";
const scenario = () => new URLSearchParams(window.location.search).get("scenario");
let finishDelayedCommit: (() => void) | undefined;

export function resolveDelayedCommit() {
  finishDelayedCommit?.();
  finishDelayedCommit = undefined;
}

export function fixtureState(): FixtureState {
  return JSON.parse(localStorage.getItem(stateKey) ?? "null") ?? { uploads: 0, commits: 0, receipts: {} };
}
function writeState(state: FixtureState) {
  localStorage.setItem(stateKey, JSON.stringify(state));
  window.dispatchEvent(new Event("fixture-backend-change"));
}
function existing(receipt: Receipt) {
  return { kind: "existing", message: "This original is already recorded.", ...receipt };
}
function readQuery(name: string, args: Input): unknown {
  const state = fixtureState();
  if (name.includes("listJurisdictions")) {
    return { page: [{ _id: "ghana-fixture", code: "GH", name: "Ghana", status: "enabled" }], continueCursor: "", isDone: true };
  }
  if (name.includes("preflight")) {
    const receipt = state.receipts[String(args.sha256)];
    return receipt ? existing(receipt) : { kind: "new", message: "No matching original or case identity.", indexed: false };
  }
  if (name.includes("getStatus")) {
    const receipt = Object.values(state.receipts).find((row) => row.versionId === args.versionId);
    return receipt ? existing(receipt) : null;
  }
  throw new Error(`Unexpected fixture query: ${name}`);
}

async function mutate(name: string, args: Input): Promise<unknown> {
  if (name.startsWith("admin/reviews:") || name.startsWith("admin/sourceVerification:")) return recordReviewFixtureMutation(name, args);
  const state = fixtureState();
  if (name.includes("generateUploadUrl")) return `${window.location.origin}/fixture-upload`;
  if (name.includes("prepareDuplicateChecks")) { writeState(state); return { processed: 0, done: true }; }
  if (name.includes("commit")) {
    state.commits += 1;
    const key = String(args.sha256);
    const previous = state.receipts[key];
    if (previous) { writeState(state); return existing(previous); }
    const receipt = { resourceId: `resource-${state.commits}`, versionId: `version-${state.commits}`, status: "ready_for_review", indexed: false };
    state.receipts[key] = receipt;
    if (scenario() === "lost-commit" && !state.lostCommitResponse) {
      state.lostCommitResponse = true;
      writeState(state);
      throw new Error("Connection lost after commit.");
    }
    writeState(state);
    if (scenario() === "delayed-commit") {
      await new Promise<void>((resolve) => { finishDelayedCommit = resolve; });
    }
    return { kind: "imported", message: "Original recorded for manual review.", ...receipt };
  }
  throw new Error(`Unexpected fixture mutation: ${name}`);
}

export function useConvex() {
  return {
    query: async <R extends FunctionReference<"query">>(reference: R, args: FunctionArgs<R>): Promise<FunctionReturnType<R>> =>
      readQuery(getFunctionName(reference), args) as FunctionReturnType<R>,
  };
}
export function useMutation<R extends FunctionReference<"mutation">>(reference: R) {
  return async (args: FunctionArgs<R>): Promise<FunctionReturnType<R>> => mutate(getFunctionName(reference), args) as Promise<FunctionReturnType<R>>;
}
export function useQuery_experimental<R extends FunctionReference<"query">>({ query, args }: { query: R; args: FunctionArgs<R> | "skip" }) {
  const [, setRevision] = useState(0);
  useEffect(() => {
    const update = () => setRevision((revision) => revision + 1);
    window.addEventListener("fixture-backend-change", update);
    return () => window.removeEventListener("fixture-backend-change", update);
  }, []);
  return args === "skip" ? { status: "pending" as const } : { status: "success" as const, data: readQuery(getFunctionName(query), args) as FunctionReturnType<R> };
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  if (String(input).includes("/fixture-upload")) {
    const state = fixtureState();
    state.uploads += 1;
    if (scenario() === "upload-error" && !state.failedUpload) {
      state.failedUpload = true;
      writeState(state);
      return new Response("Interrupted upload", { status: 503 });
    }
    writeState(state);
    if (scenario() === "slow-upload" && state.uploads === 1) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 60_000);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
      });
    }
    return Response.json({ storageId: `storage-${state.uploads}` });
  }
  return realFetch(input, init);
};
