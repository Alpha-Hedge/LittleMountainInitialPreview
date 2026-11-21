"use client";

import Activity from "@/components/Activity";
import { useEffect, useState } from "react";
import type { QuoteReviewView } from "@/lib/workflow-types";
import { statusLabels } from "@/lib/workflow-types";
import { fieldKeys, fieldLabels } from "@/lib/review-types";
import type { CostRow, Quote, QuoteTotals } from "@/lib/types";
import { isStockMaterial } from "@/lib/types";
import type { ReviewOperation } from "@/lib/engineering-ledger";
import type { BlueprintJob } from "@/lib/blueprint-types";
import type {
  PhotoReading,
  SketchConversion,
} from "@/lib/sketch/conversion-types";
import { EngineeringCanvas, PhotoCanvas } from "./BlueprintCanvas";
import { ReviewForm } from "@/app/blueprints/editor";
import ReviewSource from "./ReviewSource";
import ReviewAssistant from "./ReviewAssistant";
import "./review-workspace.css";

const money = (x: number | undefined) =>
  x === undefined
    ? "—"
    : x.toLocaleString("en-US", { style: "currency", currency: "USD" });
const hours = (n: number) => Number(n.toFixed(4)) + " hr";
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init),
    data = await r.json();
  if (!r.ok)
    throw Error(
      typeof data.detail === "string"
        ? data.detail
        : data.error || "Check the values and try again.",
    );
  return data;
}
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
function LinkedDrawing({
  view,
  blueprint,
  sketch,
  locked,
}: {
  view: QuoteReviewView;
  blueprint: BlueprintJob | null;
  sketch: string | null;
  locked: boolean;
}) {
  const { quote, drawing } = view.snapshot;
  const [page, setPage] = useState(1),
    [edit, setEdit] = useState(false),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState<SketchConversion | null>(null),
    [reading, setReading] = useState<PhotoReading | null>(null),
    [note, setNote] = useState("");
  const match = sketch?.match(/^release-([0-9a-f-]+)-v(\d+)$/i),
    id = match?.[1],
    version = match?.[2];
  const base = "/api/sketch-conversions/" + id;
  useEffect(() => {
    if (!id) return;
    const c = new AbortController();
    json<SketchConversion>(base + "?version=" + version, { signal: c.signal })
      .then((r) => {
        if (!c.signal.aborted) {
          setPhoto(r);
          setReading(r.reading);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setNotice(e.message);
      });
    return () => c.abort();
  }, [id, base, version]);
  async function submit(
    url: string,
    body: object,
    where: (r: { version: number }) => string,
  ) {
    setBusy(true);
    setNotice("");
    try {
      const r = await json<{ version: number }>(url, post(body));
      setEdit(false);
      setNext(where(r));
      setNotice(
        "Drawing review saved. Open the revised drawing to price its changes.",
      );
    } catch (e) {
      setNotice(
        e instanceof Error ? e.message : "Drawing review could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  const [next, setNext] = useState("");
  const bpLink = blueprint ? "/blueprints/" + blueprint.id : "";
  const phLink = id ? "/sketches/photo/" + id + "?version=" + version : "";
  return (
    <section className="rw-panel rw-drawing">
      <div className="rw-head">
        <h2>Drawing</h2>
        <span>
          {blueprint
            ? "Source rev " + blueprint.drawing.revision
            : photo
              ? "Sketch rev " + photo.version
              : drawing?.label}
        </span>
      </div>
      {blueprint?.ast ? (
        <>
          <p>{blueprint.drawing.filename}</p>
          {edit ? (
            <ReviewForm
              key={blueprint.id}
              startAtMeasurements
              job={blueprint}
              busy={busy}
              onSubmit={(body) =>
                void submit(
                  "/api/blueprints/jobs/" + blueprint.id + "/review",
                  body,
                  () => bpLink,
                )
              }
            />
          ) : (
            <EngineeringCanvas
              job={blueprint}
              ast={blueprint.ast}
              locked
              onChange={() => {}}
            />
          )}
          {!locked && !edit && !next && (
            <button type="button" onClick={() => setEdit(true)}>
              Edit drawing measurements
            </button>
          )}{" "}
          <a href={bpLink}>Open blueprint estimate</a>
        </>
      ) : photo && reading ? (
        <>
          <PhotoCanvas
            record={photo}
            reading={reading}
            verified={photo.verified}
            onChange={setReading}
            locked={!edit || busy}
          />
          {!locked && !edit && !next && (
            <button type="button" onClick={() => setEdit(true)}>
              Edit drawing measurements
            </button>
          )}
          {edit && (
            <>
              <label className="field">
                Reason for drawing revision
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={2000}
                />
              </label>
              <button
                type="button"
                disabled={!note.trim() || busy}
                onClick={() =>
                  void submit(
                    base + "/review",
                    {
                      version: photo.version,
                      reading,
                      review_note: note,
                      confirmed: false,
                      verified: photo.verified,
                    },
                    (r) => "/sketches/photo/" + id + "?version=" + r.version,
                  )
                }
              >
                Save drawing for review
              </button>
            </>
          )}{" "}
          <a href={phLink}>Open sketch revision</a>
        </>
      ) : drawing ? (
        <ReviewSource
          quoteId={quote.id}
          revision={drawing}
          page={page}
          onPageChange={setPage}
          active
          notes={quote.notes}
        />
      ) : (
        <p>
          {id
            ? <Activity>Opening the sketch</Activity>
            : "No drawing is linked to this quote."}{" "}
          {!id && (
            <a href={"/quotes/" + quote.id + "#drawings"}>Add a drawing</a>
          )}
        </p>
      )}
      {edit && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setEdit(false);
            setReading(photo?.reading || null);
          }}
        >
          Cancel drawing changes
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
      {next && <a href={next}>Open revised drawing</a>}
      {view.snapshot.reviewRuns.some((r) => r.appliedAt) && (
        <details>
          <summary>Confirmed specifications</summary>
          {view.snapshot.reviewRuns
            .filter((r) => r.appliedAt)
            .flatMap((r) =>
              r.parts.flatMap((p, i) =>
                r.corrections[i]?.selected
                  ? fieldKeys.map((k) => {
                      const value =
                        r.corrections[i].values[k] ?? p.fields[k].value;
                      return (
                        value && (
                          <p key={r.id + i + k}>
                            {fieldLabels[k]} · {value}
                          </p>
                        )
                      );
                    })
                  : [],
              ),
            )}
        </details>
      )}
      {view.snapshot.details.assumptions && (
        <div>
          <h3>Assumptions</h3>
          <p>{view.snapshot.details.assumptions}</p>
        </div>
      )}
    </section>
  );
}
export default function QuoteReviewWorkspace({
  view,
  operations,
  blueprint,
  sketch,
}: {
  view: QuoteReviewView;
  operations: ReviewOperation[];
  blueprint: BlueprintJob | null;
  sketch: string | null;
}) {
  const original = view.snapshot.quote,
    url = "/quotes/" + original.id;
  const [draft, setDraft] = useState(original),
    [revise, setRevise] = useState(false),
    [working, setWorking] = useState(false),
    [notice, setNotice] = useState("");
  const [buffer, setBuffer] = useState(original.scrapBufferPct || 10);
  const body = JSON.stringify(draft),
    dirty = body !== JSON.stringify(original);
  const [priced, setPriced] = useState<{
    body: string;
    totals?: QuoteTotals;
    error?: string;
  }>({ body, totals: original.totals });
  const totals = !dirty
    ? original.totals
    : priced.body === body
      ? priced.totals
      : undefined;
  const latest = original.version === view.currentVersion,
    locked = !latest || (!!view.approvedAt && !revise);
  useEffect(() => {
    if (!dirty) return;
    const c = new AbortController();
    const t = setTimeout(() => {
      json<QuoteTotals>("/api/quotes/calculate", {
        ...post(JSON.parse(body)),
        signal: c.signal,
      })
        .then((totals) => {
          if (!c.signal.aborted) setPriced({ body, totals });
        })
        .catch((e) => {
          if (!c.signal.aborted) setPriced({ body, error: e.message });
        });
    }, 130);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [body, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function rowChange(
    itemId: string,
    id: string,
    change: (row: CostRow) => CostRow,
  ) {
    setDraft((q) => ({
      ...q,
      items: q.items.map((i) =>
        i.id !== itemId
          ? i
          : {
              ...i,
              costRows: i.costRows.map((r) => (r.id === id ? change(r) : r)),
            },
      ),
    }));
    setNotice("");
  }
  async function save() {
    if (locked || !dirty || !totals || working) return;
    setWorking(true);
    setNotice("");
    try {
      const q = await json<Quote>("/api/quotes/" + original.id, {
        ...post(draft),
        method: "PUT",
      });
      window.history.replaceState(
        null,
        "",
        url + "/workspace?version=" + q.version,
      );
      setDraft(original);
      setTimeout(() => window.location.reload(), 0);
    } catch (e) {
      setNotice(
        e instanceof Error ? e.message : "Unable to save the revision.",
      );
      setWorking(false);
    }
  }
  const approvedPdf =
    "/api/quotes/" +
    original.id +
    "/approval/pdf?download=1&version=" +
    original.version;
  const zip =
    "/api/quotes/" + original.id + "/traveler?version=" + original.version;
  return (
    <main className="rw-main">
      <header className="rw-title">
        <div>
          <p>
            {original.number} · Revision {original.version} ·{" "}
            {statusLabels[view.status]}
          </p>
          <h1>{original.jobName}</h1>
          <p>{original.customer}</p>
        </div>
        <label className="field">
          Saved revision
          <select
            value={original.version}
            onChange={(e) =>
              window.location.assign(
                url + "/workspace?version=" + e.target.value,
              )
            }
          >
            {view.versions.map((v) => (
              <option key={v.version} value={v.version}>
                Rev {v.version} · {statusLabels[v.status]}
              </option>
            ))}
          </select>
        </label>
      </header>
      <div className="rw-columns">
        <LinkedDrawing
          view={view}
          blueprint={blueprint}
          sketch={sketch}
          locked={locked}
        />
        <section className="rw-panel">
          <div className="rw-head">
            <h2>Work and cost</h2>
            <span>USD · before tax</span>
          </div>
          {locked && (
            <p>
              Viewing saved revision {original.version}.{" "}
              {latest ? (
                <button type="button" onClick={() => setRevise(true)}>
                  Revise pricing
                </button>
              ) : (
                <a href={url + "/workspace"}>Open current revision</a>
              )}
            </p>
          )}
          {draft.items.map((item, i) => (
            <details className="rw-line rw-part" key={item.id} open={i===0 || undefined}>
              <summary><span><strong>{item.description.split(/\r?\n/)[0]}</strong><small>{item.quantity} {item.quantity===1?"piece":"pieces"} · {item.costRows.length} cost rows</small></span><b>{money(totals?.items[i]?.cost)}</b></summary>
              {item.description.includes("\n") && <p className="rw-part-spec">{item.description.split("\n").slice(1).join("\n")}</p>}
              {item.costRows.map((r, j) => {
                const op = operations.find(
                  (v) => v.rowId === r.id && v.itemId === item.id,
                )!;
                const reason =
                    r.review?.reason ?? r.estimate?.overrideReason ?? "",
                  disposition = r.review?.disposition || "standard";
                const physical =
                  op.physical && r.estimate?.unit === "batch charge";
                const basis = physical ? op.proposedBasis : r.basis,
                  amount = physical ? op.amount : r.amount;
                const update = (patch: Partial<CostRow>) =>
                  rowChange(item.id, r.id, (row) => ({ ...row, ...patch }));
                const withReason = (v: string) => ({
                  review: { ...r.review, disposition, reason: v },
                  ...(r.estimate && {
                    estimate: { ...r.estimate, overrideReason: v },
                  }),
                });
                return (
                  <article className="rw-operation" key={r.id}>
                    <h4>
                      {op.center || r.label}
                      {op.center && op.center !== r.label
                        ? " · " + r.label
                        : ""}
                    </h4>
                    <div className="rw-comparison">
                      <div>
                        <span>Original proposal</span>
                        <strong>
                          {op.aiCost === null
                            ? "Manual entry"
                            : money(op.aiCost)}
                        </strong>
                        {op.aiHours !== null && (
                          <small>{hours(op.aiHours)} per batch</small>
                        )}
                      </div>
                      <div>
                        <span>Nick’s estimate</span>
                        <strong>{money(totals?.items[i].rows[j].cost)}</strong>
                        {op.hourly && (
                          <small>
                            {hours(
                              amount * (basis === "batch" ? 1 : item.quantity),
                            )}{" "}
                            per batch
                          </small>
                        )}
                      </div>
                    </div>
                    <fieldset disabled={locked || working}>
                      <div className="rw-fields">
                        <label className="field">
                          {op.hourly ? "Hours" : op.unit || "Amount"}{" "}
                          {basis === "batch" ? "per batch" : "per piece"}
                          <input
                            aria-label={r.label + " amount"}
                            type="number"
                            min="0"
                            step="any"
                            value={amount}
                            onChange={(e) => {
                              const a = Number(e.target.value);
                              update({
                                ...withReason(reason),
                                amount: a,
                                ...(physical && {
                                  basis,
                                  rate: Number(op.proposedRate.toFixed(4)),
                                  estimate: {
                                    ...r.estimate!,
                                    unit: op.hourly ? "hours" : op.unit,
                                    overrideReason: reason,
                                  },
                                }),
                              });
                            }}
                          />
                        </label>
                        <label className="field">
                          Override cost{" "}
                          {r.basis === "batch" ? "per batch" : "per piece"} ($)
                          <input
                            aria-label={r.label + " cost override"}
                            type="number"
                            min="0"
                            step=".0001"
                            placeholder="Use calculated cost"
                            value={r.review?.unitCost ?? ""}
                            onChange={(e) =>
                              update({
                                review: {
                                  reason,
                                  disposition,
                                  unitCost:
                                    e.target.value === ""
                                      ? undefined
                                      : Number(e.target.value),
                                },
                              })
                            }
                          />
                        </label>
                      </div>
                      <details open={r.review ? true : undefined}>
                        <summary>
                          Adjustment reason and material allowance
                        </summary>
                        <label className="field">
                          Reason for change
                          <input
                            aria-label={r.label + " reason"}
                            maxLength={2000}
                            value={reason}
                            onChange={(e) => update(withReason(e.target.value))}
                          />
                        </label>
                        <label className="bw-inline">
                          <input
                            type="checkbox"
                            checked={disposition === "one_time"}
                            onChange={(e) =>
                              update({
                                review: {
                                  ...r.review,
                                  reason,
                                  disposition: e.target.checked
                                    ? "one_time"
                                    : "standard",
                                },
                              })
                            }
                          />
                          One-time exception for this job
                        </label>
                        <label className="bw-inline">
                          <input
                            type="checkbox"
                            checked={isStockMaterial(r)}
                            onChange={(e) =>
                              update({ bufferMaterial: e.target.checked })
                            }
                          />
                          Include this cost in the material scrap buffer
                        </label>
                      </details>
                    </fieldset>
                    {(op.explanation || op.citations.length > 0) && (
                      <details>
                        <summary>
                          Estimate basis and sources ({op.citations.length})
                        </summary>
                        <p>{op.explanation}</p>
                        <ul>
                          {op.citations.map((c, n) => (
                            <li key={n}>
                              <b>
                                {
                                  {
                                    historical_job: "Past job",
                                    nick_rule: "Nick’s rule",
                                    template: "Shop rate",
                                    drawing: "Drawing",
                                  }[c.kind]
                                }
                              </b>{" "}
                              · {c.excerpt}
                              <details>
                                <summary>Source reference</summary>
                                <small className="rw-ref">{c.reference}</small>
                              </details>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </article>
                );
              })}
            </details>
          ))}
        </section>
      </div>
      <section className="rw-panel rw-price">
        <div>
          <h2>Price the job</h2>
          <fieldset disabled={locked || working}>
            <label className="field">
              Target gross margin (%)
              <input
                type="number"
                min="0"
                max="99.99"
                step=".01"
                value={draft.marginPercent}
                onChange={(e) =>
                  setDraft({ ...draft, marginPercent: Number(e.target.value) })
                }
              />
            </label>
            <input
              aria-label="Target gross margin slider"
              type="range"
              min="0"
              max="99.99"
              step=".01"
              value={draft.marginPercent}
              onChange={(e) =>
                setDraft({ ...draft, marginPercent: Number(e.target.value) })
              }
            />
            <label className="bw-inline">
              <input
                type="checkbox"
                checked={!!draft.scrapBufferPct}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    scrapBufferPct: e.target.checked ? buffer || 10 : 0,
                  })
                }
              />
              Add material scrap buffer
            </label>
            {!!draft.scrapBufferPct && (
              <label className="field">
                Extra material (%)
                <input
                  type="number"
                  min=".01"
                  max="100"
                  step=".01"
                  value={buffer}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setBuffer(v);
                    setDraft({ ...draft, scrapBufferPct: v });
                  }}
                />
              </label>
            )}
          </fieldset>
        </div>
        <div className="rw-summary" aria-live="polite">
          <span>Estimated cost</span>
          <strong>{money(totals?.estimatedCost)}</strong>
          <span>Suggested selling price</span>
          <strong className="rw-selling">{money(totals?.sellingPrice)}</strong>
          {!!draft.scrapBufferPct && (
            <small>
              Includes{" "}
              {money(totals?.items.reduce((n, i) => n + (i.scrapCost || 0), 0))}{" "}
              extra material.
            </small>
          )}
        </div>
      </section>
      {latest && <ReviewAssistant kind="quote" id={original.id} version={original.version} draft={draft}
        sourceRevision={view.snapshot.drawing?.id ?? blueprint?.drawing.id} locked={locked||working}
        onApply={(next)=>{ setDraft(next);setNotice(""); }}/>} 
      {(notice || (priced.body === body && priced.error)) && (
        <p role="alert">{notice || priced.error}</p>
      )}
      <div className="rw-actions">
        {!locked && (
          <button
            type="button"
            className="button primary"
            disabled={!dirty || working || !totals}
            onClick={save}
          >
            {working ? <Activity>Saving revision</Activity> : "Save pricing revision"}
          </button>
        )}
        {!dirty && (
          <a
            className="button secondary"
            href={url + "/approval?version=" + original.version}
          >
            {view.approvedAt
              ? "Open approved quote"
              : "Review scope and approve"}
          </a>
        )}
      </div>
      <section className="rw-panel">
        <h2>Quote documents</h2>
        <div className="rw-actions">
          {!!view.approvedAt && !dirty ? (
            <a className="button primary" href={approvedPdf}>
              Download Customer Proposal PDF
            </a>
          ) : (
            <button className="button secondary" disabled>
              Download Customer Proposal PDF
            </button>
          )}
          {!dirty ? (
            <a className="button secondary" href={zip}>
              Download Internal Shop Traveler &amp; CSV
            </a>
          ) : (
            <button className="button secondary" disabled>
              Download Internal Shop Traveler &amp; CSV
            </button>
          )}
        </div>
        <p>
          {dirty
            ? "Save the pricing revision to download its documents."
            : view.approvedAt
              ? "Both downloads use revision " + original.version + "."
              : "Approve this revision to issue a customer proposal."}
        </p>
      </section>
    </main>
  );
}
