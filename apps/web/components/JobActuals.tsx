"use client";
import Activity from "@/components/Activity";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { actualKinds, isTime, type ActualRow, type JobRecord } from "@/lib/job-types";
import type { Quote } from "@/lib/types";

const money = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD" });
const names: Record<ActualRow["kind"], string> = {
  setup: "Setup time",
  labor: "Hands-on work",
  machine: "Machine time",
  material: "Materials",
  outside: "Outside work or delivery",
};
const hints: Record<ActualRow["kind"], string> = {
  setup: "For example, set up the drill press",
  labor: "For example, deburr cut edges",
  machine: "For example, laser cutting",
  material: "For example, A36 steel plate",
  outside: "For example, delivery or powder coating",
};
function newRow(quote: Quote): ActualRow {
  return {
    itemId: quote.items[0].id,
    kind: "setup",
    operation: "",
    amount: NaN,
    unit: "h",
    unitCost: null,
  };
}

function Entry({
  row,
  quote,
  index,
  onChange,
  onRemove,
}: {
  row: ActualRow;
  quote: Quote;
  index: number;
  onChange: (patch: Partial<ActualRow>) => void;
  onRemove: () => void;
}) {
  const [timeUnit, setTimeUnit] = useState<"minutes" | "hours">("hours");
  const suggestions = useId(),
    timed = isTime(row.kind);
  const scale = timed && timeUnit === "minutes" ? 60 : 1;
  const ops =
    quote.items
      .find((i) => i.id === row.itemId)
      ?.costRows.filter((r) => !r.estimate || r.estimate.category === row.kind) ?? [];
  return (
    <section className="finish-entry" aria-label={"Entry " + (index + 1)}>
      <div className="finish-entry-head">
        <h3>Entry {index + 1}</h3>
        <button type="button" className="finish-remove" onClick={onRemove}>
          Remove<span className="visually-hidden"> entry {index + 1}</span>
        </button>
      </div>
      <div className="finish-inputs">
        <label className="field">
          <span>Type of work or cost</span>
          <select
            value={row.kind}
            onChange={(e) => {
              const kind = e.target.value as ActualRow["kind"];
              onChange({
                kind,
                unit: isTime(kind) ? "h" : kind === "outside" ? "job" : "piece",
                exceptionReason: isTime(kind) ? row.exceptionReason : "",
              });
            }}
          >
            {actualKinds.map((k) => (
              <option key={k} value={k}>
                {names[k]}
              </option>
            ))}
          </select>
        </label>
        {quote.items.length > 1 && (
          <label className="field">
            <span>Which part or service?</span>
            <select value={row.itemId} onChange={(e) => onChange({ itemId: e.target.value })}>
              {quote.items.map((item, i) => (
                <option key={item.id} value={item.id}>
                  {i + 1}. {item.description.split("\n")[0]}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field finish-wide">
          <span>{row.kind === "material" ? "Material used" : "Work done"}</span>
          <input
            list={suggestions}
            required
            placeholder={hints[row.kind]}
            value={row.operation}
            onChange={(e) => onChange({ operation: e.target.value })}
          />
        </label>
        <datalist id={suggestions}>
          {ops.map((o) => (
            <option key={o.id} value={o.label} />
          ))}
        </datalist>
        <label className="field">
          <span>{timed ? "Time spent on this job" : "Quantity used"}</span>
          <input
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            required
            value={Number.isFinite(row.amount) ? Number((row.amount * scale).toFixed(8)) : ""}
            onChange={(e) => onChange({ amount: e.target.valueAsNumber / scale })}
          />
        </label>
        {timed ? (
          <label className="field">
            <span>Time unit</span>
            <select value={timeUnit} onChange={(e) => setTimeUnit(e.target.value as typeof timeUnit)}>
              <option value="hours">Hours</option>
              <option value="minutes">Minutes</option>
            </select>
          </label>
        ) : (
          <>
            <label className="field">
              <span>Measured in</span>
              <input
                required
                placeholder="Pieces, feet, trips…"
                value={row.unit}
                onChange={(e) => onChange({ unit: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Cost per {row.unit || "unit"} ($)</span>
              <input
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                required
                value={row.unitCost ?? ""}
                onChange={(e) =>
                  onChange({ unitCost: e.target.value === "" ? null : e.target.valueAsNumber })
                }
              />
            </label>
          </>
        )}
      </div>
      {timed && (
        <details
          className="finish-fold"
          open={!!row.exceptionReason || row.unitCost !== null || undefined}
        >
          <summary>Hourly cost or one-time work (optional)</summary>
          <div className="finish-inputs">
            <label className="field">
              <span>Actual cost per hour ($)</span>
              <input
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={row.unitCost ?? ""}
                onChange={(e) =>
                  onChange({ unitCost: e.target.value === "" ? null : e.target.valueAsNumber })
                }
              />
            </label>
            <label className="field">
              <span>Why was this a one-time job?</span>
              <input
                placeholder="For example, the saw broke down"
                value={row.exceptionReason || ""}
                onChange={(e) => onChange({ exceptionReason: e.target.value })}
              />
              <small>Adding a reason leaves these hours out of future estimates.</small>
            </label>
          </div>
        </details>
      )}
    </section>
  );
}

export default function JobActuals({
  quote,
  saved,
  readOnly = false,
}: {
  quote: Quote;
  saved: JobRecord | null;
  readOnly?: boolean;
}) {
  const [record, setRecord] = useState<JobRecord>(
    () =>
      saved ?? {
        quoteId: quote.id,
        version: quote.version,
        edit: 0,
        rows: [newRow(quote)],
        scopeChanges: "",
        overrideReasons: "",
        completedOn: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
      },
  );
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [base, setBase] = useState(record),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [csvRows, setCsvRows] = useState<ActualRow[]>([]),
    [removed, setRemoved] = useState<{ row: ActualRow; at: number } | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const endpoint = "/api/jobs/" + quote.id + "/" + quote.version,
    dirty = record !== base;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function change(patch: Partial<JobRecord>) {
    setRecord((prev) => ({ ...prev, ...patch }));
    setNotice("");
    setError("");
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const res = await fetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(record),
      });
      const body = await res.json();
      if (!res.ok) throw Error(body.error);
      setRecord(body);
      setBase(body);
      setRemoved(null);
      setNotice("Saved. The time and costs are on this job record.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the job. Try again.");
    } finally {
      setBusy(false);
      requestAnimationFrame(() => statusRef.current?.scrollIntoView({ block: "center" }));
    }
  }
  async function importCsv(file: File) {
    setBusy(true);
    setError("");
    setNotice("");
    setCsvRows([]);
    try {
      if (file.size > 1_000_000) throw Error("Choose a CSV file smaller than 1 MB.");
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csv: await file.text() }),
      });
      const body = await res.json();
      if (!res.ok) throw Error(body.error);
      setCsvRows(body.rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the file.");
    } finally {
      setBusy(false);
    }
  }
  const costInput = JSON.stringify(record.rows.map(row => [row.amount, row.unitCost]));
  const [costs, setCosts] = useState<{ input: string; rows: (number | null)[]; total: number } | null>(null);
  const [costError, setCostError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/jobs/costs", { method: "POST", headers: { "Content-Type": "application/json" },
          body: costInput, signal: abort.signal });
        if (!res.ok) throw Error("Check the amounts and rates.");
        const body = await res.json();
        if (!abort.signal.aborted) { setCosts({ ...body, input: costInput }); setCostError(""); }
      } catch { if (!abort.signal.aborted) setCostError("Could not calculate the actual cost."); }
    }, 150);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [costInput]);
  const known = costs?.input === costInput ? costs.total : null;
  const recordedHours = record.rows
    .filter((r) => isTime(r.kind))
    .reduce((s, r) => s + (r.amount || 0), 0);
  const items = (rows: ActualRow[]) => (
    <ul className="finish-preview">
      {rows.map((r, i) => (
        <li key={i}>
          <b>{r.operation}</b>
          <span>
            {names[r.kind]} · {r.amount} {r.unit === "h" ? "hours" : r.unit}
            {r.unitCost === null
              ? ""
              : " × " + money(r.unitCost)}{rows === record.rows && costs?.input === costInput && costs.rows[i] != null && " = " + money(costs.rows[i]!)} ·{" "}
            {quote.items.find((q) => q.id === r.itemId)?.description.split("\n")[0]}
          </span>
          {r.exceptionReason && <small>One-time work · {r.exceptionReason}</small>}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="job-book">
      <header className="page-heading shelf-heading">
        <div>
          <h1>{readOnly ? "Saved job record" : "Record finished work"}</h1>
          <p>
            {quote.jobName} · {quote.customer} · {quote.number}, approved copy {quote.version}
          </p>
        </div>
        <a
          className="button secondary"
          href={"/quotes/" + quote.id + "/approval?version=" + quote.version}
        >
          See approved quote
        </a>
      </header>
      <div ref={statusRef} aria-live="polite">
        {notice && (
          <p className="finish-notice" role="status">
            {notice} <a href="/jobs">Back to finished work →</a>
          </p>
        )}
        {error && (
          <p className="finish-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {readOnly ? (
        <section className="panel">
          <div className="panel-heading">
            <h2>Completed {record.completedOn}</h2>
          </div>
          <div className="finish-body">
            {items(record.rows)}
            {record.scopeChanges && <p>Changes to the work · {record.scopeChanges}</p>}
            {record.overrideReasons && <p>Other differences · {record.overrideReasons}</p>}
            <a href={"/jobs/" + quote.id + "/" + quote.version} className="button secondary">
              Open latest job record
            </a>
          </div>
        </section>
      ) : (
        <form onSubmit={save}>
          <fieldset className="finish-stack" disabled={busy || !ready}>
            <section className="panel">
              <div className="panel-heading">
                <h2>What did the job take?</h2>
              </div>
              <div className="finish-body">
                <p>
                  Enter the total time or quantity for the whole job. Add another entry for each kind of
                  work or material.
                </p>
                {record.rows.map((r, i) => (
                  <Entry
                    key={i}
                    index={i}
                    row={r}
                    quote={quote}
                    onChange={(patch) =>
                      change({ rows: record.rows.map((v, j) => (j === i ? { ...v, ...patch } : v)) })
                    }
                    onRemove={() => {
                      setRemoved({ row: r, at: i });
                      change({ rows: record.rows.filter((_, j) => j !== i) });
                    }}
                  />
                ))}
                <div className="finish-buttons">
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => change({ rows: [...record.rows, newRow(quote)] })}
                  >
                    + Add time or cost
                  </button>
                  {removed && (
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => {
                        const rows = record.rows.slice();
                        rows.splice(removed.at, 0, removed.row);
                        change({ rows });
                        setRemoved(null);
                      }}
                    >
                      Undo removal
                    </button>
                  )}
                </div>
                <label className="field finish-date">
                  <span>Date finished</span>
                  <input
                    type="date"
                    required
                    value={record.completedOn}
                    onChange={(e) => change({ completedOn: e.target.value })}
                  />
                </label>
                <details
                  className="finish-fold"
                  open={!!record.scopeChanges || !!record.overrideReasons || undefined}
                >
                  <summary>Add job notes (optional)</summary>
                  <div className="finish-inputs">
                    <label className="field">
                      <span>What changed after the quote?</span>
                      <textarea
                        value={record.scopeChanges}
                        onChange={(e) => change({ scopeChanges: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span>Why did the time or cost change?</span>
                      <textarea
                        value={record.overrideReasons}
                        onChange={(e) => change({ overrideReasons: e.target.value })}
                      />
                    </label>
                  </div>
                </details>
                <div className="finish-buttons">
                  <button
                    className="button primary"
                    disabled={!record.rows.length || busy}
                    type="submit"
                  >
                    {busy ? <Activity>Saving job record</Activity> : "Save job record"}
                  </button>
                  <span>{dirty ? "Changes to save" : saved ? "Saved job record" : ""}</span>
                </div>
              </div>
            </section>
            <details className="panel finish-fold">
              <summary>Use a spreadsheet file</summary>
              <div className="finish-body">
                <p>
                  Save your spreadsheet as a CSV file with these column names. The example includes setup
                  time and material.
                </p>
                <a
                  download="actuals-template.csv"
                  href={
                    "data:text/csv;charset=utf-8," +
                    encodeURIComponent(
                      "line,category,operation,amount,unit,unit_cost\n1,setup,Fixture setup,1.5,h,\n1,material,Steel plate,10,piece,8\n",
                    )
                  }
                >
                  Download example CSV
                </a>
                <label className="field">
                  <span>Choose a CSV file</span>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void importCsv(file);
                      e.target.value = "";
                    }}
                  />
                </label>
                <small>
                  Use the quote line number, total hours or material quantity, and cost per unit. Add an
                  optional exception_reason column for one-time work.
                </small>
                {csvRows.length > 0 && (
                  <>
                    <h3>Check the imported entries</h3>
                    {items(csvRows)}
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => {
                        const rows =
                          record.edit === 0 &&
                          record.rows.length === 1 &&
                          JSON.stringify(record.rows[0]) === JSON.stringify(newRow(quote))
                            ? []
                            : record.rows;
                        change({ rows: [...rows, ...csvRows] });
                        setCsvRows([]);
                      }}
                    >
                      Add entries to this job
                    </button>
                  </>
                )}
              </div>
            </details>
          </fieldset>
        </form>
      )}
      <details className="panel finish-fold">
        <summary>Compare the estimate with the job</summary>
        <dl className="finish-summary">
          <div>
            <dt>Customer price</dt>
            <dd>{money(quote.totals.sellingPrice)}</dd>
          </div>
          <div>
            <dt>Estimated shop cost</dt>
            <dd>{money(quote.totals.estimatedCost)}</dd>
          </div>
          <div>
            <dt>Hours recorded</dt>
            <dd>{Number(recordedHours.toFixed(4))}</dd>
          </div>
          <div>
            <dt>
              {record.rows.some((r) => r.unitCost === null)
                ? "Recorded cost (some rates missing)"
                : "Recorded cost"}
            </dt>
            <dd>{known === null ? costError || <Activity>Calculating</Activity> : money(known)}</dd>
          </div>
        </dl>
      </details>
    </div>
  );
}
