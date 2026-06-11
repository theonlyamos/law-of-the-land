"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";
import { Loader2, MonitorSmartphone, ShieldAlert } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type BetterAuthSession = {
  id: string;
  token: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  updatedAt: Date | string;
};

function formatRelativeTime(value: Date | string) {
  const timestamp = typeof value === "string" ? new Date(value).getTime() : value.getTime();
  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function parseDeviceLabel(userAgent?: string | null) {
  if (!userAgent) return "Unknown device";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "Apple mobile device";
  if (/Android/i.test(userAgent)) return "Android device";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "Mac";
  if (/Windows/i.test(userAgent)) return "Windows PC";
  if (/Linux/i.test(userAgent)) return "Linux device";
  return "Web browser";
}

export function SessionManager() {
  const router = useRouter();
  const [sessions, setSessions] = useState<BetterAuthSession[]>([]);
  const [currentSessionToken, setCurrentSessionToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [sessionResult, listResult] = await Promise.all([
        authClient.getSession(),
        authClient.listSessions(),
      ]);

      setCurrentSessionToken(sessionResult.data?.session.token ?? null);
      setSessions((listResult.data ?? []) as BetterAuthSession[]);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const handleRevoke = async (token: string, isCurrent: boolean) => {
    setBusyToken(token);
    setActionError(null);
    try {
      await authClient.revokeSession({ token });
      if (isCurrent) {
        await authClient.signOut();
        router.push("/signin");
        return;
      }
      await loadSessions();
    } catch {
      setActionError("We could not revoke that session. Try again.");
    } finally {
      setBusyToken(null);
    }
  };

  const handleRevokeOthers = async () => {
    setRevokingOthers(true);
    setActionError(null);
    try {
      await authClient.revokeOtherSessions();
      await loadSessions();
    } catch {
      setActionError("We could not sign out the other devices. Try again.");
    } finally {
      setRevokingOthers(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-10">
        <Card>
          <CardHeader>
            <CardTitle>Active sessions</CardTitle>
            <CardDescription>
              We could not load your sessions. Check your connection and try again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => void loadSessions()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

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
          {actionError && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {actionError}
            </p>
          )}
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active sessions found.</p>
          ) : (
            <div className="space-y-3">
              {sessions.map((session) => {
                const isCurrent = session.token === currentSessionToken;
                return (
                  <div
                    key={session.id}
                    className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex items-start gap-3">
                      <MonitorSmartphone className="mt-0.5 h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="font-medium">
                          {parseDeviceLabel(session.userAgent)}
                          {isCurrent && (
                            <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                              Current
                            </span>
                          )}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Last active {formatRelativeTime(session.updatedAt)}
                          {session.ipAddress ? ` · ${session.ipAddress}` : ""}
                        </p>
                      </div>
                    </div>

                    {!isCurrent && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyToken === session.token}
                        onClick={() => void handleRevoke(session.token, false)}
                      >
                        {busyToken === session.token ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          "Revoke"
                        )}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {sessions.some((session) => session.token !== currentSessionToken) && (
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
