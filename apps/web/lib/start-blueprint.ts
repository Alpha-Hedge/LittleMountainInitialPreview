import type { BlueprintObject } from "./blueprint-types";

async function request(path: string, body: BodyInit, contentType: string) {
  const response = await fetch("/api/blueprints/" + path, {
    method: "POST", headers: { "content-type": contentType }, body,
  });
  const result = await response.json();
  if (!response.ok) {
    const error = Array.isArray(result.detail) ? result.detail.map((entry: {msg?:string}) => entry.msg).filter(Boolean).join(". ") : result.detail;
    throw new Error(error || "The detailed drawing reader could not start. Try again.");
  }
  return result as { id: string };
}

export async function startBlueprint(file: File, key: string, options: {
  notes: string; customer?: string; name?: string; parent?: string; revision?: number; settings?: BlueprintObject | null;
}) {
  const format = /\.pdf$/i.test(file.name) ? "application/pdf" : "application/dxf";
  const query = new URLSearchParams({
    drawing_key: options.parent || key, revision: String(options.parent ? options.revision : 1), filename: file.name,
  });
  const source = await request("drawings?" + query, file, format);
  const result = await request("jobs", JSON.stringify({
    drawing_id: source.id, request_key: key, notes: options.notes,
    ...(options.settings ? { settings: options.settings } : {}),
    ...(options.customer?.trim() ? { customer_name: options.customer.trim() } : {}),
    ...(options.name?.trim() ? { job_name: options.name.trim() } : {}),
  }), "application/json");
  return "/blueprints/" + result.id;
}
