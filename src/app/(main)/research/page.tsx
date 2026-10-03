import { GuestResearch } from "@/components/chat/guest-research";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
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
    return <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-5 py-16 sm:px-8 sm:py-24">
      <p className="chat-eyebrow mb-5">Clarity starts here</p>
      <h1 className="chat-heading max-w-xl">Continue your <em className="text-primary">legal research.</em></h1>
      <p className="mt-5 max-w-lg text-sm leading-7 text-muted-foreground">Guest research is currently unavailable. Create a free account to ask your question and save your work.</p>
      <Button asChild className="mt-8 min-h-11 self-start rounded-full px-5">
        <Link href={`/signin?mode=signup&redirect=${encodeURIComponent(destination)}`}>Create a free account <ArrowRight className="size-4" aria-hidden="true" /></Link>
      </Button>
    </main>;
  }
  return <GuestResearch initialQuery={q ?? null} initialJurisdiction={jurisdiction ?? null} />;
}
