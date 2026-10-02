import { LandingShell } from "@/components/landing-shell";

export default function Home() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LandingShell guestResearchEnabled={process.env.GUEST_RESEARCH_ENABLED === "true"} />
    </div>
  );
}
