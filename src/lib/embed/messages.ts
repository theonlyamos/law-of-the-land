export function frameMessage(data: unknown, embedId: string, instanceId: string, types: readonly string[]): data is { type: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const d = data as Record<string, unknown>;
  return Object.keys(d).sort().join() === "embedId,instanceId,namespace,payload,type,version" && d.namespace === "lotl-widget" && d.version === 1 && d.embedId === embedId && d.instanceId === instanceId && typeof d.type === "string" && types.includes(d.type) && !!d.payload && typeof d.payload === "object" && !Array.isArray(d.payload) && Object.keys(d.payload).length === 0;
}
