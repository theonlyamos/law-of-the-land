"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";
import { safeRedirectPath } from "@/lib/redirect";
import { useConvexAuth } from "convex/react";
import { Loader2 } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

function SignInFormInner() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Signing in lands on the new-chat screen unless the user was sent here
  // mid-action (e.g. asked a question while signed out).
  const redirectTo = safeRedirectPath(searchParams.get("redirect"), "/new");

  const [step, setStep] = useState<"signIn" | "signUp">("signIn");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace(redirectTo);
    }
  }, [isAuthenticated, isLoading, redirectTo, router]);

  if (isLoading || isAuthenticated) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const handlePasswordSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const result =
        step === "signIn"
          ? await authClient.signIn.email({
              email: email.trim(),
              password,
            })
          : await authClient.signUp.email({
              email: email.trim(),
              password,
              name: name.trim() || email.trim(),
            });

      if (result.error) {
        setError(
          result.error.message ??
            (step === "signIn"
              ? "We could not sign you in. Check your email and password, then try again."
              : "We could not create your account. Check the details and try again.")
        );
        return;
      }

      router.replace(redirectTo);
    } catch {
      setError("We could not reach the sign-in service. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleOAuth = async (provider: "github" | "google") => {
    setSubmitting(true);
    setError(null);
    try {
      await authClient.signIn.social({
        provider,
        callbackURL: redirectTo,
      });
    } catch {
      setError(
        `We could not start ${provider === "github" ? "GitHub" : "Google"} sign-in. Try again, or use email and password.`
      );
      setSubmitting(false);
    }
  };

  return (
    <div className="container mx-auto flex min-h-[calc(100vh-8rem)] items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2 text-center">
          <CardTitle className="text-2xl">
            {step === "signIn" ? "Sign in to your account" : "Create your account"}
          </CardTitle>
          <CardDescription>
            Save chat history securely and manage active sessions across devices.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <form className="space-y-4" onSubmit={handlePasswordSubmit}>
            {step === "signUp" && (
              <div className="space-y-2">
                <label htmlFor="name" className="text-sm font-medium">
                  Name
                </label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder="Your name"
                />
              </div>
            )}

            <div className="space-y-2">
              <label htmlFor="email" className="text-sm font-medium">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                placeholder="you@example.com"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete={step === "signIn" ? "current-password" : "new-password"}
                required
                minLength={8}
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                placeholder="At least 8 characters"
              />
              {step === "signUp" && (
                <p className="text-xs text-muted-foreground">
                  At least 8 characters.
                </p>
              )}
            </div>

            {error && (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {step === "signIn" ? "Sign in" : "Create account"}
            </Button>
          </form>

          <div className="space-y-3">
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground">Or continue with</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => void handleOAuth("github")}
              >
                GitHub
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => void handleOAuth("google")}
              >
                Google
              </Button>
            </div>
          </div>

          <div className="text-center text-sm text-muted-foreground">
            {step === "signIn" ? (
              <>
                New here?{" "}
                <button
                  type="button"
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                  onClick={() => {
                    setStep("signUp");
                    setError(null);
                  }}
                >
                  Create an account
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                  onClick={() => {
                    setStep("signIn");
                    setError(null);
                  }}
                >
                  Sign in
                </button>
              </>
            )}
          </div>

          <p className="text-center text-xs text-muted-foreground">
            <Link href="/" className="underline-offset-4 hover:underline">
              Back to home
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export function SignInForm() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[50vh] items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <SignInFormInner />
    </Suspense>
  );
}
