// @vitest-environment node
import { expect, it } from "vitest";
import { chatAttachmentBackendUploadsEnabled, chatAttachmentUploadsEnabled } from "../../shared/chat-attachments";

it("keeps new production uploads off while DEV retains its existing capability", () => {
  expect(chatAttachmentUploadsEnabled({ NODE_ENV: "production" })).toBe(false);
  expect(chatAttachmentUploadsEnabled({ NODE_ENV: "development" })).toBe(true);
  expect(chatAttachmentUploadsEnabled({ NODE_ENV: "production", NEXT_PUBLIC_CHAT_ATTACHMENTS_ENABLED: "1" })).toBe(true);
});
it("requires the independent backend capability on the exact production deployment", () => {
  const production = { CONVEX_CLOUD_URL: "https://loyal-koala-720.eu-west-1.convex.cloud", CONVEX_SITE_URL: "https://loyal-koala-720.eu-west-1.convex.site" };
  expect(chatAttachmentBackendUploadsEnabled(production)).toBe(false);
  expect(chatAttachmentBackendUploadsEnabled({ ...production, CHAT_ATTACHMENTS_PRODUCTION_ENABLED: "1" })).toBe(true);
  expect(chatAttachmentBackendUploadsEnabled({ ...production, REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED: "1",
    REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED: "1" })).toBe(false);
  expect(chatAttachmentBackendUploadsEnabled({ CHAT_ATTACHMENTS_PRODUCTION_ENABLED: "1" })).toBe(false);
  expect(chatAttachmentBackendUploadsEnabled({ ...production, CONVEX_SITE_URL: "https://other.convex.site", CHAT_ATTACHMENTS_PRODUCTION_ENABLED: "1" })).toBe(false);
  expect(chatAttachmentBackendUploadsEnabled({ CONVEX_CLOUD_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.cloud",
    CONVEX_SITE_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.site" })).toBe(true);
});
