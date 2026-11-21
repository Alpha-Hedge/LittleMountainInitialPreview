export const fieldKeys = [
  "description", "material", "thickness", "dimensions", "units",
  "quantity", "finish", "revision", "requirements",
] as const;

export type FieldKey = (typeof fieldKeys)[number];

export interface ReviewField {
  value: string;
  status: "found" | "missing" | "conflict";
  evidence: { page: number | null; excerpt: string; verbatim?: boolean }[];
}

export interface ReviewPart {
  fields: Record<FieldKey, ReviewField>;
}

export interface PartCorrection {
  selected: boolean;
  values: Partial<Record<FieldKey, string>>;
  targetItemId?: string | null;
}

export interface ReviewRun {
  id: string;
  quoteId: string;
  revisionId: string;
  quoteVersion: number;
  notes: string;
  provider: string;
  model: string;
  parts: ReviewPart[];
  corrections: PartCorrection[];
  editVersion: number;
  createdAt: string;
  appliedAt: string | null;
}

export const fieldLabels: Record<FieldKey, string> = {
  description: "Description", material: "Material / grade", thickness: "Thickness",
  dimensions: "Dimensions", units: "Units", quantity: "Quantity", finish: "Finish",
  revision: "Drawing revision", requirements: "Other requirements",
};
