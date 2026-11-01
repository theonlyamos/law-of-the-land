# Judgment batch imports

Open **Documents → Import judgment batch**. An assured enabled administrator with resource and document write permissions is required. This screen records immutable originals for review; it does not approve or publish them.

Prepare a UTF-8 JSON manifest (at most 100 judgments per batch):

```json
{
  "version": 1,
  "jurisdictionId": "REPLACE_WITH_EXISTING_GHANA_JURISDICTION_ID",
  "documents": [{
    "filename": "example.pdf",
    "title": "Example v Republic",
    "issuer": "Supreme Court of Ghana",
    "officialCitation": "REPLACE_WITH_VERIFIED_CITATION",
    "sourceUrl": "https://example.org/original-court-judgment.pdf",
    "topics": ["tax"],
    "sourceProvenance": "Identify the actual host, origin of the court text, verification evidence, and any limitations. A law firm reproduction is not government hosted or certified.",
    "caseAliases": ["Alternative reported case citation or title"]
  }]
}
```

`effectiveDate` is optional (YYYY-MM-DD). Do not substitute a judgment date for an effective date without legal verification. Aliases are collision signals: include alternative citations or case names that refer to the same judgment. Distinct decisions in the same litigation need distinct citations. Collision checks are conservative, not proof of case identity or later treatment.

Load the manifest and confirm the displayed jurisdiction and per-document metadata/provenance. Click **Prepare duplicate checks** to fill derived exact title/citation keys for existing catalog rows, in audited pages of at most 100 resources. Preparation can stop and resume safely. It does not change document text, review decisions or publication. Imports fail closed until preparation finishes. Select matching PDFs, then upload. Local filename/citation overlaps are rejected before any upload. The server checks stored checksums and exact normalized citations, supplied aliases and case titles transactionally before creating the resource and version. A conflict requires manual resolution; it never silently overwrites another case. Unknown aliases and independently scanned or modified copies still require human comparison. Distinct judgments with identical party captions deliberately require individual resolution.

Progress metadata is saved in this browser for the signed-in administrator. PDFs and upload URLs are not saved. After navigation or reload, reselect the same PDFs and resume; previously recorded cases reconcile to their existing versions. Keep the manifest file as the portable source of metadata. Stop aborts an active HTTP upload and prevents the next row; an already submitted database transaction may finish. Retry reconciles that transaction before creating anything. An upload whose response is lost can leave an unreferenced storage blob; retries never delete arbitrary storage files or duplicate the resource/version.

Each recorded row links to its review form. Judgment reviews require an explicit source classification, the actual immutable version source URL, verification notes, and personal checks of completeness, citation and later treatment. Official-hosted originals retain the explicit **Official source authenticated** assertion. Reproductions instead require **Reproduction authenticity independently corroborated**, an independent corroborating URL on another hostname, and notes explaining the comparison. A different port or `www` variant of the same host does not count. A URL or checkbox alone does not authenticate a judgment: the reviewer must inspect the evidence and keep incomplete, uncertain or insufficiently corroborated documents unpublished. This does not certify a reproduction or decide its current legal effect automatically.

Read the source and original, verify the citation and metadata, provide real evaluation evidence and a reason, and personally answer all existing metadata/original/citation/evaluation checks. Importing never marks an evaluation successful. The existing backend validates evaluation ID syntax rather than linking an evaluation record, so the reviewer must verify the evidence. Publication remains a separate confirmation; publish and rollback require verified judgment provenance. Existing nonjudgment notices and acts retain their original approval form. Status shows recorded review/publication state and indexing independently; an upload is not a successful search evaluation.

## Correcting earlier source assertions

Open the document's targeted review link, then **Record source correction**. For each earlier mirror-hosted judgment, record its actual host, reproduced-source classification, independent corroboration and verification notes. The correction adds a new record linked to the previous verification, plus an audit event. It does not edit the earlier review assertions or audit records, and it does not approve or publish anything. Reviewers can inspect both histories.

An unresolved correction on an approved document explicitly invalidates that approval and returns it to review. For an already published document, first use the existing **Unpublish version** action, including password verification and confirmation, and wait for unpublication to complete. Then record unresolved evidence. Published unresolved corrections are rejected; the correction endpoint cannot bypass unpublication. A later approval must contain new complete verification evidence. No production correction or migration is executed by installing this code or opening these screens.

Clear saved batch removes only this browser's progress metadata. It does not delete resources, files, reviews, audit records, or publication jobs.
