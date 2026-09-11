import type { Id } from "@/convex/_generated/dataModel";
import { WebsiteChatSettings } from "@/components/organizations/website-chat-settings";
export default async function Page({ params }: { params: Promise<{ organizationId: string }> }) {
  return <WebsiteChatSettings organizationId={(await params).organizationId as Id<"organizations">} />;
}
