import type { PublicJurisdiction } from "@/lib/countries";
import { cn } from "@/lib/utils";

interface PublicJurisdictionSelectorProps {
  id: string;
  label: string;
  jurisdictions: readonly PublicJurisdiction[] | undefined;
  value: string;
  onChange: (code: string) => void;
  className?: string;
}

export function PublicJurisdictionSelector({
  id,
  label,
  jurisdictions,
  value,
  onChange,
  className,
}: PublicJurisdictionSelectorProps) {
  const isLoading = jurisdictions === undefined;
  const isEmpty = jurisdictions?.length === 0;

  return (
    <label className={cn("grid gap-2 text-sm font-medium", className)} htmlFor={id}>
      <span>{label}</span>
      <select
        id={id}
        value={value}
        disabled={isLoading || isEmpty}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 w-full border border-input bg-transparent px-3 text-inherit focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isLoading ? <option value="">Loading available jurisdictions…</option> : null}
        {isEmpty ? <option value="">No jurisdictions are available</option> : null}
        {jurisdictions?.map((item) => (
          <option key={item.code} value={item.code}>
            {item.name}
          </option>
        ))}
      </select>
    </label>
  );
}
