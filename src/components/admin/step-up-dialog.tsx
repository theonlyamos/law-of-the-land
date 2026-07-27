"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

type StepUpDialogProps = {
  open: boolean;
  title: string;
  description: string;
  submitLabel: string;
  targetId: string;
  idempotencyKey: string;
  stepUpAction?: string;
  confirmationPhrase?: string;
  onClose: () => void;
  onConfirmed: (input: {
    reason: string;
    confirmation?: string;
  }) => Promise<void>;
};

export function StepUpDialog({
  open,
  title,
  description,
  submitLabel,
  targetId,
  idempotencyKey,
  stepUpAction,
  confirmationPhrase,
  onClose,
  onConfirmed,
}: StepUpDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    }
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "working") return;
    setStatus("working");
    setError("");
    const formData = new FormData(event.currentTarget);
    const reason = String(formData.get("reason") ?? "").trim();
    const confirmation = confirmationPhrase
      ? String(formData.get("confirmation") ?? "")
      : undefined;
    try {
      if (stepUpAction) {
        const password = String(formData.get("password") ?? "");
        const response = await fetch("/api/auth/verify-password", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            "x-admin-step-up-action": stepUpAction,
            "x-admin-step-up-target": targetId,
            "x-admin-step-up-key": idempotencyKey,
          },
          body: JSON.stringify({ password }),
        });
        const passwordInput = formRef.current?.elements.namedItem("password");
        if (passwordInput instanceof HTMLInputElement) {
          passwordInput.value = "";
        }
        if (!response.ok) {
          throw new Error(
            "Your password could not be verified. Check it and try again.",
          );
        }
      }
      await onConfirmed({ reason, confirmation });
      formRef.current?.reset();
      setStatus("idle");
      onClose();
    } catch (caught) {
      setStatus("error");
      setError(
        caught instanceof Error
          ? caught.message
          : "The action could not be completed. Try again.",
      );
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="admin-step-up-title"
      aria-describedby="admin-step-up-description"
      onCancel={(event) => {
        event.preventDefault();
        if (status !== "working") onClose();
      }}
      className="m-auto w-[min(42rem,calc(100%-2rem))] border border-[oklch(52%_0.04_252)] bg-[oklch(97%_0.012_82)] p-0 text-[oklch(24%_0.035_252)] shadow-[0_1.5rem_4rem_oklch(20%_0.03_252_/_0.25)] backdrop:bg-[oklch(18%_0.035_252_/_0.68)]"
    >
      <form ref={formRef} onSubmit={submit} className="grid gap-6 p-6 sm:p-8">
        <header className="border-b border-[oklch(75%_0.03_78)] pb-5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[oklch(45%_0.06_65)]">
            Account authority
          </p>
          <h2
            id="admin-step-up-title"
            className="mt-2 text-2xl font-semibold tracking-[-0.035em]"
          >
            {title}
          </h2>
          <p
            id="admin-step-up-description"
            className="mt-3 max-w-[58ch] text-sm leading-6 text-[oklch(39%_0.035_252)]"
          >
            {description}
          </p>
        </header>

        <label className="grid gap-2 text-sm font-semibold">
          Reason for this action
          <textarea
            name="reason"
            required
            minLength={3}
            maxLength={500}
            rows={3}
            className="min-h-24 resize-y border border-[oklch(62%_0.035_252)] bg-[oklch(99%_0.007_82)] px-3 py-3 font-normal leading-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
          />
        </label>

        {confirmationPhrase ? (
          <div className="grid gap-2">
            <p className="text-sm leading-6">
              Type <strong>{confirmationPhrase}</strong> to continue.
            </p>
            <label className="grid gap-2 text-sm font-semibold">
              Exact confirmation
              <input
                name="confirmation"
                required
                autoComplete="off"
                className="min-h-11 border border-[oklch(62%_0.035_252)] bg-[oklch(99%_0.007_82)] px-3 font-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
              />
            </label>
          </div>
        ) : null}

        {stepUpAction ? (
          <label className="grid gap-2 text-sm font-semibold">
            Confirm your password
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="min-h-11 border border-[oklch(62%_0.035_252)] bg-[oklch(99%_0.007_82)] px-3 font-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
            />
          </label>
        ) : null}

        {status === "error" ? (
          <p
            role="alert"
            className="border-y border-[oklch(62%_0.11_28)] bg-[oklch(93%_0.035_28)] px-4 py-3 text-sm text-[oklch(34%_0.1_28)]"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={status === "working"}
            onClick={onClose}
            className="min-h-11 px-5 text-sm font-semibold underline decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:opacity-50"
          >
            Keep this user unchanged
          </button>
          <button
            type="submit"
            disabled={status === "working"}
            className="min-h-11 bg-[oklch(28%_0.055_252)] px-5 text-sm font-semibold text-[oklch(97%_0.012_82)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:opacity-60"
          >
            {status === "working" ? "Verifying and applying…" : submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
