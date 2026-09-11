import { publicWidgetConfig } from "@/lib/embed/server";
import { GuestChat } from "@/components/embed/guest-chat";
export const dynamic = "force-dynamic";
export default async function EmbedPage({ params, searchParams }: { params: Promise<{ embedId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { embedId } = await params, search = await searchParams;
  const parentOrigin = typeof search.parentOrigin === "string" ? search.parentOrigin : "";
  const instanceId = typeof search.instanceId === "string" ? search.instanceId : "";
  const config = /^[a-zA-Z0-9_-]{8,80}$/.test(instanceId) ? await publicWidgetConfig(embedId, parentOrigin).catch(() => null) : null;
  if (!config) return <p role="status" className="p-6">This assistant isn't available right now. Please contact the organization for help.</p>;
  return <GuestChat config={config} parentOrigin={parentOrigin} instanceId={instanceId} />;
}
