# Inspect a retained Gemini indexing operation

Use `admin/geminiDiagnosticActions:inspectIndexJob` to inspect a retained indexing operation and independently inspect its File Search documents. This is an internal action: a deployment administrator can invoke it with existing authenticated Convex tooling. It is not a browser API and requires no new credentials, persistent access token, or environment variable.

The action accepts only an integration job ID. Its internal query resolves and validates the version, resource, jurisdiction, unique store owner, payload checksum, organization binding, and retained operation. It does not require an active lifecycle lease or impersonate the original job actor. It accepts retained index jobs in `manual_review`, `waiting_provider`, or `running`.

The deployed backend reads the existing `GOOGLE_AI_API_KEY` environment variable. Never retrieve or pass that value through the CLI. Isolated E2E configurations cannot contact the live provider through this action.

## Deployment and invocation

This addition must be included in an explicitly approved backend deployment before it can be invoked. Review the diagnostic-only diff based on `7761ccb2cfd7a16d3db7f2936a9235ec66188588`, then promote its exact reviewed commit through the normal `main` pipeline. Do not run an ad hoc production deploy, broaden the deployment to unrelated working-tree edits, or infer that a prepared local action is already available in production. Verify the Convex deployment audit identifies the approved commit.

For the retained OHADA insolvency job, after that deployment is approved and verified:

```powershell
bunx convex run --deployment loyal-koala-720 --codegen disable admin/geminiDiagnosticActions:inspectIndexJob '{"jobId":"m572hc94dkzn1ckbe39p22p2tn8fgmea"}'
```

The command performs provider GET requests only. It never retries or claims the integration job, uploads a file, deletes a provider resource, changes publication/readiness state, schedules work, or persists its observations. An invocation can appear in ordinary platform execution logs, but the action does not log provider bodies or credentials.

## Interpret the observations

- `operation.done`, `operation.error.code`, and the sanitized response describe the retained operation. Error messages are deliberately omitted; `messagePresent` only reports their presence. A request error is distinct from an indexing operation that has completed with an error.
- If an operation response references a document in the expected store, the diagnostic also gets that exact document and checks its metadata. A foreign or malformed document reference is never fetched.
- The document scan runs independently of operation inspection, including when operation inspection fails. A nonterminal operation and a failed matching document can therefore both be reported without inferring a recovery action.
- Documents must have unique, exactly matching string metadata for `environment`, `jurisdiction_id`, `resource_id`, `version_id`, `version_number`, and `sha256`. Filename similarity is not evidence of identity. Only matching documents' allowlisted metadata and state are returned; raw provider resource names are replaced with SHA-256 references.
- `documents.stateCounts` counts rows examined in the scan. Requests are bounded to 20 pages of at most 20 documents each, with a ten-second timeout and one attempt per request. `scanComplete: false` means the counts and absence of a match are incomplete. The operation's direct document observation is separate from these scan counts.
- Multiple distinct exact matches set `duplicateMatches: true`. No match means no exact metadata match was observed, not proof that the source file never reached Gemini. None of these results automatically approves publication or clears a lifecycle lock.

Provider states are defined in the [Gemini Documents API reference](https://ai.google.dev/api/file-search/documents): pending processing, active/queryable, failed processing, or unspecified. Keep any subsequent retry, reconciliation, deletion, or publication decision separate from this diagnostic.
