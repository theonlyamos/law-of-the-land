import { ChatWidgetSettings } from "@/components/organizations/website-chat-settings";
import type { Id } from "@/convex/_generated/dataModel";
export default async function Page({
  params,
}: {
  params: Promise<{ organizationId: string; jurisdictionId: string }>;
}) {
  const p = await params;
  return (
    <ChatWidgetSettings
      organizationId={p.organizationId as Id<"organizations">}
      jurisdictionId={p.jurisdictionId as Id<"jurisdictions">}
    />
  );
}
