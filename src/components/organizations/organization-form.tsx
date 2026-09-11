"use client";
import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id, Doc } from "@/convex/_generated/dataModel";
import {
  fieldClass,
  labelClass,
  buttonClass,
} from "@/components/admin/form-styles";
type Values = {
  name: string;
  class: Doc<"organizations">["class"];
  website?: string;
};
export function OrganizationForm({
  organizationId,
  initial,
  onSaved,
}: {
  organizationId?: Id<"organizations">;
  initial?: Values;
  onSaved: (id: Id<"organizations">) => void;
}) {
  const create = useMutation(api.organizations.createOrganization),
    update = useMutation(api.organizations.updateOrganization);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const request = useRef<{ input: string; key: string } | null>(null);
  return (
    <form
      className="grid max-w-2xl gap-5 border border-[oklch(74%_0.028_78)] bg-[oklch(96%_0.014_82)] p-5 sm:p-7"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const input: Values = {
          name: String(form.get("name")).trim(),
          class: form.get("class") as Values["class"],
          website: String(form.get("website") ?? "").trim() || undefined,
        };
        const serialized = JSON.stringify(input);
        if (request.current?.input !== serialized)
          request.current = {
            input: serialized,
            key: `org_${crypto.randomUUID()}`,
          };
        setBusy(true);
        setError("");
        try {
          if (organizationId) {
            await update({ ...input, organizationId });
            onSaved(organizationId);
          } else
            onSaved(
              await create({ ...input, idempotencyKey: request.current.key }),
            );
        } catch {
          setError(
            "Could not save this organization. Check the fields, verify your email and two-factor sign-in, then retry. You can own up to five active organizations.",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className={labelClass}>
        Organization name
        <input
          name="name"
          defaultValue={initial?.name}
          required
          maxLength={300}
          className={fieldClass}
        />
      </label>
      <label className={labelClass}>
        Organization type
        <select
          name="class"
          defaultValue={initial?.class ?? "company"}
          className={fieldClass}
        >
          {[
            "intergovernmental",
            "government",
            "company",
            "university",
            "nonprofit",
            "professional_association",
            "other",
          ].map((value) => (
            <option key={value} value={value}>
              {value.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Website (optional)
        <input
          name="website"
          defaultValue={initial?.website}
          type="url"
          placeholder="https://example.org"
          maxLength={500}
          className={fieldClass}
        />
      </label>
      <p className="text-sm">Use your organization's HTTPS website address.</p>
      <button className={buttonClass} disabled={busy}>
        {busy
          ? "Saving…"
          : organizationId
            ? "Save organization"
            : "Create organization"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      )}
    </form>
  );
}
