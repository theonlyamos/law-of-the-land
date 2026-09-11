import { redirect } from "next/navigation";
export default async function Page({ params }: { params: Promise<{ organizationId: string }> }) { redirect(`/organizations/${(await params).organizationId}/resources`); }
