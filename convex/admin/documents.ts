import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { mutation } from "../_generated/server";
import { writeAudit } from "./audit";
import { requireEnabledAdminPermission } from "./featureFlags";

const MAX_FILENAME_LENGTH = 180;
const MAX_SOURCE_URL_LENGTH = 500;

// GroundX SDK 1.3.x DocumentType, narrowed to exact browser MIME pairings.
const DOCUMENT_TYPES = {
  txt: ["text/plain"],
  docx: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  pptx: [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  xlsx: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  pdf: ["application/pdf"],
  png: ["image/png"],
  jpg: ["image/jpeg"],
  csv: ["text/csv"],
  tsv: ["text/tab-separated-values"],
  json: ["application/json"],
} as const;

function uploadLimit(): number {
  const raw = process.env.ADMIN_MAX_DOCUMENT_BYTES;
  if (!raw || !/^\d+$/.test(raw)) {
    throw new ConvexError("DOCUMENT_UPLOAD_NOT_CONFIGURED");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConvexError("DOCUMENT_UPLOAD_NOT_CONFIGURED");
  }
  return value;
}

function validatedFilename(value: string): {
  filename: string;
  extension: keyof typeof DOCUMENT_TYPES;
} {
  const filename = value.trim().normalize("NFKC");
  if (
    !filename ||
    filename.length > MAX_FILENAME_LENGTH ||
    /[\\/\u0000-\u001f\u007f]/.test(filename)
  ) {
    throw new ConvexError("INVALID_DOCUMENT_FILENAME");
  }
  const separator = filename.lastIndexOf(".");
  const extension = filename.slice(separator + 1).toLowerCase();
  if (
    separator < 1 ||
    !(extension in DOCUMENT_TYPES)
  ) {
    throw new ConvexError("UNSUPPORTED_DOCUMENT_TYPE");
  }
  return {
    filename,
    extension: extension as keyof typeof DOCUMENT_TYPES,
  };
}

function validatedMime(
  value: string,
  extension: keyof typeof DOCUMENT_TYPES,
): string {
  const mimeType = value.trim().toLowerCase();
  const allowed = DOCUMENT_TYPES[extension] as readonly string[];
  if (!allowed.includes(mimeType)) {
    throw new ConvexError("DOCUMENT_MIME_MISMATCH");
  }
  return mimeType;
}

function validatedSize(value: number, limit: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConvexError("INVALID_DOCUMENT_SIZE");
  }
  if (value > limit) throw new ConvexError("DOCUMENT_TOO_LARGE");
  return value;
}

function validatedSha256(value: string): string {
  const sha256 = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new ConvexError("INVALID_DOCUMENT_CHECKSUM");
  }
  return sha256;
}

function storedSha256Hex(value: string): string {
  if (/^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const bytes = Uint8Array.from(atob(value), (character) =>
      character.charCodeAt(0),
    );
    if (bytes.length !== 32) throw new Error("invalid digest length");
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new ConvexError("DOCUMENT_STORAGE_CHECKSUM_INVALID");
  }
}

function validatedDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ConvexError("INVALID_EFFECTIVE_DATE");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new ConvexError("INVALID_EFFECTIVE_DATE");
  }
  return value;
}

function validatedSourceUrl(value: string, resourceSourceUrl: string): string {
  if (!value || value.length > MAX_SOURCE_URL_LENGTH) {
    throw new ConvexError("INVALID_DOCUMENT_SOURCE_URL");
  }
  let source: URL;
  let governedSource: URL;
  try {
    source = new URL(value);
    governedSource = new URL(resourceSourceUrl);
  } catch {
    throw new ConvexError("INVALID_DOCUMENT_SOURCE_URL");
  }
  if (
    source.protocol !== "https:" ||
    source.username ||
    source.password ||
    source.origin !== governedSource.origin
  ) {
    throw new ConvexError("DOCUMENT_SOURCE_NOT_ALLOWED");
  }
  return source.toString();
}

function correlationId(): string {
  return `op_${crypto.randomUUID().replaceAll("-", "")}`;
}

