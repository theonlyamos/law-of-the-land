/** Server constructor policy only. Never infer this from request, model or provider fields. */
export type TrustedTimingPolicy = "standard" | "background";
export type TrustedTimingBudget = Readonly<{ draftMs: 60000; verificationMs: 85000 | 240000;
  terminalMs: 110000 | 270000; gateMs: 90000 | 240000; authorityMs: 90000 | 240000 }>;
const standard: TrustedTimingBudget = Object.freeze({ draftMs: 60000, verificationMs: 85000,
  terminalMs: 110000, gateMs: 90000, authorityMs: 90000 });
const background: TrustedTimingBudget = Object.freeze({ draftMs: 60000, verificationMs: 240000,
  terminalMs: 270000, gateMs: 240000, authorityMs: 240000 });
/** Undefined preserves the ordinary app/offline budget. Null and unknown policies fail closed. */
export function captureTrustedTimingPolicy(value: unknown): TrustedTimingBudget | undefined {
  return value === undefined || value === "standard" ? standard : value === "background" ? background : undefined;
}
