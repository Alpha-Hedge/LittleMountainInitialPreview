import { randomUUID } from "node:crypto";
import { QuoteError } from "./quotes";
import type { AssistantChange, AssistantKind } from "./review-assistant-types";
import type { RateRevision } from "./estimating-types";
import type { BlueprintObject } from "./blueprint-types";
import { stampBlueprintReview } from "./blueprint-review-evidence";

type RecordValue = Record<string, unknown>;
export type ProposedEdit = { action: "set" | "add"; path: string; value: string; evidence: string };

const field = "[a-z][a-zA-Z0-9_]*";
const index = "(?:0|[1-9][0-9]{0,2})";
const pattern = (s: string) => new RegExp("^" + s.replaceAll("#", index) + "$");
const quoteSet = pattern("(?:customer|jobName|notes|marginPercent|scrapBufferPct|items\\.#\\.(?:description|quantity|costRows\\.#\\.(?:label|amount|rate|basis)))");
const bpSet = pattern("(?:source_units|drawing_revision|parts\\.#\\.(?:description|quantity|material_family|material_grade|stock_form|section_designation|gauge_designation|thickness_in|dimension_basis|development_axis|finish|requirements\\.#|outline\\.(?:kind|width_in|height_in|corner_radius_in|vertices\\.#\\.[xy])|holes\\.#\\.(?:shape|cutting_method|diameter_in|length_in|width_in|angle_deg|center_x_in|center_y_in|count)|bends\\.#\\.(?:angle_deg|inside_radius_in|length_in|count|tool_id|(?:start_in|end_in)(?:\\.[xy])?)|welds\\.#\\.(?:process|joint_type|joint_configuration|size_in|length_in|increment_in|pitch_in|position|count|sides|all_around|field_weld|cross_section_area_in2|stitches_per_side)))");
const sketchSet = pattern("(?:title|units|parts\\.#\\.(?:name|shape|annotations\\.#\\.value|holes\\.#\\.shape|vertices\\.#\\.[xy]))");
const quoteAdd = pattern("(?:items|items\\.#\\.costRows)");
const bpAdd = pattern("(?:parts|parts\\.#\\.(?:holes|bends|welds|requirements|outline\\.vertices))");
const sketchAdd = pattern("(?:parts|parts\\.#\\.(?:annotations|holes|bends|vertices))");
const safePath = new RegExp("^" + field + "(?:\\.(?:" + field + "|" + index + ")){0,7}$");
const sketchKinds = new Set("width height radius material thickness quantity x y from_right from_top dx dy length angle center_x center_y hole_callout diameter slot_width slot_length slot_angle bend_angle bend_direction weld note".split(" "));

const object = (v: unknown): v is RecordValue => v !== null && typeof v === "object" && !Array.isArray(v);

function reject(message = "The assistant returned an invalid edit. Try a more specific instruction."): never {
  throw new QuoteError(message, 422);
}

function access(root: RecordValue, keys: string[]) {
  let value: unknown = root;
  for (const key of keys) {
    if ((!object(value) && !Array.isArray(value)) || !Object.hasOwn(value, key)) reject("The suggested edit points to a feature that is no longer on this draft.");
    value = (value as RecordValue)[key];
  }
  return value;
}

