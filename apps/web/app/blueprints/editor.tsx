"use client";
import { useEffect, useId, useState, type ReactNode } from "react";
import { EngineeringCanvas } from "@/components/BlueprintCanvas";
import { Icon } from "@/components/Icons";
import ReviewAssistant from "@/components/ReviewAssistant";
import { quoteQuantity, stampBlueprintReview } from "@/lib/blueprint-review-evidence";
import { SourceReview, type ScopeDecisions } from "./source-review";
import { ReviewPicker } from "./review-picker";
import { openReviewSection, partIndex, reviewTopic, type OpenCheck, type ReviewTab } from "./review-topics";
import type {
  BlueprintJob,
  BlueprintObject,
  BlueprintValue,
} from "@/lib/blueprint-types";

export const fieldName = (name: string) =>
  (names[name] || name.replaceAll("_", " ")).replace(/^./, (s) =>
    s.toUpperCase(),
  );
function featureName(path: string) {
  return path
    .split(".")
    .map((k) => (/^\d+$/.test(k) ? String(Number(k) + 1) : fieldName(k)))
    .join(" ");
}
const names: Record<string, string> = {
  source_units: "Drawing units",
  part_id: "Part number",
  material_family: "Material family",
  material_grade: "Material grade",
  quantity: "Quantity",
  stock_form: "Stock shape",
  section_designation: "Section designation",
  gauge_designation: "Written sheet gauge",
  source_release_hold: "Drawing issue status",
  all_around: "Weld all around",
  field_weld: "Field weld",
  joint_configuration: "Joint configuration",
  thickness_in: "Thickness (in)",
  width_in: "Width (in)",
  height_in: "Height (in)",
  length_in: "Length (in)",
  corner_radius_in: "Corner radius (in)",
  dimension_basis: "How the part was dimensioned",
  kind: "Profile shape",
  cutting_method: "How the opening is made",
  process: "Welding process",
  joint_type: "Weld type",
  position: "Weld position",
  inside_radius_in: "Inside bend radius (in)",
  drawing_revision: "Revision on drawing",
  center_x_in: "Hole center X (in)",
  center_y_in: "Hole center Y (in)",
  parts: "Part",
  holes: "Opening",
  bends: "Bend",
  welds: "Weld",
  vertices: "Profile corner",
  gross_margin_pct: "Target gross margin (%)",
  demo: "Demo shop rates",
  snapshot_name: "Name of this rate card",
  size_in: "Weld size (in)",
  pitch_in: "Stitch pitch (in)",
  increment_in: "Stitch length (in)",
  angle_deg: "Angle (degrees)",
  sheet_width_in: "Sheet width (in)",
  sheet_height_in: "Sheet height (in)",
  hourly_rate: "Hourly rate ($)",
};
const enums: Record<string, string[]> = {
  source_units: ["in", "mm", "mixed", "unknown"],
  dimension_basis: ["flat", "outside_flange_sum", "unknown"],
  kind: ["rectangle", "polygon", "unknown"],
  shape: ["round", "slot", "unknown"],
  cutting_method: ["cut", "drill", "unknown"],
  stock_form: ["plate", "sheet", "tube", "angle", "channel", "beam", "bar", "pipe", "assembly", "other"],
  process: ["GMAW", "GTAW", "FCAW", "SMAW"],
  joint_type: ["fillet", "groove", "plug", "slot", "other"],
  joint_configuration: ["butt", "tee", "lap", "corner", "edge", "other"],
  development_axis: ["width", "height"],
  position: ["1F", "2F", "3F", "4F", "1G", "2G", "3G", "4G", "5G", "6G"],
};
const numeric =
  /(_in2?|_deg|^x$|^y$|^count$|^quantity$|^sides$|^stitches_per_side$)/;
const obj = (v: BlueprintValue | undefined): v is BlueprintObject =>
  !!v && typeof v === "object" && !Array.isArray(v);
