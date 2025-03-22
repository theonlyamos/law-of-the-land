import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Check } from "lucide-react";

const tiers = [
  {
    name: "Basic",
    id: "basic",
    price: { monthly: "$9", yearly: "$90" },
    description: "Perfect for individuals seeking legal information",
    features: [
      "Up to 50 queries per month",
      "Basic legal document search",
      "Standard response time",
      "Access to common legal documents",
      "Chat history storage",
      "Basic markdown formatting",
      "Email support",
    ],
    featured: false,
  },
  {
    name: "Pro",
    id: "pro",
    price: { monthly: "$29", yearly: "$290" },
    description: "Best for legal professionals and businesses",
    features: [
      "Unlimited queries",
      "Advanced legal document search",
      "Priority response time",
      "Access to all legal documents",
      "Extended chat history",
      "Advanced markdown formatting",
      "Priority email support",
      "API access",
      "Custom document collections",
      "Team collaboration",
    ],
    featured: true,
  },
  {
    name: "Enterprise",
    id: "enterprise",
    price: { monthly: "Custom", yearly: "Custom" },
    description: "For organizations requiring advanced legal research capabilities",
    features: [
      "Everything in Pro",
      "Custom AI model fine-tuning",
      "Dedicated support team",
      "Custom legal document integration",
      "SLA guarantee",
      "Advanced security features",
      "Custom training sessions",
      "24/7 priority support",
      "White-label options",
      "Custom analytics dashboard",
    ],
    featured: false,
  },
];

export default function PricingPage() {
  return (
    <div className="py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="text-base font-semibold leading-7 text-primary">Pricing</h1>
          <p className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">
            Choose your legal research plan
          </p>
          <p className="mt-6 text-lg leading-8 text-muted-foreground">
            Access AI-powered legal information with our flexible pricing plans. All plans include a 14-day free trial.
          </p>
        </div>
        <div className="isolate mx-auto mt-16 grid max-w-md grid-cols-1 gap-y-8 sm:mt-20 lg:mx-0 lg:max-w-none lg:grid-cols-3 lg:gap-x-8">
          {tiers.map((tier) => (
            <Card
              key={tier.id}
              className={`flex flex-col justify-between transition-all duration-300 hover:shadow-lg ${
                tier.featured
                  ? "ring-2 ring-primary hover:ring-primary/80"
                  : "ring-1 ring-muted hover:ring-primary/40"
              }`}
            >
              <CardHeader>
                <CardTitle>{tier.name}</CardTitle>
                <CardDescription>{tier.description}</CardDescription>
                <div className="mt-4 flex items-baseline gap-x-1">
                  <span className="text-4xl font-bold tracking-tight">
                    {tier.price.monthly}
                  </span>
                  <span className="text-sm font-semibold leading-6 text-muted-foreground">
                    /month
                  </span>
                </div>
              </CardHeader>
              <CardContent>
                <ul role="list" className="mt-8 space-y-3 text-sm leading-6">
                  {tier.features.map((feature) => (
                    <li key={feature} className="flex gap-x-3">
                      <Check
                        className="h-6 w-5 flex-none text-primary"
                        aria-hidden="true"
                      />
                      {feature}
                    </li>
                  ))}
                </ul>
              </CardContent>
              <CardFooter>
                <Button
                  className={`w-full transition-colors duration-200 ${
                    tier.featured
                      ? "bg-primary hover:bg-primary/90"
                      : "bg-primary/10 text-primary hover:bg-primary/20"
                  }`}
                >
                  Start free trial
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
        <div className="mt-16 text-center">
          <p className="text-sm text-muted-foreground">
            All prices are in USD. Need a custom plan?{" "}
            <a href="#" className="font-semibold text-primary hover:text-primary/90">
              Contact us
            </a>
          </p>
        </div>
      </div>
    </div>
  );
} 