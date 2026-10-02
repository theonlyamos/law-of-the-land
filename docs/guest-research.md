# Guest research

Guests can receive one answer and one follow-up in one public jurisdiction. The
answers and citations remain readable at the limit. Signing in adopts the
server-stored conversation and restores the pending draft into the normal composer.

## Enable

1. Deploy the Convex schema/functions and Next.js code together.
2. Set `EMBED_SERVICE_SECRET` to the same existing 32+ character secret on Next.js
   and Convex. Keep `WIDGET_IP_HASH_SECRET` configured on Next.js. These are shared
   with the chat widget; do not rotate just for this feature.
3. Set `GUEST_RESEARCH_ENABLED=true` on both hosts and redeploy Next.js so the
   homepage uses the enabled value. The Convex gate independently blocks admission.
4. Optionally set Convex `GUEST_RESEARCH_DAILY_BUDGET` (default `100`). This is a
   request cap, not a currency budget: every admitted generation counts, including
   failed attempts. `0` stops new guest generations.

Production requires Vercel's overwritten client-IP header; arbitrary forwarded
headers are not trusted. Local development uses a shared local-only rate bucket.
The existing `GOOGLE_AI_API_KEY` and model configuration power both research paths.

## Limits and retention

- Two validated completed answers per guest session; failed attempts do not reduce
  that allowance. At most one generation is active per session.
- Persistent IP limits: five session creations and ten generation admissions per
  hour; a global daily admission cap also applies. Clearing browser storage does
  not clear these server limits.
- Temporary sessions expire after 24 hours and are cleaned up in bounded batches.
  The HttpOnly, SameSite cookie and local pending draft have the same lifetime.
- Signup requires the account identity and guest-session possession. Adoption is
  atomic and idempotent; it imports canonical answers and revalidated citations,
  never browser-supplied answers. Adopted account history follows normal retention.
- Guest access uses the same eligible public source scope as normal research,
  including eligible ancestors. Widget-only/member authority is never inherited.

## Checks

Run focused guest runtime/API/UI tests, the sign-in and chat draft regression
tests, and TypeScript checks. Before enabling production, confirm one cited answer,
one follow-up, third-question signup, reload recovery, and signup adoption using
the deployed provider and auth configuration.
