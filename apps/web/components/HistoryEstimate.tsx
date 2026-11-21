"use client";
import Activity from "@/components/Activity";
import { useEffect, useState } from "react";
import { WorkAmountField, usesHours } from "./WorkAmountField";
import type { HistoryRun, HourEdit, MeasureEdit, AllowanceProposal } from "@/lib/history-types";
import type { OperationSuggestion } from "@/lib/estimating-types";
import type { Comparable } from "@/lib/job-types";
import type { MeasuredAllowance } from "@/lib/measured-allowances";
import { Icon } from "./Icons";

type Props = {
  quoteId: string;
  itemId: string;
  templateId: string;
  base: OperationSuggestion;
  records: Comparable[];
  run: HistoryRun | null;
  proposals: AllowanceProposal[];
  url: string;
  archived: boolean;
  observations: MeasuredAllowance[];
  recordsSource?: string;
};
export default function HistoryEstimate(props: Props) {
  const { run } = props,
    base = run?.base || props.base,
    records = run?.records || props.records;
  const observations = run ? run.observations || [] : props.observations;
  function sourceName(ref:string){return records[Number(ref.slice(1))-1]?.jobName||ref;}
  useEffect(()=>{
    const showSource=()=>{const target=document.getElementById(window.location.hash.slice(1));if(target instanceof HTMLDetailsElement)target.open=true;};
    showSource();window.addEventListener("hashchange",showSource);
    return ()=>window.removeEventListener("hashchange",showSource);
  },[]);
  const currency = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
  const [edits, setEdits] = useState<HourEdit[]>(
    run?.edits ||
      run?.advice.map((a) => ({
        operationId: a.operationId,
        hours: a.hours,
        assumption: a.assumption,
        reason: "",
        recurring: false,
      })) ||
      [],
  );
  const [measures, setMeasures] = useState<MeasureEdit[]>(() =>
    run?.appliedVersion
      ? run.measures || []
      : base.rows
          .filter(
            (r) =>
              run &&
              base.missingOperationIds.includes(r.estimate!.operationId) &&
              !run.advice.some((a) => a.operationId === r.estimate!.operationId),
          )
          .map((r) => ({ operationId: r.estimate!.operationId, amount: NaN, reason: "" })),
  );
  const [pending, setPending] = useState(""),
    [error, setError] = useState("");
  const outdated =
    !!run &&
    (run.base.settingsVersion !== props.base.settingsVersion ||
      (!!run.base.pricingDate && run.base.pricingDate !== props.base.pricingDate) ||
      run.base.quoteVersion !== props.base.quoteVersion ||
      run.base.selectedRevisionId !== props.base.selectedRevisionId ||
      run.base.reviewRunId !== props.base.reviewRunId);
  const locked = props.archived || !!run?.appliedVersion || outdated || !!pending;
  function edit(index: number, patch: Partial<HourEdit>) {
    setEdits(edits.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  }
  async function act(action: string, extra: Record<string, unknown> = {}) {
    setPending(action);
    setError("");
    try {
      const res = await fetch("/api/history/" + props.quoteId, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          itemId: props.itemId,
          templateId: props.templateId,
          runId: run?.id,
          edits,
          measures,
          ...extra,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not save the estimate.");
      window.location.assign(
        props.url +
          "&run=" +
          (["generate", "review_defaults"].includes(action) ? body.id : run?.id) +
          (action === "review_defaults" ? "#default-proposals" : ""),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
      setPending("");
    }
  }
  return (
    <div className="jh-history-layout" style={{ margin: "18px 0" }}>
      <div className="jh-stack">
        <section className="panel">
          <div className="panel-heading">
            <span className="section-icon">
              <Icon name="jobs" />
            </span>
            <h2>How long will this work take?</h2>
          </div>
          <div className="jh-body">
            <p>
              {base.rows[0].estimate!.templateName} ·{" "}
              {base.rows[0].estimate!.demo ? "Example shop prices" : "Shop prices"}
            </p>
            {props.archived ? (
              <p>This part or job type has been archived. These were its saved hours.</p>
            ) : (
              <button className={run?"button secondary":"button primary"} disabled={!!pending} onClick={() => act("generate")}>
                {pending === "generate"
                  ? <Activity>Reviewing job history</Activity>
                  : run
                    ? "Check the hours again"
                    : "Suggest time for this job"}
              </button>
            )}
            {!run && observations.some((o) => o.recurring) && (
              <button
                className="button secondary"
                disabled={!!pending}
                onClick={() => act("review_defaults")}
              >
                Review a change for future jobs
              </button>
            )}
            {run && (
              <p>
                {run.kind === "template_review"
                  ? "Nick can decide which changes to use on future jobs."
                  : run.appliedVersion
                    ? "Saved to quote version " + run.appliedVersion
                    : outdated
                      ? "The quote or shop prices changed. Check the hours again before saving."
                      : "Check the suggested time below, then save it to the quote."}
              </p>
            )}
            {run?.model&&<details><summary>About this suggestion</summary><p>{run.provider} · {run.model} · Shop prices version {base.settingsVersion}</p></details>}
            {error && (
              <p role="alert" className="error-message">
                {error}
              </p>
            )}
          </div>
          {base.rows.map((row) => {
            const e = row.estimate!,
              i = edits.findIndex((x) => x.operationId === e.operationId),
              draft = edits[i],
              a = run?.advice.find((a) => a.operationId === e.operationId);
            const m = measures.find((m) => m.operationId === e.operationId);
            const trend = observations.find((o) => o.operationId === e.operationId);
            const measure = (patch: Partial<MeasureEdit>) =>
              setMeasures(measures.map((entry) => (entry === m ? { ...entry, ...patch } : entry)));
            return (
              <article key={row.id} className="jh-card">
                <h3>{row.label}</h3>
                <p>
                  {row.amount} {e.unit} {row.basis === "batch" ? "per batch" : "per part"} · ${row.rate}/
                  {e.unit} · ${e.minimumCost} minimum
                </p>
                <details><summary>How the starting time or amount was figured</summary><p>{e.rationale}</p></details>
                {trend && (
                  <div className="jh-observed">
                    <strong>
                      {trend.samples.length === 1 ? "Recorded time" : "Typical time on past jobs"} ·{" "}
                      {Number((60 * trend.observedHours).toFixed(2))} min per{" "}
                      {row.basis === "batch" ? "batch" : "part"}
                    </strong>
                    <p>
                      Shop estimate {Number((60 * row.amount).toFixed(2))} min · {trend.samples.length}{" "}
                      completed {trend.samples.length === 1 ? "job" : "jobs"}
                    </p>
                    <div className="jh-observation-refs">
                      {trend.samples.map((s) => (
                        <a key={s.ref} href={"#record-" + s.ref}>
                          {sourceName(s.ref)} · {Number((60 * s.hours).toFixed(2))} min
                        </a>
                      ))}
                    </div>
                    {trend.recurring && !run && (
                      <p>Each job took {trend.observedHours>trend.templateHours?"longer":"less time"} than the shop estimate.</p>
                    )}
                  </div>
                )}
                {m && (
                  <fieldset disabled={locked} className="jh-fieldset">
                    <label className="field">
                      Confirmed amount ({e.unit})
                      <input
                        type="number"
                        min="0"
                        step="0.0001"
                        value={Number.isFinite(m.amount) ? m.amount : ""}
                        onChange={(v) => measure({ amount: v.target.valueAsNumber })}
                      />
                    </label>
                    <label className="field">
                      Measurement source
                      <input value={m.reason} onChange={(v) => measure({ reason: v.target.value })} />
                    </label>
                  </fieldset>
                )}
                {a && draft && (
                  <>
                    <p>
                        <b>Why this time was suggested</b> · {a.basis}{" "}
                        {typeof a.confidence === "number" && <span>Model confidence {a.confidence.toFixed(2)} / 1.00. </span>}
                      {a.sources.map((s) => (
                        <a key={s} href={"#record-" + s}>
                          {sourceName(s)}{" "}
                        </a>
                      ))}
                    </p>
                    <fieldset className="jh-fieldset" disabled={locked}>
                      <div className="jh-fields">
                        <WorkAmountField unit="hour" basis={row.basis} value={draft.hours} onChange={hours=>edit(i,{hours})}/>
                        <label className="field">
                          What are we assuming?
                          <textarea
                            value={draft.assumption}
                            onChange={(v) => edit(i, { assumption: v.target.value })}
                          />
                        </label>
                      </div>
                      <label className="field">
                        Why change the suggested time or notes?
                        <input
                          value={draft.reason}
                          onChange={(v) => edit(i, { reason: v.target.value })}
                        />
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={draft.recurring}
                          onChange={(v) => edit(i, { recurring: v.target.checked })}
                        />{" "}
                        Ask Nick to use this time on future jobs
                      </label>
                    </fieldset>
                  </>
                )}
              </article>
            );
          })}
          {run && run.kind !== "template_review" && (
            <div className="jh-body">
              <p>
                Saving replaces the suggested costs for this part. Costs entered by hand stay on the quote.
              </p>
              <div className="jh-actions">
                <button className="button primary" disabled={locked} onClick={() => act("apply")}>
                  Save these hours to the quote
                </button>
                <a href={"/quotes/" + props.quoteId}>Open quote</a>
              </div>
            </div>
          )}
        </section>
        {!!props.proposals.length && (
          <section id="default-proposals" className="panel jh-body">
            <h3>Nick’s decision for future jobs</h3>
            {props.proposals.map((p) => (
              <div className="jh-card" key={p.id}>
                <b>{p.label}</b>
                <p>
                  {usesHours(p.unit)?`From ${Number((p.before*60).toFixed(2))} to ${Number((p.after*60).toFixed(2))} minutes`:`From ${p.before} to ${p.after} ${p.unit}`} · {p.status==="pending"?"Waiting for Nick":p.status==="approved"?"Approved":"Kept the old time"}
                </p>
                <p>{p.reason}</p>
                {p.status === "pending" && (
                  <div className="jh-actions">
                    <button
                      disabled={!!pending}
                      className="button primary"
                      onClick={() => act("approve", { proposalId: p.id })}
                    >
                      Use the new time for future jobs
                    </button>
                    <button
                      disabled={!!pending}
                      className="button secondary"
                      onClick={() => act("decline", { proposalId: p.id })}
                    >
                      Keep the old time
                    </button>
                  </div>
                )}
              </div>
            ))}
          </section>
        )}
      </div>
      <aside className="panel">
        <div className="panel-heading">
          <span className="section-icon">
            <Icon name="jobs" />
          </span>
          <h2>Jobs used for comparison</h2>
        </div>
        {(run?.recordsSource || props.recordsSource) && (
          <div className="jh-body">
            {records.length} similar{" "}
            {records.length === 1 ? "job" : "jobs"}
          </div>
        )}
        {!records.length && (
          <div className="jh-body">
            No similar approved jobs yet. Start with the shop’s usual times for this job type.
          </div>
        )}
        {records.map((r, i) => (
          <details
            id={"record-R" + (i + 1)}
            key={JSON.stringify([r.sourceWorkspace, r.quoteId, r.version, r.lineId])}
            className="jh-card"
          >
            <summary><b>{r.jobName}</b> · {r.quantity} pieces</summary>
            <p>
              {r.description} · Qty {r.quantity}
              <br />
              {[r.workType, r.material, r.dimensions].filter(Boolean).join(" · ")}
            </p>
            <p className="jh-muted">{r.reasons.join(" · ")}</p>
            <a href={r.evidenceHref || "/quotes/" + r.quoteId + "/approval?version=" + r.version}>
              {r.number} · approved v{r.version}
            </a>
            <details>
              <summary>Estimated work ({r.operations.length})</summary>
              {r.operations.map((o, n) => (
                <p key={n}>
                  {o.label} · {o.amount} {o.unit} {o.basis === "batch" ? "per batch" : "per part"}
                </p>
              ))}
            </details>
            {r.pricing && (
              <details>
                <summary>Nick’s pricing decision</summary>
                <p>
                  Whole quote ·{" "}
                  {r.pricing.firstAvailableVersion === 1
                    ? "First draft"
                    : "First saved v" + r.pricing.firstAvailableVersion}{" "}
                  {currency(r.pricing.firstSellingPrice)} at {r.pricing.firstMarginPercent}% margin.
                </p>
                {r.pricing.firstPricedVersion !== undefined &&
                  r.pricing.firstPricedSellingPrice !== undefined &&
                  r.pricing.firstPricedVersion !== r.pricing.firstAvailableVersion && (
                    <p>
                      First priced estimate · v{r.pricing.firstPricedVersion} ·{" "}
                      {currency(r.pricing.firstPricedSellingPrice)} at{" "}
                      {r.pricing.firstPricedMarginPercent}% margin.
                    </p>
                  )}
                <p>
                  Approved {currency(r.pricing.approvedSellingPrice)} at{" "}
                  {r.pricing.approvedMarginPercent}% margin.
                </p>
                {r.pricing.decision && (
                  <p>
                    {
                      {
                        standard: "Job-specific pricing",
                        one_time: "One-time exception",
                        recurring: "Recurring preference",
                        scope_change: "Scope change",
                      }[r.pricing.decision.kind]
                    }
                    {r.pricing.decision.reason && " · " + r.pricing.decision.reason}
                  </p>
                )}
              </details>
            )}
            {r.completed && (
              <>
                <p>
                  <a
                    href={
                      (r.evidenceHref || `/jobs/${r.quoteId}/${r.version}`) +
                      (r.completedEdit ? (r.evidenceHref ? "&" : "?") + "edit=" + r.completedEdit : "")
                    }
                  >
                    {r.completedEdit
                      ? "Completed-job record · edit " + r.completedEdit
                      : "Latest completed-job record"}
                  </a>
                </p>
                {r.actuals.map((a, n) => (
                  <div key={n}>
                    {a.operation} · {a.amount} {a.unit} total
                    {a.unitCost !== null && " · " + currency(a.unitCost) + " per " + a.unit}
                    {a.extendedCost != null && " · " + currency(a.extendedCost) + " total"}
                    {a.exceptionReason && " · One-time work: " + a.exceptionReason}
                  </div>
                ))}
              </>
            )}
            {r.scopeChanges && <p>Scope changes · {r.scopeChanges}</p>}
            {r.overrideReasons && (
              <details>
                <summary>Why the price or work changed</summary>
                <p>{r.overrideReasons}</p>
              </details>
            )}
          </details>
        ))}
      </aside>
    </div>
  );
}