const clone = (v: BlueprintObject) => structuredClone(v);
const newFeature = () => ({ confidence: 1, evidence: [], issues: [] });
const newOutline = () => ({ ...newFeature(), kind: "unknown", width_in: null, height_in: null, corner_radius_in: null, vertices: [] });
const additions: Record<string, { label: string; make: (length: number) => BlueprintValue }> = {
  parts: { label: "Add a missing part", make: n => ({ ...newFeature(), part_id: "New part " + (n + 1),
    description: null, quantity: null, material_family: null, material_grade: null, stock_form: null,
    section_designation: null, gauge_designation: null, thickness_in: null, dimension_basis: "unknown",
    development_axis: null, outline: newOutline(), holes: [], bends: [], welds: [], finish: null, requirements: [] }) },
  holes: { label: "Add a hole or slot", make: () => ({ ...newFeature(), shape: "unknown", cutting_method: "unknown", count: 1,
    center_x_in: null, center_y_in: null, diameter_in: null, length_in: null, width_in: null, angle_deg: null }) },
  bends: { label: "Add a bend", make: () => ({ ...newFeature(), angle_deg: null, length_in: null,
    inside_radius_in: null, tool_id: null, count: 1, start_in: null, end_in: null }) },
  welds: { label: "Add a weld", make: () => ({ ...newFeature(), process: null, joint_type: null, joint_configuration: null,
    size_in: null, length_in: null, increment_in: null, pitch_in: null, position: null, sides: null, count: 1,
    all_around: null, field_weld: null, cross_section_area_in2: null, stitches_per_side: null }) },
  vertices: { label: "Add a profile corner", make: () => ({ x: null, y: null }) },
  requirements: { label: "Add a shop requirement", make: () => "" },
};
function node(tree: BlueprintObject, path: string[]) {
  let v: BlueprintValue | undefined = tree;
  for (const key of path) v = Array.isArray(v) ? v[Number(key)] : v && obj(v) ? v[key] : undefined;
  return v;
}
function Fields({
  value,
  path,
  onChange,
  settings = false,
}: {
  value: BlueprintValue;
  path: string[];
  onChange: (p: string[], v: BlueprintValue) => void;
  settings?: boolean;
}) {
  const key = path.at(-1) || "";
  if (["evidence", "confidence","page_anchor","page_frame","field_locations","source_release_hold"].includes(key) && !settings) return null;
  if (!settings && (key==="start_in"||key==="end_in") && value===null) return <button type="button" onClick={()=>onChange(path,{x:null,y:null})}>Enter bend {key==="start_in"?"start":"end"} coordinates (in)</button>;
  if (Array.isArray(value)) {
    if (key === "issues")
      return value.length ? (
        <div>
          {value.map((issue, i) => (
            <div className="bp-issue" key={i}>
              {String(issue)}{" "}
              <button
                type="button"
                onClick={() =>
                  onChange(
                    path,
                    value.filter((_, n) => n !== i),
                  )
                }
              >
                Mark resolved
              </button>
            </div>
          ))}
        </div>
      ) : null;
    const addition = !settings ? additions[key] : undefined;
    if (!value.length && !addition) return null;
    return (
      <div>
        {value.map((child, i) =>
          obj(child) ? (
            <details
              className="bp-fold"
              key={i}
              open={key === "parts" && i === 0 ? true : undefined}
            >
              <summary>
                {String(
                  child.part_id || child.name || fieldName(key) + " " + (i + 1),
                )}
              </summary>
              <Fields
                value={child}
                path={[...path, String(i)]}
                onChange={onChange}
                settings={settings}
              />
            </details>
          ) : (
            <Fields
              key={i}
              value={child}
              path={[...path, String(i)]}
              onChange={onChange}
              settings={settings}
            />
          ),
        )}
        {addition && <button type="button" onClick={() => onChange(path, [...value, addition.make(value.length)])}>{addition.label}</button>}
      </div>
    );
  }
  if (obj(value)) {
    const view = path.at(-2)==="bends" ? {start_in:null,end_in:null,...value} : value;
    const entries = Object.entries(view);
    const sources = Array.isArray(value.evidence)
      ? value.evidence.filter(obj)
      : [];
    const children = (
      <div className="bp-fields">
        {entries.map(([k, v]) => (
          <Fields
            key={k}
            value={v}
            path={[...path, k]}
            onChange={onChange}
            settings={settings}
          />
        ))}
        {!!sources.length && (
          <details className="bp-fold">
            <summary>Where these values came from</summary>
            <ul>
              {sources.map((s, i) => (
                <li key={i}>
                  <b>
                    {s.source === "pdf"
                      ? "Page " + s.page
                      : s.source === "dxf"
                        ? "DXF entity " + s.handle
                        : s.source === "review"
                          ? "Staff review"
                          : "Customer notes"}
                  </b>{" "}
                  · {String(s.excerpt)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    );
    return path.length && !/^\d+$/.test(key) ? (
      <details className="bp-fold">
        <summary>{fieldName(key)}</summary>
        {children}
      </details>
    ) : (
      children
    );
  }
  if (!settings && (key === "all_around" || key === "field_weld")) {
    return (
      <label>
        {fieldName(key)}
        <select value={value === null ? "" : String(value)} onChange={(e) => onChange(path, e.target.value ? e.target.value === "true" : null)}>
          <option value="">Unspecified</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </label>
    );
  }
  if (typeof value === "boolean")
    return (
      <label>
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(path, e.target.checked)}
        />{" "}
        {fieldName(key)}
      </label>
    );
  const options = settings ? undefined : enums[key];
  const number =
    typeof value === "number" ||
    (!settings && value === null && numeric.test(key));
  return (
    <label>
      {path.at(-2) === "requirements" ? "Shop requirement " + (Number(key) + 1) : fieldName(key)}
      {options ? (
        <select
          value={String(value ?? "")}
          onChange={(e) => onChange(path, e.target.value || null)}
        >
          <option value="">Choose…</option>
          {options.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      ) : (
        <input
          value={value === null ? "" : String(value)}
          placeholder={value === null ? "Unspecified" : undefined}
          type={number ? "number" : "text"}
          step={number ? "any" : undefined}
          onChange={(e) =>
            onChange(
              path,
              e.target.value === ""
                ? null
                : number
                  ? Number(e.target.value)
                  : e.target.value,
            )
          }
        />
      )}
    </label>
  );
}

export function RateCard({
  value,
  onChange,
}: {
  value: BlueprintObject;
  onChange: (v: BlueprintObject) => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  function addEntry(key: string, fallback: BlueprintObject) {
    const rows = Array.isArray(value[key]) ? value[key] : [];
    const item = rows.length
      ? structuredClone(rows[rows.length - 1])
      : fallback;
    onChange({ ...value, [key]: [...rows, item] });
  }
  return (
    <details className="bp-fold">
      <summary>Stock, rates and shop settings</summary>
      <p>
        Match the stock, machines and prices available for this job. Demo rates
        are labeled on the estimate.
      </p>
      <Fields
        value={value}
        path={[]}
        settings
        onChange={(path, v) => {
          const copy = clone(value);
          (node(copy, path.slice(0, -1)) as BlueprintObject)[path.at(-1)!] = v;
          onChange(copy);
        }}
      />
      <div className="bp-actions">
        <button type="button" onClick={() => addEntry("materials", {})}>
          Add stock size or grade
        </button>
        {Array.isArray(value.welds) && !!value.welds.length && (
          <button type="button" onClick={() => addEntry("welds", {})}>
            Add weld schedule
          </button>
        )}
        <button
          type="button"
          onClick={() =>
            addEntry("allowances", {
              part_id: "",
              requirement: "",
              description: "",
              amount: "1",
              rate: "0",
              basis: "batch",
              source: "",
            })
          }
        >
          Add a finish or outside charge
        </button>
      </div>
      <button
        type="button"
        className="bp-link"
        onClick={() => setAdvanced(!advanced)}
      >
        Edit complete rate card
      </button>
      {advanced && <JsonEditor value={value} onApply={onChange} />}
    </details>
  );
}
function JsonEditor({
  value,
  onApply,
}: {
  value: BlueprintObject;
  onApply: (v: BlueprintObject) => void;
}) {
  const [error, setError] = useState(""),
    [raw, setRaw] = useState(JSON.stringify(value, null, 2));
  return (
    <div>
      <textarea
        aria-label="Complete record"
        rows={14}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />
      <button
        type="button"
        onClick={() => {
          try {
            const data = JSON.parse(raw);
            if (!obj(data)) throw Error();
            onApply(data);
            setError("");
          } catch {
            setError("Enter a valid JSON object.");
          }
        }}
      >
        Use these values
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
const reviewTabs = [
  {id:"setup", label:"Quote setup", icon:"calculator"},
  {id:"check", label:"Check the drawing", icon:"drawing"},
  {id:"inventory", label:"What the AI found", icon:"items"},
] as const;

export function ReviewForm({
  job,
  onSubmit,
  busy,
  onOpenDraft,
  onCheckPrint,
  actionError,
  inventory,
  selection,
  startAtMeasurements = false,
}: {
  job: BlueprintJob;
  onSubmit: (data: object, openDraft?: boolean) => void;
  busy: boolean;
  onOpenDraft?: () => void;
  onCheckPrint?: () => void;
  actionError?: string;
  inventory?: (openCheck: OpenCheck, current: BlueprintJob, edited: string[]) => ReactNode;
  selection?: { tab: ReviewTab; select: (tab: ReviewTab) => void };
  startAtMeasurements?: boolean;
}) {
  const tabId = useId();
  const [defaultTab, selectDefaultTab] = useState<ReviewTab>(startAtMeasurements ? "check" : "setup");
  const panel = selection?.tab ?? defaultTab;
  const setPanel = selection?.select ?? selectDefaultTab;
  const [target, setTarget] = useState<{id:string} | null>(startAtMeasurements ? {id: tabId + "-measurements"} : null);
  const tabs = inventory ? reviewTabs : reviewTabs.slice(0, 2);
  const [setupStep, setSetupStep] = useState("scope");
  const [checkStep, setCheckStep] = useState(startAtMeasurements ? "tools" : "");
  const [picked, setPicked] = useState<Record<string,string>>({});
  function pick(group: string, id: string) {
    setPicked(previous => ({...previous, [group]:id}));
  }
  const openCheck: OpenCheck = (next, id) => {
    const part = /^(drawing-part-|source-part-)(\d+)$/.exec(id);
    if (part) pick(part[1],part[2]);
    if (next === "setup") setSetupStep(part ? "specs" : "scope");
    else setCheckStep(part ? "sources" : "tools");
    setPanel(next);
    setTarget({id});
  };
  useEffect(() => {
    if (target) openReviewSection(target.id);
  }, [target]);
  const [ast, setAst] = useState(clone(job.ast!)),
    [settings, setSettings] = useState(clone(job.settings));
  const [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [accepted, setAccepted] = useState<string[]>(() => {
      const previous = job.review_log.at(-1)?.accepted_low_confidence;
      return Array.isArray(previous) ? previous.filter((path): path is string => typeof path === "string") : [];
    });
  const [changes, setChanges] = useState<string[][]>([]);
  const [verifiedFields, setVerifiedFields] = useState<string[]>([]);
  const [showGeometry, setShowGeometry] = useState(false);
  const [shopScope, setShopScope] = useState(job.shop_scope || "");
  const [installation, setInstallation] = useState(job.installation || "confirm");
  const [decisions, setDecisions] = useState<ScopeDecisions>(job.scope_decisions || {});
  const unsaved = changes.length > 0 || verifiedFields.length > 0 || !!reason.trim() ||
    shopScope !== (job.shop_scope || "") || installation !== (job.installation || "confirm") ||
    JSON.stringify(decisions) !== JSON.stringify(job.scope_decisions || {}) ||
    JSON.stringify(accepted) !== JSON.stringify(job.review_log.at(-1)?.accepted_low_confidence || []) ||
    JSON.stringify(ast) !== JSON.stringify(job.ast) || JSON.stringify(settings) !== JSON.stringify(job.settings);
  const recovered = new Set((job.source_callouts || []).flatMap(row =>
    row.status === "recovered" && row.part_id ? [row.part_id] : []));
  function partAt(path: string) {
    const index = partIndex(path);
    const value = index === undefined ? undefined : node(ast, ["parts", index]);
    return value && obj(value) ? value : undefined;
  }
  function inReview(path: string) {
    const part = partAt(path);
    const id = part && String(part.part_id);
    return !id || (decisions[id] !== "exclude" && (!recovered.has(id) || decisions[id] === "include"));
  }
  function checkName(path: string) {
    const relativePath = path.replace(/^parts\.\d+\.?/, "");
    return relativePath === "drawing" ? "Drawing notes" : relativePath ? featureName(relativePath) : "Part details";
  }
  const checksByTopic: Record<ReturnType<typeof reviewTopic>, BlueprintJob["flags"]> = {specs: [], source: [], pricing: []};
  for (const flag of job.flags) {
    if (flag.kind === "low_confidence" || flag.path === "source_release_hold") continue;
    if (!inReview(flag.path)) continue;
    const checks = checksByTopic[reviewTopic(flag)];
    if (!checks.some(check => check.path === flag.path && check.reason === flag.reason)) checks.push(flag);
  }
  const noteChange = (path: string[]) => setChanges((v) => [...v, path]);
  function replaceAst(next: BlueprintObject) {
    const sameReading = (path: string) =>
      JSON.stringify(node(ast, path.split("."))) === JSON.stringify(node(next, path.split(".")));
    setVerifiedFields(previous => previous.filter(sameReading));
    setAccepted(previous => previous.filter(sameReading));
    setChanges(previous => previous.filter(path => sameReading(path.join("."))));
    setAst(next);
  }
  const apply = (path: string[], v: BlueprintValue) => {
    const next = clone(ast);
    (node(next, path.slice(0, -1)) as BlueprintObject)[path.at(-1)!] = v;
    setAst(next);
    noteChange(path);
    const edited = path.join(".");
    const separate = (item: string) => item !== edited && !edited.startsWith(item + ".") && !item.startsWith(edited + ".");
    setAccepted(previous => previous.filter(separate));
    setVerifiedFields(previous => previous.filter(separate));
  };
  const lows: string[] = [];
  function findLow(value: BlueprintValue, path: string[]) {
    if (Array.isArray(value))
      value.forEach((v, i) => findLow(v, [...path, String(i)]));
    else if (obj(value)) {
      if (typeof value.confidence === "number" && value.confidence < 0.85)
        lows.push(path.join("."));
      Object.entries(value).forEach(([k, v]) => findLow(v, [...path, k]));
    }
  }
  findLow(ast, []);
  const visibleLows = lows.filter(inReview);
  const partRecords = Array.isArray(ast.parts) ? ast.parts : [];
  function checksByPart(flags: BlueprintJob["flags"]) {
    const byPart = new Map<string, BlueprintJob["flags"]>();
    for (const flag of flags) {
      const namedPart = flag.path === "drawing" && flag.reason.startsWith("Coverage check") ?
        / — ([^:]+):/.exec(flag.reason)?.[1] : undefined;
      const namedIndex = namedPart === undefined ? -1 : partRecords.findIndex(part => obj(part) && part.part_id === namedPart);
      const part = partIndex(flag.path) ?? (namedIndex < 0 ? "" : String(namedIndex));
      const group = byPart.get(part) || [];
      group.push(flag);
      byPart.set(part, group);
    }
    return [...byPart].sort(([a],[b]) => Number(a || -1) - Number(b || -1));
  }
  const manualParts = checksByPart(checksByTopic.pricing);
  const isPriceInput = (flag: BlueprintJob["flags"][number]) =>
    /\.(quantity|material_family|material_grade|thickness_in|finish)$/.test(flag.path);
  const pricingInputs = checksByTopic.specs.filter(isPriceInput);
  partRecords.forEach((part,index) => {
    const path = "parts." + index + ".quantity";
    if (obj(part) && typeof part.quantity === "number" && inReview(path) && quoteQuantity(job,part,index) === null &&
        !job.flags.some(flag => flag.path === path)) {
      pricingInputs.push({kind:"unverified_source",path,reason:"Verify the order quantity for this part."});
    }
  });
  const drawingDetails = checksByTopic.specs.filter(flag => !isPriceInput(flag));
  const fieldSourceChecks = checksByTopic.source.filter(flag => flag.kind === "unverified_source");
  const coverageChecks = checksByTopic.source.filter(flag => flag.kind !== "unverified_source");
  const checkChoices = [
    ...(visibleLows.length ? [{id:"uncertain", label:"Uncertain readings"}] : []),
    ...(coverageChecks.length ? [{id:"coverage", label:"Conflicts and possible omissions"}] : []),
    ...(fieldSourceChecks.length ? [{id:"sources", label:"Values to verify against the source"}] : []),
    {id:"tools", label:"Drawing tools and detailed calculation"},
  ];
  const fillFromSource = onCheckPrint && <div className="bp-actions">
    <button className="bp-secondary" type="button" onClick={onCheckPrint} disabled={busy || unsaved}>Fill from printed callouts</button>
    <small>{unsaved ? "Save your edits before checking the PDF again." : "Check this older reading for specs the PDF can supply."}</small>
  </div>;
  const activeCheck = checkChoices.some(c => c.id === checkStep) ? checkStep : checkChoices[0].id;
  const partName = (index: string) => {
    const part = index !== "" && partAt("parts." + index);
    return part ? String(part.description || part.part_id) : "Whole drawing";
  };

  function readingValue(value: BlueprintValue | undefined) {
    if (Array.isArray(value)) {
      const strings = value.filter((item): item is string => typeof item === "string" && !!item.trim());
      return strings.length ? <ul>{strings.map((text, i) => <li key={i}>{text}</li>)}</ul> : null;
    }
    if (value != null && !obj(value) && value !== "unknown") {
      return <span>{typeof value === "boolean" ? (value ? "Yes" : "No") : String(value)}</span>;
    }
    return null;
  }

  function readingEvidence(owner: BlueprintValue | undefined, field?: string, fallback?: BlueprintObject) {
    const all = obj(owner) && Array.isArray(owner.evidence) ? owner.evidence.filter(obj) : [];
    const exact = field ? all.filter(entry => Array.isArray(entry.fields) && entry.fields.includes(field)) : all;
    const related = all.length ? all : fallback && Array.isArray(fallback.evidence) ? fallback.evidence.filter(obj) : [];
    const shown = exact.length ? exact : related;
    return shown.length ? <div className="bp-reading-source">
      <strong>{exact.length ? "Saved source" : "Related evidence for this part"}</strong>
      <ul>{shown.slice(0, 3).map((entry, i) => <li key={i}>
        {entry.page ? <a href={"/api/blueprints/drawings/" + job.drawing.id + "/source#page=" + entry.page}
          target="_blank" rel="noreferrer">Open page {String(entry.page)}</a> :
          entry.source === "notes" ? "Customer notes" : entry.source === "review" ? "Staff review" : "Drawing file"}
        {" · "}{String(entry.excerpt)}
      </li>)}</ul>
    </div> : <p className="bp-reading-source">There’s no saved excerpt for this reading. <a
      href={"/api/blueprints/drawings/" + job.drawing.id + "/source"} target="_blank" rel="noreferrer">Open the original drawing</a>.</p>;
  }

  function groupedChecks(flags: BlueprintJob["flags"], groupId: string) {
    const groups = checksByPart(flags);
    const current = groups.find(([id]) => id === picked[groupId]) ?? groups[0];
    if (!current) return null;
    const [part, checks] = current;
    const found = partAt("parts." + part);
    const spec = groupId === "drawing-part-";
    const facts = found && [found.section_designation || found.material_family, found.material_grade,
      found.thickness_in && String(found.thickness_in) + " in thick", found.finish].filter(Boolean).join(" · ");
    return <div className="bp-question" id={groupId + part} tabIndex={-1}>
        <ReviewPicker label="Part to review" choices={groups.map(([id]) => ({id, label:partName(id)}))} selected={part} choose={id => pick(groupId,id)}/>
        {spec && facts && <p className="bp-known"><b>Already on this part</b>{facts}</p>}
        {spec && found && <details className="bp-evidence"><summary>Read the source for this part</summary>{readingEvidence(found)}</details>}
        <ul className="bp-check-items">{checks.map((flag, i) => {
          const path = flag.path.split(".");
          const value = node(ast,path);
          const editable = flag.kind === "missing" && value !== undefined && !Array.isArray(value) && !obj(value);
          const issuePath = flag.path === "drawing" ? ["issues"] : [...path, "issues"];
          const issues = node(ast, issuePath);
          const field = path.at(-1)!;
          const name = flag.path.endsWith(".quantity") ? "Order quantity" : checkName(flag.path);
          const sourceCheck = flag.kind === "unverified_source" && value !== undefined && readingValue(value);
          const hasIssue = Array.isArray(issues) && issues.includes(flag.reason);
          return <li key={flag.path + ":" + i}>
            {flag.path !== "drawing" && !editable && <strong>{name}</strong>}
            {editable && <Fields value={value} path={path} onChange={apply}/>}
            <p>{sourceCheck ? field === "description" ?
              "The AI wrote this part name. Confirm it if it describes the part correctly. This wording check can wait while you price." :
              "Compare this entry with the source. Check it only if they match." : spec && editable ?
              (field === "quantity" ? "Use the total pieces to quote. The draft carries one provisional piece until the count is known." :
               field === "material_grade" ? "Enter a grade if specified in the order or confirmed by the customer. The material family alone does not establish a grade." :
               "Use a written specification or a customer answer. You can leave this open for the budget.") : flag.reason}</p>
            {sourceCheck && <div className="bp-reading-value"><strong>AI entered</strong>{sourceCheck}</div>}
            {flag.kind === "unverified_source" && readingEvidence(obj(value) ? value : node(ast, path.slice(0,-1)),
              sourceCheck ? field : undefined, found)}
            {hasIssue &&
              <button type="button" onClick={() => apply(issuePath, issues.filter(issue => issue !== flag.reason))}>
                Record issue as resolved
              </button>}
            {sourceCheck && value !== undefined && <>
              <label>
                <input type="checkbox" checked={verifiedFields.includes(flag.path)}
                  onChange={event => setVerifiedFields(current => event.target.checked ? [...current, flag.path] : current.filter(item => item !== flag.path))}/>
                {" "}I verified {Array.isArray(value) ? "these" : "this"} {name.toLowerCase()}
              </label>
              <details className="bp-fold"><summary>Edit {Array.isArray(value) ? "these" : "this"} {name.toLowerCase()}</summary>
                <Fields value={value} path={path} onChange={apply}/>
              </details>
            </>}
          </li>;
        })}</ul>
        {spec && found && !checks.some(flag => flag.path.endsWith(".finish")) && <details className="bp-evidence">
          <summary>{found.finish ? "Change the finish" : "Add a finish if requested"}</summary>
          <Fields value={found.finish ?? null} path={["parts",part,"finish"]} onChange={apply}/>
          <small>Include the specified coating or surface treatment when checking the draft costs.</small>
        </details>}
      </div>;
  }
  return (
    <div className="bp-review-work">
      <div className="bp-review-tabs" role="tablist" aria-label="Drawing review">
        {tabs.map((tab, index) => <button key={tab.id} id={tabId + "-" + tab.id} type="button" role="tab"
          aria-selected={panel === tab.id} aria-controls={tabId + "-panel-" + tab.id}
          tabIndex={panel === tab.id ? 0 : -1} onClick={() => setPanel(tab.id)}
          onKeyDown={event => {
            const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1)! :
              offset ? tabs[(index + offset + tabs.length) % tabs.length] : null;
            if (!next) return;
            event.preventDefault();
            setPanel(next.id);
            document.getElementById(tabId + "-" + next.id)?.focus();
          }}>
          <Icon name={tab.icon} size={19} /> <span>{tab.label}</span>
        </button>)}
      </div>
      <form
      className="bp-form"
      onSubmit={(e) => {
        e.preventDefault();
        const action = ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value;
        const openDraft = action === "budget";
        if (openDraft && !unsaved && onOpenDraft) {
          onOpenDraft();
          return;
        }
        const saveOnly = openDraft || action === "progress";
        const reviewNote = reason.trim() || "Saved in-progress drawing checks.";
        const reviewed = clone(ast);
        changes.forEach((p) => stampBlueprintReview(reviewed, p, reviewNote));
        verifiedFields.forEach(path => stampBlueprintReview(reviewed, path.split("."), reason.trim() || "Staff verified the displayed value against the source."));
        onSubmit({
          version: job.version,
          reason: reviewNote,
          ast: reviewed,
          settings,
          confirmed: !saveOnly && confirmed,
          save_only: saveOnly,
          accepted_low_confidence: accepted.filter((p) => lows.includes(p)),
          shop_scope: shopScope,
          installation,
          scope_decisions: decisions,
        }, openDraft);
      }}
      id="blueprint-review-form"
    >
      <div className="bp-review-panel" role="tabpanel" id={tabId + "-panel-setup"} aria-labelledby={tabId + "-setup"} hidden={panel !== "setup"}>
      <ReviewPicker label="Quote setup step" selected={setupStep} choose={setSetupStep} choices={[
        {id:"scope", label:"What our shop supplies"}, {id:"specs", label:"Quantities and material specs"},
        {id:"cost", label:"Work priced in the draft"},
      ]}/>
      {setupStep === "scope" && <section className="bp-lane" id="nick-decisions" aria-labelledby="shop-answers">
        <h3 id="shop-answers">What goes into the quote?</h3>
        <p>The draft starts with {partRecords.filter(part => obj(part) && !recovered.has(String(part.part_id))).length} parts from the drawing. You can adjust the line items in the draft.</p>
        <div className="bp-fields">
          <label>Scope note (optional)
            <textarea rows={2} maxLength={2000} value={shopScope} onChange={event => setShopScope(event.target.value)}
              placeholder="For example, customer supplies the anchors."/>
            <small>This wording starts the customer scope for your review.</small>
          </label>
          <label>Installation
            <select value={installation} onChange={event => setInstallation(event.target.value as typeof installation)}>
              <option value="confirm">Confirm with customer</option>
              <option value="included">Included</option>
              <option value="excluded">Excluded</option>
            </select>
          </label>
        </div>
        <SourceReview job={job} decisions={decisions} onDecision={(id,value) => setDecisions(previous => ({...previous,[id]:value}))}
          onIncludeRemaining={ids => setDecisions(previous => ({...previous,...Object.fromEntries(ids.map(id => [id,"include" as const]))}))}/>
      </section>}
      {setupStep === "specs" && <section className="bp-lane" id="confirm-drawing-specs">
        <h3>Fill only what you know</h3>
        <p>Written specs are already filled. Add a missing value from the order or leave it open for the budget.</p>
        {fillFromSource}
        {pricingInputs.length ? groupedChecks(pricingInputs,"drawing-part-") : <p>No open pricing specifications.</p>}
      </section>}
      {setupStep === "cost" && <section className="bp-lane" id="nick-separate-pricing">
        <h3>Work priced in the draft</h3>
        <p>Sections, assemblies and field work need a different cost basis from flat plate. Included parts carry into the same quote. Check their stock, time and allowances before sending it.</p>
        {manualParts.length ? (() => {
          const [id, flags] = manualParts.find(([part]) => part === picked.cost) ?? manualParts[0];
          return <div className="bp-question">
            <ReviewPicker label="Cost item" choices={manualParts.map(([key]) => ({id:key,label:partName(key)}))} selected={id} choose={value => pick("cost",value)}/>
            {partAt(flags[0].path)?.section_designation && <p className="bp-known"><b>Stock on the drawing</b>{String(partAt(flags[0].path)?.section_designation)}</p>}
            <ul>{flags.map(flag => <li key={flag.path}>{flag.path.endsWith(".stock_form")
              ? "Check the stock length, cuts and fit-up allowance in the quote."
              : "Allow for site labor, equipment and access if installation is included."}</li>)}</ul>
          </div>;
        })() : <p>No separate operations flagged for this drawing.</p>}
      </section>}
      </div>
      <div className="bp-review-panel" role="tabpanel" id={tabId + "-panel-check"} aria-labelledby={tabId + "-check"} hidden={panel !== "check"}>
      <section className="bp-review-intro" id="ai-source-check" aria-labelledby="ai-source-title">
        <h3 id="ai-source-title">Check a reading</h3>
        <p>Open the original beside this panel. Correct a mismatch or verify a match. You can open a budget draft while checks remain.</p>
      </section>
      <div className="bp-review-checks">
        {fillFromSource}
        <ReviewPicker label="Type of drawing check" choices={checkChoices} selected={activeCheck} choose={setCheckStep}/>
        {activeCheck === "uncertain" && <section className="bp-question" id="uncertain-ai-readings">
          <ReviewPicker label="Reading to check" choices={visibleLows.map(path => ({
            id:path, label:partName(partIndex(path) ?? "") + " · " + checkName(path) + (accepted.includes(path) ? " ✓" : ""),
          }))} selected={picked.low} choose={id => pick("low",id)}/>
          <ul className="bp-check-items">{[visibleLows.includes(picked.low) ? picked.low : visibleLows[0]].map(path => {
            const part = partAt(path);
            const keys = path.split(".");
            const record = node(ast, keys);
            if (!obj(record)) return null;
            const details = Object.entries(record).filter(([key, value]) =>
              !["part_id", "confidence", "evidence", "issues", "locations"].includes(key) &&
              value != null && value !== "unknown" && !obj(value) && !Array.isArray(value));
            return <li key={path}>
              <strong>{part ? String(part.description || part.part_id) + " · " : ""}{checkName(path)}</strong>
              <div className="bp-reading-value"><strong>AI entered</strong>
                {details.length ? <dl className="bp-values">{details.map(([key, value]) => <div key={key}>
                  <dt>{fieldName(key)}</dt><dd>{readingValue(value)}</dd>
                </div>)}</dl> : <span>No specific value was read for this feature.</span>}
              </div>
              {readingEvidence(record, undefined, part)}
              {!!details.length && <label>
                <input type="checkbox" checked={accepted.includes(path)}
                  onChange={e => setAccepted(list => e.target.checked ? [...list, path] : list.filter(s => s !== path))}/>
                {" "}I verified these details
              </label>}
              <details className="bp-fold"><summary>Edit these details</summary>
                <Fields value={record} path={keys} onChange={apply}/>
              </details>
            </li>;
          })}</ul>
        </section>}
        {activeCheck === "sources" && <section><p>A value is already filled in. Verify its source before relying on it. Wording checks can wait while you price.</p>{groupedChecks(fieldSourceChecks, "source-part-")}</section>}
        {activeCheck === "coverage" && <section><p>These notes identify work to look for or conflicting instructions. Check the cited area before including a new cost.</p>{groupedChecks(coverageChecks,"coverage-part-")}</section>}
        <ReviewAssistant kind="blueprint" id={job.id} version={job.version} draft={ast} locked={busy}
        onApply={(next, instruction) => {
          replaceAst(next);
          setReason(reason => [reason, "AI-assisted review · " + instruction].filter(Boolean).join("\n").slice(0,2000));
        }}/>
      </div>
      {activeCheck === "tools" && <section className="bp-lane">
        <h3>Detailed calculation</h3>
        <SourceReview job={job} decisions={decisions}/>
        <p>Use these checks when you want the app to calculate cutting and welding costs from the drawing.</p>
        <details className="bp-fold">
          <summary>Shop rates and material prices</summary>
          <RateCard value={settings} onChange={setSettings} />
        </details>
        {!!drawingDetails.length && <details className="bp-fold" id="technical-drawing-checks" data-review-section>
          <summary>Detailed manufacturing checks ({drawingDetails.length})</summary>
          {groupedChecks(drawingDetails, "technical-part-")}
        </details>}
      <details className="bp-fold">
        <summary>All specifications and feature editing</summary>
        <Fields value={ast} path={[]} onChange={apply} />
      </details>
      <details className="bp-fold" id={tabId + "-measurements"} data-review-section onToggle={event => setShowGeometry(event.currentTarget.open)}>
        <summary>Inspect geometry and drawing measurements</summary>
        {showGeometry && <EngineeringCanvas job={job} ast={ast} settings={settings} onChange={apply} locked={busy}/>}
      </details>
      <details className="bp-fold">
        <summary>Complete drawing record and source citations</summary>
        <JsonEditor value={ast} onApply={replaceAst} />
      </details>
      <label>
        What did you check or correct?
        <textarea
          required
          maxLength={2000}
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <label>
        <input
          type="checkbox"
          required
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />{" "}
        I confirmed the inputs used to calculate this estimate.
      </label>
      <div className="bp-actions">
        <button className="bp-secondary" type="submit" value="calculate" disabled={busy}>Save review and calculate price</button>
      </div>
      </section>}
      </div>
      </form>
      {inventory && <div className="bp-review-panel" role="tabpanel" id={tabId + "-panel-inventory"}
        aria-labelledby={tabId + "-inventory"} hidden={panel !== "inventory"}>{inventory(openCheck,{...job,ast,scope_decisions:decisions},[...changes.map(path => path.join(".")), ...verifiedFields])}</div>}
      <div className="bp-review-footer">
        {actionError && <p role="alert" className="sk-danger">{actionError}</p>}
        {onOpenDraft && <button type="submit" value="budget" form="blueprint-review-form" className="bp-primary" formNoValidate disabled={busy}>Open budget draft <Icon name="arrow" size={15}/></button>}
        {unsaved && <span role="status">Unsaved changes</span>}
        <button className="bp-secondary" type="submit" form="blueprint-review-form" value="progress"
          formNoValidate disabled={busy || !unsaved}>Save progress</button>
      </div>
    </div>
  );
}
