import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepUpDialog } from "./step-up-dialog";

afterEach(cleanup);

describe("step-up dialog accessibility", () => {
  it("associates each dialog with its own title and description", () => {
    const onConfirmed = vi.fn(async () => {});
    const { container } = render(
      <>
        <StepUpDialog
          open={false}
          title="Admin recovery"
          description="Admin recovery description"
          submitLabel="Apply admin recovery"
          targetId="admin_panel:preview"
          idempotencyKey="admin-recovery-key"
          onClose={() => {}}
          onConfirmed={onConfirmed}
        />
        <StepUpDialog
          open={false}
          title="Unified jurisdictions"
          description="Unified jurisdictions description"
          submitLabel="Apply unified jurisdictions"
          targetId="unified_jurisdictions:preview"
          idempotencyKey="unified-jurisdictions-key"
          onClose={() => {}}
          onConfirmed={onConfirmed}
        />
      </>,
    );

    const dialogs = Array.from(container.querySelectorAll("dialog"));
    const titleIds = dialogs.map((dialog) => dialog.getAttribute("aria-labelledby"));
    const descriptionIds = dialogs.map((dialog) =>
      dialog.getAttribute("aria-describedby"),
    );

    expect(new Set(titleIds).size).toBe(2);
    expect(new Set(descriptionIds).size).toBe(2);
    expect(document.getElementById(titleIds[0]!)).toHaveTextContent("Admin recovery");
    expect(document.getElementById(titleIds[1]!)).toHaveTextContent("Unified jurisdictions");
    expect(document.getElementById(descriptionIds[0]!)).toHaveTextContent(
      "Admin recovery description",
    );
    expect(document.getElementById(descriptionIds[1]!)).toHaveTextContent(
      "Unified jurisdictions description",
    );
  });
});
