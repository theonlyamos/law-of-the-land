import { GuestResearch } from "@/components/chat/guest-research";
import Link from "next/link";

export default async function GuestResearchPage({ searchParams }: {
  searchParams: Promise<{ q?: string | string[]; jurisdiction?: string | string[] }>;
}) {
  const params = await searchParams;
  const q = Array.isArray(params.q) ? params.q[0] : params.q;
  const jurisdiction = Array.isArray(params.jurisdiction) ? params.jurisdiction[0] : params.jurisdiction;
  if (process.env.GUEST_RESEARCH_ENABLED !== "true") {
    const destination = q && jurisdiction
      ? `/${crypto.randomUUID()}?q=${encodeURIComponent(q)}&jurisdiction=${encodeURIComponent(jurisdiction)}` : "/new";
    return <main className="mx-auto w-full max-w-3xl px-4 py-12">
      <h1 className="text-xl font-semibold">Continue your legal research</h1>
      <p className="mt-3 text-sm text-muted-foreground">Guest research is currently unavailable. Create a free account to ask your question and save your work.</p>
      <Link className="mt-4 inline-block text-sm font-medium underline underline-offset-4" href={`/signin?mode=signup&redirect=${encodeURIComponent(destination)}`}>Create a free account</Link>
    </main>;
  }
  return <GuestResearch initialQuery={q ?? null} initialJurisdiction={jurisdiction ?? null} />;
}
