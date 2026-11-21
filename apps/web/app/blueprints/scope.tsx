"use client";

import { useState } from "react";
import type { BlueprintJob, BlueprintObject, BlueprintValue } from "@/lib/blueprint-types";
import { fieldName } from "./editor";
import { quoteQuantity } from "@/lib/blueprint-review-evidence";
import { reviewTopic, type OpenCheck } from "./review-topics";

const object = (value: BlueprintValue): value is BlueprintObject => !!value && typeof value === "object" && !Array.isArray(value);
const records = (value: BlueprintValue) => Array.isArray(value) ? value.filter(object) : [];

function factValue(part: BlueprintObject, path: string) {
  return path.split(".").reduce<BlueprintValue | undefined>((value, key) =>
    Array.isArray(value) ? value[Number(key)] : value && object(value) ? value[key] : undefined, part);
}

function factLabel(path: string) {
  return path.split(".").map(piece => /^\d+$/.test(piece) ? String(Number(piece) + 1) : fieldName(piece)).join(" ");
}

export function DrawingScope({job, onOpenCheck, edited = []}: {job: BlueprintJob; onOpenCheck?: OpenCheck; edited?: string[]}) {
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const parts = records(job.ast?.parts ?? null);
  const matches = parts.filter(part => [part.part_id,part.description,part.material_grade,part.section_designation].join(" ").toLowerCase().includes(search.trim().toLowerCase()));
  const needsQuantity = (part: BlueprintObject) => quoteQuantity(job,part,parts.indexOf(part)) === null;
  const needsScope = new Set((job.source_callouts || []).filter(row =>
    row.status === "recovered" && row.part_id && !job.scope_decisions?.[row.part_id]).map(row => row.part_id));
  const pendingQty = (part: BlueprintObject) => typeof part.quantity === "number" && part.quantity > 0 && edited.includes("parts."+parts.indexOf(part)+".quantity");
  const missing = parts.filter(part => !needsScope.has(String(part.part_id)) && job.scope_decisions?.[String(part.part_id)] !== "exclude" && !pendingQty(part) && needsQuantity(part)).length;
  const recovered = (job.recovered_fields || []).filter(fact =>
    parts.some(part => part.part_id === fact.part_id && factValue(part, fact.field) === fact.value));
  return <section id="drawing-scope" className={onOpenCheck ? "bp-scope" : "bp-card bp-scope"} aria-labelledby="ai-inventory-title">
    <div className="bp-actions"><h2 id="ai-inventory-title">What the AI found</h2><span className="bp-pill">{parts.length} {parts.length === 1 ? "part" : "parts"} found</span></div>
    <p>These readings supply the draft with part names, sizes and written specs. Open a part’s evidence to see where a value came from.</p>
    {job.source_check?.status === "checked" && <details className="bp-fold">
      <summary>Second drawing check completed</summary>
      <p>{job.model} read the drawing. {job.source_check.model} compared the parts and callouts with the original.</p>
    </details>}
    {job.source_check?.status === "incomplete" && <p>The second drawing check is incomplete. Check the original for missing work before final pricing.</p>}
    {missing > 0 && <p>{missing} {missing === 1 ? "part needs" : "parts need"} an order quantity. A count inside an assembly may describe one assembly.</p>}
    {parts.length > 6 && <label>Find a part<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Part name, number, or material"/></label>}
    <ul className="bp-scope-parts">{(showAll || search ? matches : matches.slice(0,6)).map(part => {
      const outline = part.outline && object(part.outline) ? part.outline : null;
      const material = [part.material_family,part.material_grade].filter(Boolean).join(" ");
      const sources = [...records(part.evidence),...records(outline?.evidence ?? null)];
      const uniqueSources = Array.from(new Map(sources.map(source => [String(source.page) + ":" + source.excerpt, source])).values());
      const detail = [
        outline?.width_in && outline.height_in && (outline.width_in + " × " + outline.height_in + " in"),
        part.thickness_in && (part.thickness_in + " in thick"),
        part.finish && String(part.finish),
        ...(["holes", "bends", "welds"] as const).map(key => {
          const count = records(part[key]).length;
          return count > 0 ? count + " " + (count === 1 ? key.slice(0,-1) : key) : "";
        }),
      ].filter(Boolean).join(" · ");
      const position = parts.indexOf(part);
      const quantityFlag = job.flags.find(flag => flag.path === "parts." + position + ".quantity");
      const sourceCheck = quantityFlag && reviewTopic(quantityFlag) === "source";
      const jump = (sourceCheck ? "source-part-" : "drawing-part-") + position;
      const quantityInput = !!onOpenCheck && (!!quantityFlag || typeof part.quantity === "number" && needsQuantity(part));
      return <li key={String(part.part_id)}>
        <div className="bp-scope-line">
          <div><strong>{String(part.description || part.part_id)}</strong>
            {part.section_designation ? <small>{String(part.section_designation)}</small> : material && <small>{material}</small>}
          </div>
          {job.scope_decisions?.[String(part.part_id)] === "exclude" ? <span className="bp-pill">Outside quote</span> : onOpenCheck && needsScope.has(String(part.part_id)) ? <button type="button" className="bp-pill bp-pill-missing bp-check-link"
            onClick={() => onOpenCheck("setup", "nick-recovered-scope")}>
            Decide who supplies it
          </button> : pendingQty(part) ? <span className="bp-pill">{String(part.quantity)} entered · unsaved</span> : needsQuantity(part) && quantityInput ? <button type="button" className="bp-pill bp-pill-missing bp-check-link"
            onClick={() => onOpenCheck(sourceCheck ? "check" : "setup", jump)}>{part.quantity == null ? "Enter order quantity" : "Check order quantity"}</button> : <span className={needsQuantity(part) ? "bp-pill bp-pill-missing" : "bp-pill"}>
              {needsQuantity(part) ? "Quantity open" : String(part.quantity) + " ordered"}
            </span>}
        </div>
        {detail && <small>{detail}</small>}
        {!!uniqueSources.length && <details>
          <summary>See drawing evidence</summary>
          <ul>{uniqueSources.slice(0,8).map((source,i) => <li key={i}>
            {source.page ? <a href={"/api/blueprints/drawings/" + job.drawing.id + "/source#page=" + source.page}
              target="_blank" rel="noreferrer">Page {String(source.page)}</a> : source.source === "notes" ? "Customer notes" : source.source === "review" ? "Staff review" : "DXF"}
            {" · "}{String(source.excerpt)}
          </li>)}</ul>
        </details>}
      </li>;
    })}</ul>
    {!parts.length ? <p>No part records were found. Use the review to add what’s visible on the drawing.</p> :
      !matches.length && <p>No parts match those words.</p>}
    {!search && parts.length > 6 && <button type="button" onClick={() => setShowAll(value => !value)}>
      {showAll ? "Show fewer parts" : "Show all " + parts.length + " parts"}
    </button>}
    {!!recovered.length && <details className="bp-fold">
      <summary>Automatically filled with source evidence ({recovered.length})</summary>
      <ul>{recovered.map((fact,i) => <li key={i}>
        <strong>{String(parts.find(part => part.part_id === fact.part_id)?.description || fact.part_id)} · {factLabel(fact.field)}</strong> · {fact.value}<br/>
        <small>{fact.page ? <a href={"/api/blueprints/drawings/" + job.drawing.id + "/source#page=" + fact.page}
          target="_blank" rel="noreferrer">Page {fact.page}</a> : "Customer notes"} · {fact.evidence}</small>
      </li>)}</ul>
    </details>}
  </section>;
}
