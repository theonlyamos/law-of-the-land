"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/convex/_generated/api";
import { CheckoutLink, CustomerPortalLink } from "@convex-dev/polar/react";
import { useConvexAuth, useQuery } from "convex/react";
import { Check } from "lucide-react";
import Link from "next/link";

const FREE_FEATURES = [
  "10 questions per day",
  "Saved chat history on all devices",
  "Citations to the legal text",
];

const PRO_FEATURES = [
  "200 questions per day",
  "Everything in Free",
  "Supports new countries and features",
];

export function BillingPanel() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const summary = useQuery(api.usage.summary, isAuthenticated ? {} : "skip");
  const products = useQuery(api.polar.getConfiguredProducts, isAuthenticated ? {} : "skip");

  if (isLoading || (isAuthenticated && summary === undefined)) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!isAuthenticated || !summary) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-10">
        <Card>
          <CardHeader>
            <CardTitle>Billing</CardTitle>
            <CardDescription>
              <Link href="/signin" className="underline underline-offset-4">
                Sign in
              </Link>{" "}
              to manage your plan.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const proProduct = products?.proMonthly ?? null;
  const proPrice = proProduct?.prices?.[0]?.priceAmount;

  return (
    <div className="container mx-auto max-w-3xl px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle>Plan &amp; usage</CardTitle>
          <CardDescription>
            {summary.billingEnabled ? (
              <>
                You are on the <strong>{summary.isPro ? "Pro" : "Free"}</strong> plan —{" "}
                {summary.usedToday} of {summary.limit} questions used today.
              </>
            ) : (
              <>
                Billing is not active yet — all features are free for now. You have asked{" "}
                {summary.usedToday} questions today.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className={`rounded-lg border p-4 ${!summary.isPro ? "border-foreground/30" : ""}`}>
              <div className="flex items-baseline justify-between">
                <h3 className="font-medium">Free</h3>
                <span className="text-sm text-muted-foreground">$0</span>
              </div>
              <ul className="mt-3 space-y-2 text-sm">
                {FREE_FEATURES.map((feature) => (
                  <li key={feature} className="flex items-start gap-2">
                    <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              {!summary.isPro && (
                <p className="mt-4 text-xs text-muted-foreground">Your current plan</p>
              )}
            </div>

            <div className={`rounded-lg border p-4 ${summary.isPro ? "border-foreground/30" : ""}`}>
              <div className="flex items-baseline justify-between">
                <h3 className="font-medium">Pro</h3>
                <span className="text-sm text-muted-foreground">
                  {proPrice != null ? `$${(proPrice / 100).toFixed(0)}/month` : "$6/month"}
                </span>
              </div>
              <ul className="mt-3 space-y-2 text-sm">
                {PRO_FEATURES.map((feature) => (
                  <li key={feature} className="flex items-start gap-2">
                    <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-4">
                {summary.isPro ? (
                  <CustomerPortalLink
                    polarApi={{ generateCustomerPortalUrl: api.polar.generateCustomerPortalUrl }}
                    className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium shadow-sm transition hover:bg-accent"
                  >
                    Manage subscription
                  </CustomerPortalLink>
                ) : proProduct ? (
                  <CheckoutLink
                    polarApi={api.polar}
                    productIds={[proProduct.id]}
                    embed={false}
                    className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow transition hover:bg-primary/90"
                  >
                    Upgrade to Pro
                  </CheckoutLink>
                ) : (
                  <Button disabled variant="outline" size="sm">
                    Upgrades open soon
                  </Button>
                )}
              </div>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Daily limits reset at midnight UTC. Payments are processed by Polar; manage or cancel
            any time from the subscription portal.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
