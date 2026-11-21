"use client";
import Activity from "@/components/Activity";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icons";
import DrawingFilePicker from "@/components/DrawingFilePicker";
import type {
  BlueprintJob,
  BlueprintSummary,
  BlueprintObject,
  BlueprintValue,
} from "@/lib/blueprint-types";
import { fieldName, RateCard, ReviewForm } from "./editor";
import { startBlueprint } from "@/lib/start-blueprint";
import { DrawingScope } from "./scope";
import { SourceReview } from "./source-review";
import type { ReviewTab } from "./review-topics";
const stateNames: Record<BlueprintSummary["state"], string> = {
  queued: "Drawing queued",
  extracting: "Reading drawing",
  review_required: "Ready for a budget draft",
  costing: "Calculating price",
  ready: "Ready to quote",
  failed: "Needs attention",
};
const root = "/api/blueprints/";
const money = (v: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(v),
  );
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(root + path, { ...init, cache: "no-store" });
  const body = await res.json();
  if (!res.ok)
    throw Error(
      Array.isArray(body.detail)
        ? body.detail.slice(0,4)
            .map(
              (x: {
                path?: string;
                reason?: string;
                loc?: string[];
                msg?: string;
              }) =>
                [x.path || x.loc?.join("."), x.reason || x.msg]
                  .filter(Boolean)
                  .join(" · "),
            )
            .join("\n") + (body.detail.length > 4 ? "\nSee the full checklist for the remaining details." : "")
        : String(body.detail || "Unable to reach the shop server."),
    );
  return body as T;
}
const post = <T,>(url: string, data: object) =>
  call<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
