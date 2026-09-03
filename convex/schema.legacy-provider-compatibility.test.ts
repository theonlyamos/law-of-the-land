/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("legacy provider schema compatibility", () => {
  it("accepts inert GroundX-era rows during the Gemini hard cutover", async () => {
    const t = convexTest(schema, modules);

    const inserted = await t.run(async (ctx) => {
      const now = Date.now();
      const jurisdictionId = await ctx.db.insert("jurisdictions", {
        code: "GH",
        name: "Ghana",
        slug: "ghana",
        status: "enabled",
        isDefault: true,
        stagingBucketId: "11834",
        productionBucketId: "11833",
        providerSyncState: "synced",
        createdBy: "legacy",
        updatedBy: "legacy",
        createdAt: now,
        updatedAt: now,
      });
      const resourceId = await ctx.db.insert("legalResources", {
        jurisdictionId,
        type: "act",
        title: "Legacy act",
        issuer: "Legacy issuer",
        officialCitation: "Legacy 1",
        officialCitationKey: "legacy 1",
        sourceUrl: "https://example.test/legacy",
        topics: [],
        effectiveDate: "2026-01-01",
        status: "active",
        createdBy: "legacy",
        updatedBy: "legacy",
        createdAt: now,
        updatedAt: now,
      });
      const originalStorageId = await ctx.storage.store(new Blob(["legacy"]));
      const versionStatuses = ["uploading", "staging_processing", "failed"] as const;
      for (const [index, status] of versionStatuses.entries()) {
        await ctx.db.insert("documentVersions", {
          resourceId,
          versionNumber: index + 1,
          originalStorageId,
          filename: `legacy-${index + 1}.pdf`,
          mimeType: "application/pdf",
          byteSize: 6,
          sha256: "a".repeat(64),
          sourceUrl: "https://example.test/legacy",
          status,
          groundxStagingDocumentId: `staging-document-${index}`,
          groundxStagingProcessId: `staging-process-${index}`,
          xrayEvidence: {
            status: "complete",
            documentId: `staging-document-${index}`,
            processId: `staging-process-${index}`,
            fileType: "pdf",
            fileSize: 6,
            observedAt: now,
          },
          groundxProductionDocumentId: `production-document-${index}`,
          groundxProductionProcessId: `production-process-${index}`,
          submittedBy: "legacy",
          createdAt: now + index,
          updatedAt: now + index,
        });
      }

      const jobTypes = ["create_bucket", "ingest_remote", "copy_documents", "delete_documents", "poll_process"] as const;
      for (const [index, type] of jobTypes.entries()) {
        await ctx.db.insert("integrationJobs", {
          type,
          targetType: "legacy",
          targetId: `legacy-${index}`,
          payload: "{}",
          actorId: "legacy",
          actorRoles: [],
          idempotencyKey: `legacy-job-${index}`,
          requestFingerprint: "{}",
          correlationId: `legacy-correlation-${index}`,
          callbackTokenHash: `legacy-callback-${index}`,
          processId: `legacy-process-${index}`,
          status: "waiting_callback",
          attemptCount: 0,
          createdAt: now + index,
          updatedAt: now + index,
        });
      }

      await ctx.db.insert("unifiedJurisdictionRolloutStates", {
        environment: "preview",
        migrationVersion: "jurisdiction_ids_v1",
        ghanaJurisdictionId: jurisdictionId,
        ghanaSeedLastResult: {
          jurisdictionId,
          changed: false,
          preservedProductionBucket: "11833",
        },
        legacyObservationGeneration: 0,
        legacyAcceptedSinceStart: 0,
        updatedAt: now,
      });

      return {
        jurisdictions: await ctx.db.query("jurisdictions").take(10),
        versions: await ctx.db.query("documentVersions").take(10),
        jobs: await ctx.db.query("integrationJobs").take(10),
        rollout: await ctx.db.query("unifiedJurisdictionRolloutStates").take(10),
      };
    });

    expect(inserted.jurisdictions).toHaveLength(1);
    expect(inserted.versions).toHaveLength(3);
    expect(inserted.jobs).toHaveLength(5);
    expect(inserted.rollout).toHaveLength(1);
  });
});
