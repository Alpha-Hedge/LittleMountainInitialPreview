import type { BlueprintJob, BlueprintObject, BlueprintValue } from "./blueprint-types";

function object(value: BlueprintValue | undefined): value is BlueprintObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function quoteQuantity(job: BlueprintJob, part: BlueprintObject, index: number) {
  if (typeof part.quantity !== "number" || !Number.isSafeInteger(part.quantity) || part.quantity <= 0) return null;
  const path = "parts." + index;
  if (job.flags?.some(flag => flag.path === path + ".quantity")) return null;
  const uncertain = job.flags?.some(flag => flag.path === path && flag.kind === "low_confidence");
  const staffChecked = Array.isArray(part.evidence) && part.evidence.some(entry => object(entry) &&
    entry.source === "review" && Array.isArray(entry.fields) && entry.fields.includes("quantity"));
  const accepted = job.review_log?.at(-1)?.accepted_low_confidence;
  return !uncertain || staffChecked || (Array.isArray(accepted) && accepted.includes(path)) ? part.quantity : null;
}

export function stampBlueprintReview(tree: BlueprintObject, path: string[], excerpt: string) {
  let cursor: BlueprintValue | undefined = tree;
  let owner: BlueprintObject | undefined;
  let field: string | undefined;
  for (const key of path) {
    if (object(cursor) && Array.isArray(cursor.evidence)) {
      owner = cursor;
      field = key;
    }
    cursor = Array.isArray(cursor) ? cursor[Number(key)] : object(cursor) ? cursor[key] : undefined;
  }
  if (!owner || !field || ["issues","evidence","confidence"].includes(field)) return;
  const remaining = (owner.evidence as BlueprintValue[]).filter(object).map(entry => ({
    ...entry, fields:Array.isArray(entry.fields) ? entry.fields.filter(name=>name!==field) : [],
  })).filter(entry=>entry.fields.length);
  owner.evidence = [...remaining,{source:"review",page:null,handle:null,fields:[field],excerpt:excerpt.slice(0,600)}].slice(-32);
}