const message = (e: unknown) => (e instanceof Error ? e.message : "Try again.");
export function BlueprintDesk() {
  const router = useRouter(),
    [jobs, setJobs] = useState<BlueprintSummary[]>([]),
    [settings, setSettings] = useState<BlueprintObject | null>(null);
  const [file, setFile] = useState<File | null>(null),
    [customer, setCustomer] = useState(""),
    [name, setName] = useState(""),
    [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [key, setKey] = useState("");
  const [intake, setIntake] = useState(false);
  const [search, setSearch] = useState("");
  const filtered = jobs.filter(job => [job.job_name, job.customer_name, job.drawing.filename].some(value => value.toLowerCase().includes(search.trim().toLowerCase())));
  const [loaded, setLoaded] = useState(false);
  const [parent, setParent] = useState(""),
    [revision, setRevision] = useState(1);
  useEffect(() => {
    let done = false;
    Promise.all([
      call<BlueprintSummary[]>("jobs"),
      call<BlueprintObject>("settings"),
    ])
      .then(([j, s]) => {
        if (!done) {
          setJobs(j);
          setSettings(s);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (!done) setError(message(e));
      });
    return () => {
      done = true;
    };
  }, []);
  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      if (
        !/\.(pdf|dxf)$/i.test(file.name) ||
        file.size > 20 * 1024 * 1024 ||
        !file.size
      )
        throw Error("Choose a PDF or DXF up to 20 MB.");
      const requestKey = key || crypto.randomUUID();
      setKey(requestKey);
      router.push(await startBlueprint(file, requestKey, {notes, customer, name, parent, revision, settings}));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const drawings = Array.from(
    new Set(jobs.map((j) => j.drawing.drawing_key)),
  ).map(
    (k) =>
      jobs
        .filter((j) => j.drawing.drawing_key === k)
        .sort((a, b) => b.drawing.revision - a.drawing.revision)[0],
  );
  return (
    <div className="bp-desk">
      <header className="library-head">
        <div><h1>Drawing reviews</h1>
        <p>Reopen a blueprint, check what the shop will supply, or add a revised drawing.</p></div>
        <button className="button secondary" type="button" aria-expanded={intake} aria-controls="blueprint-intake"
          onClick={() => setIntake(!intake)}><Icon name={intake ? "close" : "plus"} size={17}/>{intake ? "Close upload" : "Add a drawing"}</button>
      </header>
      {error && (
        <div className="bp-error" role="alert">
          {error}
        </div>
      )}
      <section id="blueprint-intake" className="bp-card" hidden={!intake}>
        <h2>Start from a drawing</h2>
        <form className="bp-form" onSubmit={start} onChange={() => setKey("")}>
          <DrawingFilePicker label="Customer drawing" required accept=".pdf,.dxf" fileName={file?.name || ""}
            formats="PDF or DXF" onSelect={setFile}/>
          <div className="bp-fields">
            <label>
              Customer <small>Optional</small>
              <input
                placeholder="Company or name"
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
              />
            </label>
            <label>
              Job name <small>Optional</small>
              <input
                placeholder="Uses the drawing filename"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          </div>
          <label>
            Customer notes <small>Optional</small>
            <textarea
              rows={2}
              placeholder="Quantity, material or instructions from the customer"
              value={notes}
              maxLength={16000}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          {!!drawings.length && (
            <details className="bp-fold">
              <summary>Replacing an earlier drawing?</summary>
              <label>
                Drawing series
                <select
                  value={parent}
                  onChange={(e) => {
                    setParent(e.target.value);
                    setRevision(
                      (drawings.find(
                        (j) => j.drawing.drawing_key === e.target.value,
                      )?.drawing.revision || 0) + 1,
                    );
                  }}
                >
                  <option value="">New drawing</option>
                  {drawings.map((j) => (
                    <option key={j.id} value={j.drawing.drawing_key}>
                      {j.job_name} · {j.drawing.filename} · rev{" "}
                      {j.drawing.revision}
                    </option>
                  ))}
                </select>
              </label>
              {parent && (
                <label>
                  New revision
                  <input
                    type="number"
                    min="1"
                    value={revision}
                    onChange={(e) => setRevision(Number(e.target.value))}
                  />
                </label>
              )}
            </details>
          )}
          {jobs.length > 0 && (
            <label>
              Rate card
              <select
                defaultValue=""
                onChange={async (e) => {
                  const selected = e.target.value;
                  setBusy(true);
                  try {
                    setSettings(
                      selected
                        ? (await call<BlueprintJob>("jobs/" + selected))
                            .settings
                        : await call<BlueprintObject>("settings"),
                    );
                  } catch (err) {
                    setError(message(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <option value="">Demo rates</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    Use settings from {j.job_name} · v{j.version}
                  </option>
                ))}
              </select>
            </label>
          )}
          {settings && <RateCard value={settings} onChange={setSettings} />}
          <div className="bp-actions">
            <button className="bp-primary" disabled={busy || !settings}>
              {busy ? <Activity>Uploading drawing</Activity> : "Read drawing and estimate"}
            </button>
            {settings?.demo === true && (
              <span className="bp-tag">Demo shop rates</span>
            )}
          </div>
        </form>
      </section>
      <section className="bp-library">
        <div className="library-head"><h2>Saved drawing reviews</h2>
          <label className="library-search"><Icon name="search" size={16}/><input type="search" aria-label="Find a drawing review" placeholder="Find a drawing review" value={search} onChange={e => setSearch(e.target.value)}/></label>
        </div>
        {jobs.length > 0 && !filtered.length && <p role="status">No drawing reviews match this search.</p>}
        {jobs.length ? (
          <ul className="bp-list">
            {filtered.map((j) => (
              <li key={j.id}>
                <a href={"/blueprints/" + j.id}>
                  <b>{j.job_name}</b>
                  <small>
                    {j.customer_name} · Rev {j.drawing.revision} · {new Date(j.updated_at).toLocaleString("en-US", {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}
                  </small>
                </a>
                <span>{stateNames[j.state]}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p role="status">{loaded ? "Your drawing reviews will appear here. Choose Add a drawing to begin." : error ? "Could not load saved drawing reviews." : <Activity>Opening drawing reviews</Activity>}</p>
        )}
      </section>
    </div>
  );
}
function Values({ value }: { value: BlueprintValue }) {
  if (Array.isArray(value))
    return (
      <div>
        {value.map((v, i) => (
          <div key={i}>
            <Values value={v} />
          </div>
        ))}
      </div>
    );
  if (value && typeof value === "object")
    return (
      <dl className="bp-values">
        {Object.entries(value)
          .filter(([, v]) => v !== null && !(Array.isArray(v) && !v.length))
          .map(([k, v]) => (
            <div key={k}>
              <dt>{fieldName(k)}</dt>
              <dd>
                <Values value={v} />
              </dd>
            </div>
          ))}
      </dl>
    );
  return <>{String(value ?? "")}</>;
}
function DrawingPreview({id}:{id:string}) {
  const [page,setPage]=useState(1), [count,setCount]=useState(1), [image,setImage]=useState(""), [error,setError]=useState("");
  useEffect(()=>{
    const controller=new AbortController();
    let url="";
    setImage("");setError("");
    async function read(){
      const response=await fetch(root+"drawings/"+id+"/preview?page="+page,{signal:controller.signal});
      if(!response.ok)throw Error("Open the original file to inspect this drawing.");
      const blob=await response.blob();
      if(controller.signal.aborted)return;
      url=URL.createObjectURL(blob);setCount(Number(response.headers.get("X-Page-Count")) || 1);setImage(url);
    }
    void read().catch(e=>{if(!controller.signal.aborted)setError(message(e));});
    return ()=>{controller.abort();if(url)URL.revokeObjectURL(url);};
  },[page,id]);
  return <div>{image?<img className="bp-native" src={image} alt={"Drawing preview, page "+page}/>:<p role="status">{error || <Activity>Opening preview</Activity>}</p>}
    {count>1&&<div className="bp-actions"><button type="button" disabled={page===1} onClick={()=>setPage(page-1)}>Previous page</button>
      <span>Page {page} of {count}</span><button type="button" disabled={page===count} onClick={()=>setPage(page+1)}>Next page</button></div>}</div>;
}

export function BlueprintEstimate({
  id,
  frozen,
}: {
  id: string;
  frozen?: BlueprintJob;
}) {
  const router = useRouter(),
    [job, setJob] = useState<BlueprintJob | null>(frozen ?? null),
    [error, setError] = useState(""),
    [pendingAction, setAction] = useState(""),
    [refresh, setRefresh] = useState(0),
    [showSource, setShowSource] = useState(false),
    [reviewTab, selectReviewTab] = useState<ReviewTab>("setup");
  useEffect(() => {
    if (frozen) return;
    let done = false,
      timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const v = await call<BlueprintJob>("jobs/" + id);
        if (done) return;
        setJob(v);
        if (["queued", "extracting", "costing"].includes(v.state))
          timer = setTimeout(load, 1800);
      } catch (e) {
        if (!done) {
          setError(message(e));
          timer = setTimeout(load, 5000);
        }
      }
    }
    void load();
    return () => {
      done = true;
      clearTimeout(timer);
    };
  }, [id, refresh, frozen]);
  async function act(action: string, data: object, openDraft = false) {
    setError("");
    setAction(action);
    try {
      const receipt = await post<{ id: string; version: number }>(
        "jobs/" + id + "/" + action,
        data,
      );
      if (action === "draft" || action === "manual-draft") {
        router.push("/quotes/" + receipt.id);
        return;
      }
      setRefresh((n) => n + 1);
      if (openDraft) {
        const draft = await post<{id: string}>("jobs/" + id + "/manual-draft", {version: receipt.version});
        router.push("/quotes/" + draft.id);
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setAction("");
    }
  }
  const busy = !!pendingAction;
  const openingDraft = pendingAction === "draft" || pendingAction === "manual-draft";
  const result = job?.result;
  const reviewRequired = job?.state === "review_required" && !!job.ast && !frozen;
  const warnings = result ? [...new Set([...result.warnings, ...result.lines.flatMap(line => line.warnings)])] : [];
  const sourceNote = job?.original_ast?.source_release_hold || job?.ast?.source_release_hold;
  return (
    <div className={"bp-desk" + (reviewRequired ? " bp-review-desk" : "")}>
 
      {error && (
        <div role="alert" className="bp-error">
          {error}
        </div>
      )}
      {!job ? (
        <p role="status"><Activity>Opening estimate</Activity></p>
      ) : (
        <>
          <header>
            <h1>{job.job_name}</h1>
            <p>
              {job.customer_name} · Drawing rev {job.drawing.revision} ·
              Estimate v{job.version}
            </p>
          </header>
          {busy && !openingDraft && <p role="status"><Activity>{pendingAction==="source-check" ? "Comparing printed callouts" : pendingAction==="review" ? "Saving your drawing review" : "Restarting the drawing reader"}</Activity></p>}
          <section className={"bp-card" + (reviewRequired ? " bp-draft-overview" : "")}>
            <div>
                <div className="bp-actions">
                  <h2 aria-live="polite">
                    {frozen ? "Original estimate" : stateNames[job.state]}
                  </h2>
                  {job.settings.demo === true && (
                    <span className="bp-tag">Demo shop rates</span>
                  )}
                </div>
                {job.error && (job.ast ? <details className="bp-fold">
                  <summary>Why automatic pricing paused</summary>
                  <p className="bp-issue">{job.error}</p>
                </details> : <p className="bp-error">{job.error}</p>)}
                {job.state === "failed" && (
                  <button
                    className="bp-primary"
                    disabled={busy}
                    onClick={() => act("retry", { version: job.version })}
                  >
                    Retry saved drawing
                  </button>
                )}
                {["queued", "extracting", "costing"].includes(job.state) && (
                  <p role="status">
                    <Activity>{job.state === "queued" ? "Waiting to read the drawing" : job.state === "extracting" ? "Finding parts and written callouts" : "Pricing the work"}</Activity>
                  </p>
                )}
                {job.state === "review_required" && job.ast && (
                  <>
                  {job.review_log.at(-1)?.action === "printed_callout_check" ?
                    <p role="status">
                      {Number(job.review_log.at(-1)?.filled_fields) > 0 ?
                        "Details filled from the drawing. See the values and original wording under What the AI found." :
                        "Printed callouts checked. Use Quote setup to decide which items your shop will supply."}
                    </p> :
                    refresh > 0 && job.review_log.at(-1)?.save_only === true && <p role="status"><Activity done>Progress saved</Activity></p>}
                  <p>Opening the quote starts a full takeoff with assumptions where the drawing leaves details open.</p>
                  </>
                )}
                {result && (
                  <>
                    <div className="bp-prices">
                      <div>
                        <small>Estimated shop cost</small>
                        <strong>
                          {money(result.totals.estimated_cost_usd)}
                        </strong>
                      </div>
                      <div>
                        <small>Selling price before tax</small>
                        <strong>
                          {money(result.totals.selling_price_usd)}
                        </strong>
                      </div>
                    </div>
                    <p>
                      Target gross margin{" "}
                      {Number(result.totals.gross_margin_pct)}% ·{" "}
                      {String(job.settings.snapshot_name)}
                    </p>
                    {!!warnings.length && <details className="bp-fold">
                      <summary>Pricing notes ({warnings.length})</summary>
                      <ul>{warnings.map(w => <li key={w}>{w}</li>)}</ul>
                    </details>}
                    {!frozen && (
                      <button
                        className="bp-primary"
                        disabled={busy}
                        onClick={() => act("draft", { version: job.version })}
                      >
                        {openingDraft ? <Activity>Opening draft</Activity> : "Open editable quote draft"}
                      </button>
                    )}
                  </>
                )}
            </div>
            {reviewRequired && <button type="submit" value="budget" form="blueprint-review-form" formNoValidate
              className="bp-primary bp-forward" disabled={busy}>{openingDraft ? <Activity>Opening draft</Activity> : "Open quote draft"} <Icon name="arrow" /></button>}
          </section>
          <div className={"bp-split" + (reviewRequired ? " bp-review-split" : "")}>
            <aside className="bp-card bp-source" data-show-source={showSource}>
              <div className="bp-source-head">
              <div><h2>Original drawing</h2>
              <a
                href={root + "drawings/" + job.drawing.id + "/source"}
                target="_blank"
                rel="noreferrer"
              >
                {job.drawing.filename}
              </a>
              </div>
              <button type="button" className="bp-secondary bp-source-toggle" aria-controls="bp-drawing-preview"
                aria-expanded={showSource} onClick={() => setShowSource(value => !value)}>{showSource ? "Hide preview" : "Show preview"}</button>
              </div>
              <div id="bp-drawing-preview" className="bp-source-body">
              <DrawingPreview id={job.drawing.id}/>
              {typeof sourceNote === "string" && (
                <small>Source note · {sourceNote.split(". ")[0].replace(/\.$/,"")}.</small>
              )}
              {job.notes && (
                <p>
                  <b>Customer notes</b>
                  <br />
                  {job.notes}
                </p>
              )}
              </div>
            </aside>
            <div className="bp-stack">
              {reviewRequired && <section id="drawing-checklist" className="bp-card bp-review-card" aria-labelledby="drawing-review-title">
                <h2 id="drawing-review-title">Drawing review</h2>
                <ReviewForm key={job.version} job={job} busy={busy} actionError={error} onSubmit={(data, openDraft) => act("review", data, openDraft)}
                  selection={{tab:reviewTab, select:selectReviewTab}}
                  inventory={(openCheck, current, edited) => <DrawingScope job={current} onOpenCheck={openCheck} edited={edited}/>}
                  onOpenDraft={frozen ? undefined : () => act("manual-draft", {version: job.version})}
                  onCheckPrint={job.drawing.type === "CUSTOMER_PDF" && !job.printed_inventory_current ?
                    () => act("source-check", {version: job.version}) : undefined}/>
              </section>}
              {job.ast && !reviewRequired && <DrawingScope job={job}/>}
              {job.state === "ready" && !!job.source_callouts?.length && <section className="bp-card">
                <h2>AI source check</h2>
                <SourceReview job={job} decisions={job.scope_decisions || {}}/>
              </section>}
              {result && <section className="bp-card bp-part-pricing">
                <h2>Price by part</h2>
                {result.lines.map((l) => (
                <details className="bp-fold" key={l.part_id}>
                  <summary><span>{l.description}<small>{l.part_id} · {l.quantity} {l.quantity === 1 ? "piece" : "pieces"}</small></span>
                    <strong>{money(l.selling_price_usd)}</strong></summary>
                  <table className="bp-costs">
                    <thead>
                      <tr>
                        <th>Work or material</th>
                        <th>Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {l.rows.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <details>
                              <summary>{r.label}</summary>
                              <p>{r.basis_text}</p>
                              <p>
                                {r.amount} × {money(r.rate)} · {r.basis}
                              </p>
                              {r.citations.map((c, i) => (
                                <small key={i}>{c} </small>
                              ))}
                              {r.rule_citations?.map((c) => (
                                <small key={c.reference}>{c.excerpt}</small>
                              ))}
                            </details>
                          </td>
                          <td>{money(r.cost_usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <details className="bp-fold">
                    <summary>Fabrication quantities and hours</summary>
                    <Values value={l.metrics} />
                  </details>
                  <h3>Comparable approved quotes</h3>
                  {l.history.length ? (
                    <ul>
                      {l.history.map((h) => (
                        <li key={h.citation.reference}>
                          <details>
                            <summary>{h.citation.excerpt}</summary>
                            {h.source_workspace && (
                              <p><a href={"/learning/" + encodeURIComponent(h.source_workspace) + "/" + encodeURIComponent(h.quote_id)
                                + "?version=" + h.revision + (h.completed_edit ? "&edit=" + h.completed_edit : "")}>Open approved history</a></p>
                            )}
                            {!!h.actuals?.length && <><b>{h.typical ? "Recorded shop work" : "Recorded exception"}</b>
                              <ul>{h.actuals.map((actual, i) => <li key={i}>{actual}</li>)}</ul></>}
                            {h.scope_changes && <p>Scope changes · {h.scope_changes}</p>}
                            {h.override_reason && (
                              <p>Reason for adjustment · {h.override_reason}</p>
                            )}
                            {h.ai_proposed && (
                              <details>
                                <summary>Original proposal</summary>
                                <Values value={h.ai_proposed} />
                              </details>
                            )}
                            {h.nick_approved && (
                              <details>
                                <summary>Approved work</summary>
                                <Values value={h.nick_approved} />
                              </details>
                            )}
                          </details>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>
                      No approved quote matched this material, weight and work.
                    </p>
                  )}
                  {!!l.rules.length && (
                    <>
                      <h3>Nick’s pricing rules</h3>
                      <ul>
                        {l.rules.map((r) => (
                          <li key={r.reference}>{r.excerpt}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </details>
              ))}
              </section>}
              {result && (
                <section className="bp-card">
                  <details className="bp-fold">
                    <summary>Stock layout, yield and scrap</summary>
                    <Values value={result.stock_groups} />
                  </details>
                  {frozen ? (
                    <details className="bp-fold">
                      <summary>Drawing specifications and sources</summary>
                      <Values value={job.ast} />
                    </details>
                  ) : (
                    <details className="bp-fold">
                      <summary>Review drawing details or adjust rates</summary>
                      <ReviewForm
                        key={job.version}
                        job={job}
                        busy={busy}
                        onSubmit={(data) => act("review", data)}
                        onCheckPrint={job.drawing.type === "CUSTOMER_PDF" && !job.printed_inventory_current ?
                          () => act("source-check", {version: job.version}) : undefined}
                      />
                    </details>
                  )}
                </section>
              )}
              {!!job.review_log.length && (
                <details className="bp-card">
                  <summary>Review history</summary>
                  {job.review_log.map((r, i) => (
                    <p key={i}>
                      {String(r.reviewed_at).slice(0, 10)} · {String(r.reason)}
                    </p>
                  ))}
                </details>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
