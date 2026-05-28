"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { Loader2, MonitorSmartphone, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/convex/_generated/api";

function formatRelativeTime(timestamp: number) {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function SessionManager() {
  const router = useRouter();
  const { signOut } = useAuthActions();
  const sessions = useQuery(api.sessions.listSessions);
  const revokeSession = useMutation(api.sessions.revokeSession);
  const revokeOtherSessions = useMutation(api.sessions.revokeOtherSessions);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);

  if (sessions === undefined) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const handleRevoke = async (authSessionId: string, isCurrent: boolean) => {
    setBusyId(authSessionId);
    try {
      const result = await revokeSession({ authSessionId: authSessionId as never });
      if (result.signedOutCurrent) {
        await signOut();
        router.push("/signin");
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleRevokeOthers = async () => {
    setRevokingOthers(true);
    try {
      await revokeOtherSessions({});
    } finally {
      setRevokingOthers(false);
    }
  };

  return (
    <div className="container mx-auto max-w-3xl px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle>Active sessions</CardTitle>
          <CardDescription>
            Review devices signed in to your account. Revoke any session you do not recognize.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active sessions found.</p>
          ) : (
            <div className="space-y-3">
              {sessions.map((session) => (
                <div
                  key={session._id}
                  className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-start gap-3">
                    <MonitorSmartphone className="mt-0.5 h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="font-medium">
                        {session.deviceLabel}
                        {session.isCurrent && (
                          <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                            Current
                          </span>
                        )}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Last active {formatRelativeTime(session.lastActiveAt)}
                        {session.ipAddress ? ` · ${session.ipAddress}` : ""}
                      </p>
                    </div>
                  </div>

                  {!session.isCurrent && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === session.authSessionId}
                      onClick={() => void handleRevoke(session.authSessionId, false)}
                    >
                      {busyId === session.authSessionId ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Revoke"
                      )}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          {sessions.some((session) => !session.isCurrent) && (
            <Button
              variant="destructive"
              disabled={revokingOthers}
              onClick={() => void handleRevokeOthers()}
              className="w-full sm:w-auto"
            >
              {revokingOthers ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ShieldAlert className="mr-2 h-4 w-4" />
              )}
              Sign out all other devices
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
