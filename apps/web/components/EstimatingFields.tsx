import type { ReactNode } from "react";
import type { CostBasis } from "@/lib/types";

export function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={"field" + (wide ? " est-wide" : "")}><span>{label}</span>{children}</label>;
}

export function DecimalField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return <Field label={label}><input type="number" min="0" max="1000000000" step="0.0001" required
    value={Number.isFinite(value) ? value : ""} onChange={e => onChange(e.target.valueAsNumber)} /></Field>;
}

export function BasisField({ value, onChange }: { value: CostBasis; onChange: (v: CostBasis) => void }) {
  return <Field label="Count this cost"><select value={value} onChange={e => onChange(e.target.value as CostBasis)}>
    <option value="batch">Once for the whole batch</option><option value="per_unit">For each piece</option>
  </select></Field>;
}

export const formatUSD = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD" });
export const formatRate = (value: number) => value.toLocaleString("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4,
});
