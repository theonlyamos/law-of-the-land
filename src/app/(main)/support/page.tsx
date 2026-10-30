import type { Metadata } from "next";
import { SupportForm } from "@/components/support/support-form";
import { SUPPORT_CATEGORIES, normalizeSupportPagePath, type SupportCategory } from "../../../../shared/support";

export const metadata: Metadata = {
  title: "Contact & feedback · Law of the Land",
  description: "Ask a question, report a problem, suggest a feature or raise a complaint.",
};

function single(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined;
}

export default async function SupportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const parameters = await searchParams;
  const fromPath = normalizeSupportPagePath(single(parameters.from));
  const requested = single(parameters.category);
  const initialCategory = SUPPORT_CATEGORIES.includes(requested as SupportCategory) ? (requested as SupportCategory) : undefined;
  return (
    <div className="container mx-auto max-w-2xl px-4 py-10">
      <SupportForm fromPath={fromPath === "/support" ? undefined : fromPath} initialCategory={initialCategory} />
    </div>
  );
}
