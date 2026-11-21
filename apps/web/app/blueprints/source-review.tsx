"use client";

import type { BlueprintJob } from "@/lib/blueprint-types";
import { useState } from "react";
import { ReviewPicker } from "./review-picker";

export type ScopeDecisions = NonNullable<BlueprintJob["scope_decisions"]>;

export function SourceReview({job, decisions, onDecision, onIncludeRemaining}: {
  job: BlueprintJob; decisions: ScopeDecisions; onDecision?: (id: string, value: "include" | "exclude") => void;
  onIncludeRemaining?: (ids: string[]) => void;
}) {
  const [selected, select] = useState("");
  const rows = job.source_callouts || [];
  if (!rows.length) return null;
  const followUps = rows.filter(row => onDecision ? row.status === "recovered" && row.part_id : row.status !== "captured");
  const captured = rows.filter(row => row.status === "captured");
  const source = (row: (typeof rows)[number]) => (
    <a href={"/api/blueprints/drawings/" + job.drawing.id + "/source#page=" + row.page} target="_blank" rel="noreferrer">Page {row.page}</a>
  );
  if (onDecision) {
    const extras = [...new Map(followUps.map(row => [row.part_id!, row])).values()];
    const open = extras.filter(row => !decisions[row.part_id!]);
    const row = extras.find(item => item.part_id === selected) || open[0] || extras[0];
    if (!row) return null;
    const id = row.part_id!;
    return <section className="bp-question" id="nick-recovered-scope" tabIndex={-1}>
      <h4>Who supplies these extras?</h4>
      <p>The second read found these mentions. They stay out of the budget until you include them.</p>
      <ReviewPicker label="Extra item" choices={extras.map(item => ({id:item.part_id!, label:item.label}))} selected={id} choose={select}/>
      <div className="bp-reading-source">{source(row)} · {row.evidence}</div>
      <p role="status">{decisions[id] === "include" ? "Included in this quote." : decisions[id] === "exclude" ? "Left out of this quote." : "Supply responsibility is open."}</p>
      <div className="bp-actions">
        <button type="button" aria-pressed={decisions[id] === "include"} onClick={() => {select(id); onDecision(id,"include");}}>Our shop supplies it</button>
        <button type="button" className="bp-secondary" aria-pressed={decisions[id] === "exclude"} onClick={() => {select(id); onDecision(id,"exclude");}}>Leave it out</button>
      </div>
      {open.length > 1 && onIncludeRemaining && <button type="button" className="ph-link" onClick={() => onIncludeRemaining(open.map(item => item.part_id!))}>Include all {open.length} undecided extras</button>}
    </section>;
  }
  return <div className="bp-source-review">
    {!!followUps.length && <details className="bp-fold" data-review-section>
      <summary>Callouts found on a second read ({followUps.length})</summary>
      <p>Use Quote setup to decide which extras your shop supplies.</p>
      <ul className="bp-scope-parts">
        {followUps.map(row => <li key={row.page + ":" + row.evidence}>
          <div className="bp-scope-line"><strong>{row.label}</strong><span className="bp-pill">
            {(row.part_id && decisions[row.part_id]) === "exclude" ? "Outside scope" :
              (row.part_id && decisions[row.part_id]) === "include" ? "In scope" :
                row.status === "recovered" && row.part_id ? "Scope open" : "Check source"}
          </span></div>
          <p><small>{source(row)} · {row.evidence}</small></p>
        </li>)}
      </ul>
    </details>}
    {!onDecision && !!captured.length && <details className="bp-fold">
      <summary>Printed callouts matched to parts ({captured.length})</summary>
      <ul>{captured.map(row => <li key={row.page + ":" + row.evidence}>{source(row)} · {row.evidence}</li>)}</ul>
    </details>}
  </div>;
}
