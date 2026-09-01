export const ADMIN_STEP_UP_MAX_AGE_MS = 5 * 60 * 1_000;

export const ADMIN_STEP_UP_ACTIONS = new Set([
  "roles_assign",
  "impersonation_start",
  "user_deletion_queue",
  "conversation_export",
  "document_publish",
  "document_unpublish",
  "document_rollback",
  "admin_panel_set",
  "unified_jurisdictions_set",
] as const);

export const ADMIN_STEP_UP_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export function isAdminStepUpAction(value: string): boolean {
  return ADMIN_STEP_UP_ACTIONS.has(value as never);
}
