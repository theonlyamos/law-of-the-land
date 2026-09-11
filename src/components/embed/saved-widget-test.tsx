"use client";
import { useEffect, useRef, useState } from "react";
import { frameMessage } from "@/lib/embed/client";
export function SavedWidgetTest({ publicId, onClose }: { publicId: string; onClose: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [identity] = useState(() => ({ instanceId: crypto.randomUUID(), origin: window.location.origin }));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== identity.origin || event.source !== frame.current?.contentWindow || !frameMessage(event.data, publicId, identity.instanceId, ["ready", "close"])) return;
      if (event.data.type === "close") { onClose(); return; }
      for (const type of ["init", "opened"]) frame.current?.contentWindow?.postMessage({ namespace: "lotl-widget", version: 1, embedId: publicId, instanceId: identity.instanceId, type, payload: {} }, identity.origin);
      setReady(true);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [identity, publicId, onClose]);
  return <div className="space-y-3"><p className="text-sm">This tests saved settings and uses your organization's allowance.</p>{!ready && <p role="status">Loading saved widget. If it doesn't load, check that chat widget is enabled and your library is ready.</p>}<iframe ref={frame} title="Test saved chat widget" className="h-[640px] w-full rounded-lg border" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" src={`/embed/${encodeURIComponent(publicId)}?parentOrigin=${encodeURIComponent(identity.origin)}&instanceId=${identity.instanceId}`} /></div>;
}
