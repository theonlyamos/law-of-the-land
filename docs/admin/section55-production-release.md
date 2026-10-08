# Ghana Act 651 section 55 production release

This release adds a default-off reviewed path for Ghana questions selected exclusively for section 55 overtime/night work. It uses the supplied Act 651 edition, PDF page 18, including the declared section 56 context. It does not certify current law, whole-document coverage, or other jurisdictions/topics. Answer text is released only after the complete private draft, inventory and both condition audits pass and atomic persistence succeeds. User-visible answer streaming is a separate feature.

Production binds jurisdiction `md791bzzqyzd0qdtman23jar7d8ds244`, resource `mh7f6wbf5e8nt6sb47wwddwn9s8dsjqa`, and published version `kd7c80kgs1zzdcw1qhydrdwyas8dsysw`. The original PDF is 1,913,139 bytes with SHA-256 `125e8ce4d70beb6fbe6adc5f9cbaec27dc435c484a62b3eee38bf80cff466f5a`. Registry inclusion grants no access: native session/owner, selected jurisdiction, publication, dates, storage, provider linkage and lifecycle locks are revalidated through normal research authorization and final atomic completion.

The source binding is separate from immutable reviewed evidence identity and the unchanged canonical UTF-8 passages. Jobs persist `act651-s55-prod-v1`; this ID must never be repurposed for another edition or scope. Missing legacy IDs work only in the verified DEV runtime.

## Admission and rollback

The exact production host is `https://lawoftheland.vercel.app`, with `loyal-koala-720` cloud/site URLs in `eu-west-1`. Preview/unknown/mismatched deployments cannot admit reviewed work. Production admission requires both `REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED=1` and `REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED=1` in the Next and native backend environments. Both controls are default off.

Turning admission off prevents new jobs while execution can drain already admitted work. Turning execution off prevents new worker claims, authority reads, stage reservations/passes and commits; polling closes active workers. A dispatch already reserved before the switch may have reached Google. Owner status reads, cancellation, expiry/cleanup and saved original-PDF access remain available independently. Retain those backend functions/tables and existing answers during rollback. Do not force states, delete reservations, or resume uncertain dispatches.

Only a successfully selected exclusive overtime request is eligible. Other topics, mixed selected topics and document summaries retain their ordinary routes. Reviewed admission requires complete bounded history and readable context. Once a supported request is recognized, a failed final context check is withheld rather than sent to the ordinary model.

Private attachment plumbing is included as a runtime dependency, but new production uploads are a separate, default-off capability. Do not enable `NEXT_PUBLIC_CHAT_ATTACHMENTS_ENABLED` or `CHAT_ATTACHMENTS_PRODUCTION_ENABLED` for this limited rollout. Existing owner reads and cleanup remain available. DEV retains attachment support.

## Execution and hosting

Each job has one claim and four persisted provider dispatch reservations. No provider retry, uncertain-stage takeover or resubmission is allowed. Original job clocks bound verification to 240 seconds and terminal persistence to 270 seconds. Admission takes at most 25 seconds, with five seconds reserved for closure inside the declared 300-second route window.

Next `after()` runs within the request's hosted duration. Durable status does not imply crash-resumable execution: host loss leaves claimed work for scheduled expiry at its original terminal deadline, with no duplicate call or late answer commit. Confirm actual hosted Fluid/function duration before activation; source declarations alone are not hosted evidence.

All earlier paid verification allowances are closed. Any new live release test requires a fresh explicit allowance; one normal successful draft/inventory/consent/overtime test needs at most four Google create calls, with zero retries or provider retrievals. Source identity and owner read-only readiness checks do not reuse those trial budgets.

Deploy the independently reviewed, matching tested artifact first. Then merge current `development` into `codex/answer-reliability-candidate`, resolve and verify that merge separately. Do not redeploy merged changes implicitly.