export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const actor = await requireEnabledAdminPermission(ctx, "document", "write");
    uploadLimit();
    const operationId = correlationId();
    const url = await ctx.storage.generateUploadUrl();
    await writeAudit(ctx, {
      actorId: actor.userId,
      actorRoles: actor.roles,
      action: "document.upload_url_generated",
      targetType: "documentUpload",
      targetId: operationId,
      reason: "Prepare direct original-file upload",
      correlationId: operationId,
      outcome: "success",
    });
    return url;
  },
});

export const createDocumentVersion = mutation({
  args: {
    resourceId: v.id("legalResources"),
    storageId: v.id("_storage"),
    filename: v.string(),
    mimeType: v.string(),
    byteSize: v.number(),
    sha256: v.string(),
    sourceUrl: v.string(),
    effectiveAt: v.string(),
  },
  returns: v.id("documentVersions"),
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "document", "write");
    const limit = uploadLimit();
    const resource = await ctx.db.get("legalResources", args.resourceId);
    if (!resource) throw new ConvexError("RESOURCE_NOT_FOUND");
    if (resource.status === "archived") throw new ConvexError("RESOURCE_ARCHIVED");

    const { filename, extension } = validatedFilename(args.filename);
    const mimeType = validatedMime(args.mimeType, extension);
    const byteSize = validatedSize(args.byteSize, limit);
    const sha256 = validatedSha256(args.sha256);
    const sourceUrl = validatedSourceUrl(args.sourceUrl, resource.sourceUrl);
    const effectiveDate = validatedDate(args.effectiveAt);

    const metadata = await ctx.db.system.get("_storage", args.storageId);
    if (!metadata) throw new ConvexError("DOCUMENT_STORAGE_NOT_FOUND");
    if (metadata.size !== byteSize) {
      throw new ConvexError("DOCUMENT_SIZE_MISMATCH");
    }
    // Convex may omit contentType (and convex-test currently always does).
    // When present it is authoritative; otherwise the exact extension/MIME
    // allowlist above remains the fail-closed type check.
    if (
      metadata.contentType !== undefined &&
      metadata.contentType.toLowerCase() !== mimeType
    ) {
      throw new ConvexError("DOCUMENT_MIME_MISMATCH");
    }
    if (storedSha256Hex(metadata.sha256) !== sha256) {
      throw new ConvexError("DOCUMENT_CHECKSUM_MISMATCH");
    }

    const duplicate = await ctx.db
      .query("documentVersions")
      .withIndex("by_resourceId_and_sha256", (q) =>
        q.eq("resourceId", resource._id).eq("sha256", sha256),
      )
      .take(1);
    if (duplicate.length > 0) {
      throw new ConvexError("DUPLICATE_DOCUMENT_CHECKSUM");
    }

    const counter = await ctx.db
      .query("resourceVersionCounters")
      .withIndex("by_resourceId", (q) => q.eq("resourceId", resource._id))
      .unique();
    if (!counter || !Number.isSafeInteger(counter.nextVersionNumber) || counter.nextVersionNumber < 1) {
      throw new ConvexError("RESOURCE_VERSION_COUNTER_INVALID");
    }

    const now = Date.now();
    const version: Omit<Doc<"documentVersions">, "_id" | "_creationTime"> = {
      resourceId: resource._id,
      versionNumber: counter.nextVersionNumber,
      originalStorageId: args.storageId,
      filename,
      mimeType,
      byteSize,
      sha256,
      sourceUrl,
      effectiveDate,
      status: "draft",
      submittedBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    };
    const versionId = await ctx.db.insert("documentVersions", version);
    await ctx.db.patch(counter._id, {
      nextVersionNumber: counter.nextVersionNumber + 1,
      updatedAt: now,
    });
    const operationId = correlationId();
    await writeAudit(ctx, {
      actorId: actor.userId,
      actorRoles: actor.roles,
      action: "document.version_created",
      targetType: "documentVersion",
      targetId: versionId,
      reason: "Record governed original document",
      afterSummary: JSON.stringify({
        resourceId: resource._id,
        versionNumber: version.versionNumber,
        status: version.status,
        mimeType: version.mimeType,
        byteSize: version.byteSize,
      }),
      correlationId: operationId,
      outcome: "success",
    });
    return versionId;
  },
});