function display(value: unknown): string {
  if (value == null) return "Unspecified";
  if (typeof value === "string") return value.slice(0, 240);
  if (!object(value)) return String(value);
  if (typeof value.kind === "string" && typeof value.value === "string") return value.kind + " · " + value.value;
  return Object.entries(value).filter(([key, v]) => !["id","evidence","confidence","issues","at","costRows","annotations"].includes(key)
    && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
    .slice(0, 7).map(([key, v]) => key.replaceAll("_", " ") + " " + v).join(" · ") || "New feature";
}

function readable(path: string) {
  const names: Record<string,string> = {marginPercent:"Target margin (%)",costRows:"Costs",items:"Quote lines",rate:"Unit rate",jobName:"Job name",amount:"Amount",width_in:"Width (in)",height_in:"Height (in)",diameter_in:"Diameter (in)",annotations:"Readings",scrapBufferPct:"Scrap allowance (%)"};
  return path.split(".").map(key=>/^\d+$/.test(key) ? String(Number(key)+1) : names[key] || key.replaceAll("_"," ")).join(" › ");
}

function operatorSupplied(rate: unknown, instruction: string) {
  if (typeof rate !== "number") return false;
  const stated = /(?:[$]|\bUSD\s+|\b(?:rate|price)\s*(?:is\s+|to\s+|of\s+)?)(\d+(?:\.\d+)?|\.\d+)|\b(\d+(?:\.\d+)?|\.\d+)\s*(?:dollars|USD)\b/gi;
  return [...instruction.replaceAll(",","").matchAll(stated)].some(match=>Number(match[1] ?? match[2])===rate);
}

function makeAddition(kind: AssistantKind, key: string, value: unknown, excerpt: string, instruction: string, rates: Map<string, RateRevision>) {
  if (kind === "blueprint" && key === "requirements" && typeof value === "string" && value.trim()) return value.trim();
  if (!object(value)) reject();
  if (kind === "quote") {
    if (key === "items") return { id: randomUUID(), description: value.description, quantity: value.quantity, costRows: [] };
    const saved = typeof value.rateId === "string" ? rates.get(value.rateId) : undefined;
    if (!saved && !operatorSupplied(value.rate,instruction)) reject("This cost needs a shop rate or the exact rate you want to use.");
    const id = randomUUID();
    return { id, label: value.label, amount: value.amount, rate: saved?.value ?? value.rate, basis: value.basis,
      ...(saved ? {estimate:{category:saved.category,unit:saved.unit,includes:saved.includes,minimumCost:saved.minimumCost,
        settingsVersion:saved.version,rateSource:saved.source,rateEffectiveOn:saved.effectiveOn,rateSettingsVersion:saved.version,
        rateId:saved.id,templateId:"shop-assistant",templateName:"Shop assistant",operationId:id,workType:saved.name,
        driver:"fixed",coefficient:1,rationale:excerpt,assumption:"Quoted using the dated shop rate.",overrideReason:"",
        baselineAmount:value.amount,baselineRate:saved.value,demo:saved.demo,reviewedRevisionId:null,reviewRunId:null}} : {}) };
  }
  if (key === "vertices") return {x:value.x,y:value.y};
  if (kind === "sketch") {
    const at = object(value.at) ? value.at : {x: 500, y: 500};
    if (key === "annotations") {
      if (typeof value.kind !== "string" || !sketchKinds.has(value.kind) || typeof value.value !== "string"
        || !Array.isArray(value.targets) || !value.targets.length) reject();
      return { kind:value.kind, value:value.value.trim(), targets:value.targets, at, confidence: 1, evidence: value.value + " · " + excerpt };
    }
    if (key === "parts") return {name:value.name,part_id:value.part_id,shape:value.shape,vertices:value.vertices ?? [],
      candidate:null,annotations:[],holes:[],bends:[],questions:[],confidence:0.85};
    if (key === "holes") return { shape: value.shape, at, candidate: null, confidence: 1 };
    return { start: value.start, end: value.end, candidate: null, confidence: 1 };
  }
  const base = {confidence:1, issues:[], evidence: [] as object[]};
  const fieldsByKind: Record<string, string[]> = {
    parts: ["part_id","description","quantity","material_family","material_grade","stock_form","section_designation","gauge_designation","thickness_in","dimension_basis","development_axis","finish"],
    holes: ["shape","cutting_method","center_x_in","center_y_in","diameter_in","length_in","width_in","angle_deg","count"],
    bends: ["start_in","end_in","tool_id","angle_deg","inside_radius_in","length_in","count"],
    welds: ["process","joint_type","joint_configuration","size_in","length_in","increment_in","pitch_in","position","count","sides","all_around","field_weld","cross_section_area_in2","stitches_per_side"],
  };
  const fields = Object.fromEntries(fieldsByKind[key].filter(k => Object.hasOwn(value,k)).map(k=>[k,value[k]]));
  const node = {...base, ...fields};
  if (Object.keys(fields).length) base.evidence.push({source:"review",page:null,handle:null,excerpt,fields:Object.keys(fields)});
  if (key !== "parts") return node;
  const outline = object(value.outline) ? value.outline : {};
  const geometry = Object.fromEntries(["kind","width_in","height_in","corner_radius_in","vertices"].filter(k=>Object.hasOwn(outline,k)).map(k=>[k,outline[k]]));
  return { ...node, part_id: fields.part_id || ("Part " + randomUUID().slice(0,8)), holes:[], bends:[], welds:[], requirements:[],
    outline: {...base, kind:"unknown",...geometry,evidence: Object.keys(geometry).length ? [{source:"review",page:null,handle:null,excerpt,fields:Object.keys(geometry)}] : []} };
}

export function applyAssistantEdits(
  kind: AssistantKind, state: RecordValue, edits: ProposedEdit[], instruction: string, rates = new Map<string,RateRevision>(),
  allowSourceEdits = true,
) {
  const draft = structuredClone(state);
  const changes: AssistantChange[] = [];
  const paths: string[] = [];
  for (const edit of edits) {
    if (!allowSourceEdits) reject("This drawing is marked for review. You can ask questions about it here.");
    if (!safePath.test(edit.path) || edit.path.split(".").some(k=>["__proto__","prototype","constructor"].includes(k))) reject();
    const add = edit.action === "add";
    const allowed = kind === "quote" ? (add?quoteAdd:quoteSet) : kind === "blueprint" ? (add?bpAdd:bpSet) : (add?sketchAdd:sketchSet);
    if (!allowed.test(edit.path)) reject("That edit is outside this review. Ask about dimensions, specifications or pricing inputs.");
    let decoded: unknown;
    try { decoded = JSON.parse(edit.value); } catch { reject(); }
    const evidence = (edit.evidence.trim() || instruction).slice(0, 550);
    const keys = edit.path.split(".");
    const key = keys.at(-1)!;
    if (add) {
      const target = access(draft, keys);
      if (!Array.isArray(target) || target.length >= 240) reject();
      const entry = makeAddition(kind,key,decoded,evidence,instruction,rates);
      target.push(entry);
      if (kind==="blueprint" && (key==="requirements" || key==="vertices"))
        stampBlueprintReview(draft as BlueprintObject, keys, evidence);
      paths.push(edit.path + "." + (target.length - 1));
      changes.push({label: readable(edit.path), before: "—", after: display(entry), evidence});
      continue;
    }
    const host = keys.length===1 ? draft : access(draft,keys.slice(0,-1));
    if (!object(host) && !Array.isArray(host)) reject();
    const target = host as RecordValue;
    if (object(decoded) && !(kind==="blueprint" && (key==="start_in"||key==="end_in"))) reject();
    if (Array.isArray(decoded) || Array.isArray(host) && !Object.hasOwn(host,key)) reject();
    if (kind==="quote" && key==="rate" && !operatorSupplied(decoded,instruction) &&
        ![...rates.values()].some(rate=>rate.value===decoded)) reject("Enter the exact rate you want to use or choose a current shop rate.");
    if (target[key] === decoded) continue;
    changes.push({label:readable(edit.path),before:display(target[key]),after:display(decoded),evidence});
    target[key]=decoded;
    if (kind==="blueprint") stampBlueprintReview(draft as BlueprintObject, keys, evidence);
    if (kind==="sketch" && key==="value") {
      if (typeof decoded !== "string" || !decoded.trim()) reject();
      target.evidence = decoded.trim() + " · " + evidence;
      target.confidence = 1;
    }
    if (kind==="sketch" && key==="units") {
      if (decoded==="in" || decoded==="mm") { draft.unit_evidence = decoded; draft.unit_confidence = 1; }
      else reject("Choose inches or millimeters.");
    }
    if (kind==="quote" && keys.includes("costRows") && ["amount","rate","basis"].includes(key)) {
      if (object(target.estimate)) target.estimate.overrideReason = instruction.slice(0,2000);
      if (object(target.review)) {
        target.review = {...target.review, reason:instruction.slice(0,2000)};
        if (key !== "basis") delete (target.review as RecordValue).unitCost;
      } else target.review = {reason:instruction.slice(0,2000),disposition:"standard"};
    }
    paths.push(edit.path);
  }
  return {draft, changes,paths};
}
