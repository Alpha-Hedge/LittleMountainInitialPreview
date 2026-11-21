import { fieldKeys, type ReviewField, type ReviewPart } from "./review-types";

function collapse(text: string) {
  return text.trim().replace(/\s+/g, " ");
}

function escapePattern(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isExcerpt(page: string, excerpt: string) {
  const value = collapse(excerpt);
  if (!value) return false;
  // Respect token boundaries so "16" cannot become a verified quote of "160".
  const escaped = escapePattern(value);
  const left = /^\w/.test(value) ? "(?<!\\w)" : "";
  const right = /\w$/.test(value) ? "(?!\\w)" : "";
  return new RegExp(left + escaped + right).test(page);
}

function combineAxes(dimensions: ReviewField) {
  if (dimensions.status !== "conflict") return;
  const values = dimensions.value.split(" | ").map((value) => value.trim());
  const measure = /^(?:\d+(?:\.\d+)?(?:\/\d+)?|\.\d+)\s*(?:mm|cm|m|in|inch|inches|ft|"|″)?$/i;
  if (values.length < 2 || !values.every((value) => measure.test(value))) return;
  const axes = new Map<string, string>();
  for (const { excerpt } of dimensions.evidence) {
    const labels = excerpt.match(/\b(?:length|width|height|depth)\b/gi) ?? [];
    const numbers = excerpt.match(/(?:\d+(?:\.\d+)?(?:\/\d+)?|\.\d+)/g) ?? [];
    if (labels.length !== 1 || numbers.length !== 1) return;
    const compact = excerpt.toLowerCase().replace(/\s+/g, "");
    const matches = values.filter((value) => {
      const magnitude = value.match(/^[\d./]+/)?.[0];
      return magnitude === numbers[0] && compact.includes(value.toLowerCase().replace(/\s+/g, ""));
    });
    if (matches.length !== 1) return;
    const axis = labels[0].toLowerCase();
    if (axes.has(axis) && axes.get(axis) !== matches[0]) return;
    axes.set(axis, matches[0]);
  }
  if (axes.size !== values.length || new Set(axes.values()).size !== values.length) return;
  dimensions.value = [...axes].map(([axis, value]) => `${axis} ${value}`).join(", ");
  dimensions.status = "found";
}

// Keep the verbatim callout. No unit, fit, tolerance, or drilling operation
// is inferred from the part dimensions or other nearby annotations.
function holeCallouts(text: string) {
  const pattern = /(?<![\w./])([1-9]\d*)\s*[x×]\s*(?:dia(?:meter)?\.?\s*|[ø⌀]\s*)(\d+\/\d+|\d*\.\d+|\d+)(?:\s*(mm|cm|inches|inch|in|"|″))?(?:\s+(thru|through)(?:\s+(all))?)?(?![\w/])/gi;
  return [...text.matchAll(pattern)].map(([excerpt, count, diameter, unit, thru, all]) => ({
    excerpt, count, diameter, unit: (unit || "").toLowerCase().replace(/^(?:inches|inch|"|″)$/, "in"),
    thru: !!thru, all: !!all,
  }));
}

function addHoleCallouts(requirements: ReviewField, pageText: string, page: number) {
  for (const callout of holeCallouts(pageText)) {
    const existing = holeCallouts(requirements.value).find((entry) =>
      entry.count === callout.count && entry.diameter === callout.diameter &&
      (!callout.unit || !entry.unit || entry.unit === callout.unit),
    );
    if (!existing) {
      requirements.value = [requirements.value, callout.excerpt].filter(Boolean).join("\n");
    } else if ((!existing.thru && callout.thru) || (!existing.all && callout.all) || (!existing.unit && callout.unit)) {
      const unit = existing.unit || callout.unit;
      const depth = existing.all || callout.all ? " THRU ALL" : existing.thru || callout.thru ? " THRU" : "";
      const replacement = `${callout.count}X DIA ${callout.diameter}${unit ? " " + unit : ""}${depth}`;
      requirements.value = requirements.value.replace(existing.excerpt, replacement);
    }
    if (requirements.status === "missing") requirements.status = "found";
    if (!requirements.evidence.some((evidence) => evidence.page === page && evidence.excerpt.includes(callout.excerpt))) {
      requirements.evidence.push({ page, excerpt: callout.excerpt, verbatim: true });
    }
  }
}

export function refineDrawingEvidence(parts: ReviewPart[], pageTexts: string[]): ReviewPart[] {
  const refined = structuredClone(parts);
  const pages = pageTexts.map(collapse);
  const owners = pages.map(() => new Set<ReviewPart>());
  for (const part of refined) {
    for (const key of fieldKeys) {
      for (const evidence of part.fields[key].evidence) {
        if (evidence.page === null) {
          evidence.verbatim = true; // Customer-message excerpts have already been checked at intake.
        } else {
          const index = evidence.page - 1;
          evidence.verbatim = isExcerpt(pages[index] ?? "", evidence.excerpt);
          owners[index]?.add(part);
        }
      }
    }
    combineAxes(part.fields.dimensions);
  }
  for (const [index, candidates] of owners.entries()) {
    if (candidates.size !== 1) continue;
    const [owner] = candidates;
    const page = index + 1;
    if (owner.fields.description.evidence.some((entry) => entry.page === page)) {
      addHoleCallouts(owner.fields.requirements, pages[index], page);
    }
  }
  return refined;
}

function addNoteQuantity(field: ReviewField, value: string, excerpt: string) {
  const equivalent = new RegExp(`^0*${value}(?:\\s*(?:ea|pcs|pieces|units))?$`, "i");
  if (field.status === "missing") {
    field.value = value;
    field.status = "found";
  } else if (!field.value.split(" | ").some((entry) => equivalent.test(entry.trim()))) {
    field.value += " | " + value;
    field.status = "conflict";
  }
  const count = new RegExp(`(?<![\\d.])${value}(?![\\d.])`);
  if (!field.evidence.some((entry) => entry.page === null && count.test(entry.excerpt))) {
    field.evidence.push({ page: null, excerpt, verbatim: true });
  }
}

export function applyExplicitNoteQuantities(parts: ReviewPart[], notes: string): ReviewPart[] {
  const reviewed = structuredClone(parts);
  // Multiple parts may share the same name. Attribute a phrase only when
  // exactly one extracted part matches it.
  const matches = new Map<number, { part: ReviewPart; excerpt: string; count: string }[]>();
  const record = (part: ReviewPart, match: RegExpExecArray) => {
    const count = match.groups!.count;
    if (Number(count) > 1_000_000_000) return;
    const start = match.index;
    const before = notes.slice(Math.max(0, start - 100), start).trimEnd();
    const after = notes.slice(start + match[0].length).trimStart();
    // Exclude dimensions, prices, identifiers, alternatives and open ranges.
    if (/(?:[$€£#~<>×/–—-]|\d\s*(?:x|by|to|or|and)|\b(?:usd|gbp|eur|up to|at least|at most|about|around|approximately|between|over|under|minimum|maximum|instead of|previously|example|not|item|line|sku|id|number|part no\.?|item no\.?|drawing no\.?|price|cost)\s*[:=]?)$/i.test(before)) return;
    if (/^(?:\+|[.,]\d|[-–—/]\s*\d|(?:or|to)\s+(?:\d|more\b|less\b|fewer\b)|(?:minimum|maximum)\b)/i.test(after)) return;
    const found = matches.get(start) ?? [];
    found.push({ part, excerpt: match[0], count });
    matches.set(start, found);
  };
  for (const part of reviewed) {
    const description = part.fields.description;
    if (description.status !== "found" || !description.value.trim()) continue;
    const name = collapse(description.value).split(" ").map(escapePattern).join("[ \\t]+");
    const pluralName = name + "(?:es|s)?";
    const count = "(?<count>[1-9]\\d*)";
    const named = new RegExp(`(?<![\\w.,/$€£#-])${count}[ \\t]+${pluralName}(?=$|[.,;:!?\\n)]|[ \\t]+(?:$|and\\b|or\\b|with\\b|for\\b|in\\b|at\\b|to\\b|per\\b|please\\b|minimum\\b|maximum\\b))`, "gi");
    for (const match of notes.matchAll(named)) record(part, match);
    const namedField = new RegExp(`(?<!\\w)${pluralName}[ \\t]*[:,(–-]?[ \\t]*(?:qty\\.?|quantity)[ \\t]*[:=]?[ \\t]*${count}(?=$|[.,;!?)\\n]|[ \\t]+(?:and\\b|or\\b|to\\b|for\\b|units?\\b|pcs\\b))`, "gi");
    for (const match of notes.matchAll(namedField)) record(part, match);
  }
  for (const candidates of matches.values()) {
    if (candidates.length === 1) {
      const { part, excerpt, count } = candidates[0];
      addNoteQuantity(part.fields.quantity, count, excerpt);
    }
  }
  if (reviewed.length === 1) {
    // Standalone single-part order field, delimited as a complete field.
    const quantityField = /(?:^|[\n;,])\s*((?:(?:order(?:ed)?|requested)\s+)?(?:qty\.?|quantity)\s*[:=]\s*([1-9]\d*)(?:[ \t]+(?:pcs|pieces|units))?)[ \t]*(?=$|[\n;]|[,.](?!\d))/gi;
    for (const match of notes.matchAll(quantityField)) {
      if (Number(match[2]) <= 1_000_000_000) addNoteQuantity(reviewed[0].fields.quantity, match[2], match[1]);
    }
  }
  return reviewed;
}
