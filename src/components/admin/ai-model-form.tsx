"use client";

import { api } from "../../../convex/_generated/api";
import { ConvexError } from "convex/values";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { AI_MODEL_ID_MAX_LENGTH, type AiModelFeature } from "../../../shared/ai-models";
import { buttonClass, fieldClass, secondaryButtonClass } from "./form-styles";

export function AiModelForm({ feature, label, model, placeholder, canWrite }: {
  feature: AiModelFeature;
  label: string;
  model: string | null;
  placeholder: string;
  canWrite: boolean;
}) {
  const router = useRouter();
  const save = useMutation(api.admin.aiModels.set);
  const [value, setValue] = useState(model ?? "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  if (!canWrite) {
    return <p className="self-start text-sm text-slate-600">You can view these settings. Changing them needs the operations write permission.</p>;
  }

  async function apply(next: string | null) {
    setBusy(true);
    setMessage("");
    try {
      const saved = await save({ feature, model: next });
      setValue(saved ?? "");
      setMessage(saved ? `Saved. ${label} now uses ${saved}.` : `Cleared. ${label} is back to its default.`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof ConvexError && typeof error.data === "string" ? error.data : "The model could not be saved. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = value.trim();
    void apply(next ? next : null);
  }

  const inputId = `ai-model-${feature}`;
  return (
    <form onSubmit={submit} className="grid content-start gap-3">
      <label htmlFor={inputId} className="text-sm font-semibold">Model for {label.toLowerCase()}</label>
      <input
        id={inputId}
        name="model"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        maxLength={AI_MODEL_ID_MAX_LENGTH}
        autoComplete="off"
        spellCheck={false}
        className={`${fieldClass} font-mono`}
      />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy || value.trim() === (model ?? "")} className={buttonClass}>Save</button>
        {model ? (
          <button type="button" disabled={busy} onClick={() => void apply(null)} className={secondaryButtonClass}>Use default</button>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className="min-h-5 text-sm">{message}</p>
    </form>
  );
}
