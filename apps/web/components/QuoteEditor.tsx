"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Activity from "./Activity";
import ReviewAssistant from "./ReviewAssistant";
import DrawingBudget from "./DrawingBudget";
import AutomaticDrawingBudget from "./AutomaticDrawingBudget";
import {
  changedEstimateInputs,
  newCostRow,
  newLineItem,
  newQuoteDraft,
  type CostRow,
  type LineItem,
  type Quote,
  type QuoteDraft,
  type QuoteTotals,
} from "../lib/types";
import { statusLabels, type QuoteStatus } from "../lib/workflow-types";
import { drawingDraftCustomer, isDrawingDraftPart } from "../lib/quote-start";
import DrawingPanel from "./DrawingPanel";
import QuoteDrawingStart from "./QuoteDrawingStart";
import { Icon } from "./Icons";
import WorkspaceShell from "./WorkspaceShell";
import "./quote-editor.css";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
function fields({
  customer,
  jobName,
  notes,
  marginPercent,
  scrapBufferPct,
  benchmark,
  items,
}: QuoteDraft): QuoteDraft {
  return { customer, jobName, notes, marginPercent, items, scrapBufferPct, benchmark };
}
function priceRequest(draft: QuoteDraft) {
  return JSON.stringify({
    ...draft,
    customer: "",
    jobName: "",
    notes: "",
    items: draft.items.map((i) => ({
      ...i,
      description: "",
      costRows: i.costRows.map((r) => ({ ...r, label: "" })),
    })),
  });
}
function amountText(n: number) {
  return Number.isFinite(n) ? n : "";
}
function dollars(n?: number) {
  return n === undefined ? "…" : money.format(n);
}

function JobFields({
  draft,
  change,
  allowPending = false,
}: {
  draft: QuoteDraft;
  change: (value: Partial<QuoteDraft>) => void;
  allowPending?: boolean;
}) {
  const customerPending = draft.customer === drawingDraftCustomer;
  return (
    <div className="qe-fields" id="customer-details">
      <label className="field">
        <span>
          Customer name{" "}
          {customerPending && <small>Needed for the customer PDF</small>}
        </span>
        <input
          required={!allowPending}
          autoComplete="organization"
          maxLength={500}
          placeholder="Person or company"
          value={customerPending ? "" : draft.customer}
          onChange={(e) =>
            change({
              customer:
                e.target.value || (allowPending ? drawingDraftCustomer : ""),
            })
          }
        />
      </label>
      <label className="field">
        <span>Job name</span>
        <input
          required
          maxLength={500}
          placeholder="e.g. Loading dock handrail"
          value={draft.jobName}
          onChange={(e) => change({ jobName: e.target.value })}
        />
      </label>
      <label className="field qe-wide">
        <span>
          Customer notes <small>(optional)</small>
        </span>
        <textarea
          rows={2}
          maxLength={50000}
          placeholder="What did the customer ask for?"
          value={draft.notes}
          onChange={(e) => change({ notes: e.target.value })}
        />
      </label>
    </div>
  );
}
type CostProps = {
  row: CostRow;
  saved?: CostRow;
  cost?: number;
  quantity: number;
  newlyAdded: boolean;
  change: (patch: Partial<CostRow>) => void;
  remove: () => void;
};
function CostEntry({
  row,
  saved,
  cost,
  quantity,
  newlyAdded,
  change,
  remove,
}: CostProps) {
  const [open, setOpen] = useState(newlyAdded || !row.label);
  const template = row.estimate,
    needsReason = changedEstimateInputs(saved, row);
  const factor =
    row.basis === "batch"
      ? quantity > 1
        ? "once for all pieces"
        : "once"
      : quantity === 1
        ? "per piece"
        : "per piece × " + quantity + " pieces";
  const isTime = template
    ? /^(h|hr|hrs|hour|hours)$/i.test(template.unit)
    : /\(hours?\)$/i.test(row.label);
  const amountLabel = isTime
    ? "Hours"
    : template
      ? "Amount (" + template.unit + ")"
      : "Amount used";
  const rateLabel = isTime ? "Cost per hour ($)" : "Cost per unit ($)";
  return (
    <details
      className="qe-cost"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <span className="qe-cost-name">
          <strong>{row.label || "New cost"}</strong>
          <small>
            {amountText(row.amount)}
            {isTime ? " hr" : ""} × {dollars(row.rate)} · {factor}
          </small>
        </span>
        <span className="row-cost">{dollars(cost)}</span>
        <span className="qe-edit-label">{open ? "Close" : "Edit"}</span>
        <Icon name="down" size={15} />
      </summary>
      <div className="qe-cost-fields">
        {row.review?.unitCost!=null && <p className="qe-wide">Nick set this cost to {dollars(row.review.unitCost)} {row.basis==="batch"?"per batch":"per piece"}. Changing the amount or rate will use the calculated cost again.</p>}
        <label className="field qe-wide">
          <span>What is this cost?</span>
          <input
            value={row.label}
            required
            maxLength={500}
            placeholder="e.g. Steel, cutting time, or delivery"
            onChange={(e) => change({ label: e.target.value })}
          />
        </label>
        <label className="field">
          <span>{amountLabel}</span>
          <input
            type="number"
            step="any"
            min="0"
            required
            value={amountText(row.amount)}
            onChange={(e) => change({ amount: e.target.valueAsNumber })}
          />
        </label>
        <label className="field">
          <span>{rateLabel}</span>
          <input
            type="number"
            step="any"
            min="0"
            required
            value={amountText(row.rate)}
            onChange={(e) => change({ rate: e.target.valueAsNumber })}
          />
        </label>
        <label className="field qe-wide">
          <span>Count this cost</span>
          <select
            value={row.basis}
            onChange={(e) =>
              change({ basis: e.target.value as CostRow["basis"] })
            }
          >
            <option value="per_unit">For each piece</option>
            <option value="batch">Once for all pieces in this item</option>
          </select>
        </label>
        {template && (
          <div className="qe-wide qe-rule">
            <details>
              <summary>Where this cost came from</summary>
              <p>
                {template.templateName} ·{" "}
                {template.demo ? "Example shop rates" : "Shop rates"} ·{" "}
                {dollars(template.minimumCost)} minimum
              </p>
              <p>{template.rationale}</p>
              {template.templateId === "drawing-takeoff" && <>
                <p>{template.assumption}</p>
                <small>{template.rateId} · {template.rateSource}</small>
              </>}
            </details>
            <label className="field">
              <span>
                Reason for changing this cost{" "}
                {needsReason ? "(required)" : "(optional)"}
              </span>
              <input
                value={template.overrideReason}
                required={needsReason}
                maxLength={8000}
                onChange={(e) =>
                  change({
                    estimate: { ...template, overrideReason: e.target.value },
                  })
                }
              />
            </label>
          </div>
        )}
        <div className="qe-wide qe-edit-actions">
          <button
            type="button"
            className="button secondary"
            onClick={(event) => {
              const container = event.currentTarget.closest("details");
              for (const input of container?.querySelectorAll<HTMLInputElement>(
                "input",
              ) ?? []) {
                if (!input.reportValidity()) return;
              }
              setOpen(false);
              container?.querySelector("summary")?.focus();
            }}
          >
            Done editing cost
          </button>
          <button type="button" className="qe-text remove" onClick={remove}>
            <Icon name="trash" size={15} />
            Remove cost
          </button>
        </div>
      </div>
    </details>
  );
}
function ItemView({
  item,
  saved,
  index,
  totals,
  canRemove,
  change,
  remove,
}: {
  item: LineItem;
  saved?: LineItem;
  index: number;
  totals?: QuoteTotals["items"][number];
  canRemove: boolean;
  change: (p: Partial<LineItem>) => void;
  remove: () => void;
}) {
  const [adding, setAdding] = useState(false),
    [addedId, setAddedId] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);
  const add = (label: string, basis: CostRow["basis"]) => {
    const row = { ...newCostRow(), label, basis };
    setAdding(false);
    setAddedId(row.id);
    change({ costRows: [...item.costRows, row] });
  };
  useEffect(() => {
    if (addedId)
      document
        .getElementById("entry-" + addedId)
        ?.querySelector<HTMLInputElement>("input")
        ?.focus();
  }, [addedId]);
  return (
    <section className="qe-item" aria-label={"Item " + (index + 1)}>
      <div className="qe-item-head">
        <h3>Item {index + 1}</h3>
        {canRemove && (
          <button type="button" className="qe-text remove" onClick={remove}>
            <Icon name="trash" size={16} />
            Remove item
          </button>
        )}
      </div>
      <div className="qe-item-fields">
        <label className="field">
          <span>Part or service</span>
          <textarea
            rows={Math.min(8, item.description.split("\n").length)}
            value={item.description}
            required
            placeholder="e.g. Mounting plate"
            onChange={(e) => change({ description: e.target.value })}
          />
        </label>
        <label className="field">
          <span>{item.quantityPending ? "Working quantity" : "Quantity"}</span>
          <input
            type="number"
            min="1"
            step="1"
            required
            value={amountText(item.quantity)}
            onChange={(e) => change({ quantity: e.target.valueAsNumber })}
          />
          {item.quantityPending && <small>Confirm the actual order quantity before customer review.</small>}
        </label>
        {item.quantityPending && <button type="button" className="button secondary"
          disabled={!Number.isSafeInteger(item.quantity) || item.quantity < 1}
          onClick={() => change({ quantityPending: false })}>
          Confirm order quantity
        </button>}
      </div>
      {!!item.costRows.length && (
        <div className="qe-cost-list">
          {item.costRows.map((r) => (
            <div key={r.id} id={"entry-" + r.id}>
              <CostEntry
                row={r}
                saved={saved?.costRows.find((s) => s.id === r.id)}
                cost={totals?.rows.find((s) => s.id === r.id)?.cost}
                quantity={item.quantity}
                newlyAdded={r.id === addedId}
                change={(patch) =>
                  change({
                    costRows: item.costRows.map((s) =>
s.id === r.id ? { ...s, ...patch, ...(s.review?.unitCost!=null && ("rate" in patch || "amount" in patch || "basis" in patch) && {review:{...s.review,unitCost:undefined}}) } : s,
                    ),
                  })
                }
                remove={() => {
                  change({
                    costRows: item.costRows.filter((s) => s.id !== r.id),
                  });
                  addButton.current?.focus();
                }}
              />
            </div>
          ))}
        </div>
      )}
      <div className="qe-add">
        <button
          type="button"
          ref={addButton}
          aria-expanded={adding}
          className="button secondary"
          onClick={() => setAdding(!adding)}
        >
          <Icon name="plus" size={17} />
          Add a cost
        </button>
        {adding && (
          <div className="qe-cost-options" aria-label="Choose a cost">
            <button type="button" onClick={() => add("Material", "per_unit")}>
              Material
            </button>
            <button type="button" onClick={() => add("Labor (hours)", "batch")}>
              Labor
            </button>
            <button type="button" onClick={() => add("", "batch")}>
              Other cost
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

export default function QuoteEditor({
  initialQuote,
  initialStatus = "draft",
  initialDrawingId = null,
  reviewedDrawingId = null,
  sketchId = null,
  hasBlueprint = false,
  canApplyBenchmark = false,
  detailedReader = false,
  usePracticeRates = true,
  defaultMargin,
  canBuildTakeoff = false,
  automaticTakeoff = false,
  contingencyDefault = 0,
}: {
  initialQuote: Quote | null;
  initialStatus?: string;
  initialDrawingId?: string | null;
  reviewedDrawingId?: string | null;
  sketchId?: string | null;
  hasBlueprint?: boolean;
  canApplyBenchmark?: boolean;
  detailedReader?: boolean;
  usePracticeRates?: boolean;
  defaultMargin?: number;
  canBuildTakeoff?: boolean;
  automaticTakeoff?: boolean;
  contingencyDefault?: number;
}) {
  const [saved, setSaved] = useState(initialQuote);
  const [itemFilter, setItemFilter] = useState<"all"|"quantity"|"cost">("all");
  const [partQuery, setPartQuery] = useState("");
  const [pageStart, setPageStart] = useState(0);
  const [startMode, setStartMode] = useState<"drawing" | "manual">("drawing");
  const [drawingId, setDrawingId] = useState(initialDrawingId);
  const [draft, setDraft] = useState<QuoteDraft>(() =>
    initialQuote ? fields(initialQuote) : newQuoteDraft(defaultMargin),
  );
  const [baseline, setBaseline] = useState(() => JSON.stringify(draft));
  const [saving, setSaving] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const busy = useRef(false),
    editCount = useRef(0),
    navigating = useRef(false),
    nextHeading = useRef<HTMLHeadingElement>(null),
    newItemId = useRef("");
  const [removedItem, setRemovedItem] = useState<{
    item: LineItem;
    index: number;
  } | null>(null);
  const dirty = JSON.stringify(draft) !== baseline,
    calculation = priceRequest(draft);
  const [price, setPrice] = useState<{
    request: string;
    totals?: QuoteTotals;
    error?: string;
  }>(() =>
    initialQuote
      ? { request: calculation, totals: initialQuote.totals }
      : { request: "" },
  );
  const totals = price.request === calculation ? price.totals : undefined;
  const status =
    saved?.version === initialQuote?.version ? initialStatus : "draft";
  useEffect(() => {
    if (!saved || price.request === calculation) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/quotes/calculate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: calculation,
          signal: controller.signal,
        });
        const result = await response.json();
        if (!controller.signal.aborted)
          setPrice(
            response.ok
              ? { request: calculation, totals: result }
              : {
                  request: calculation,
                  error: result.error || "Check the amounts and prices.",
                },
          );
      } catch {
        if (!controller.signal.aborted)
          setPrice({
            request: calculation,
            error:
              "Could not update the price. Check the amounts and try again.",
          });
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [saved, calculation, price.request]);
  useEffect(() => {
    if (!dirty) return;
    function leave(e: BeforeUnloadEvent) {
      if (!navigating.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty]);
  useEffect(() => {
    if (saved && !initialQuote) nextHeading.current?.focus();
  }, [saved?.id, initialQuote]);
  useEffect(() => {
    if (newItemId.current) {
      document
        .getElementById("part-" + newItemId.current)
        ?.querySelector("textarea")
        ?.focus();
      newItemId.current = "";
    }
  }, [draft.items]);
  function update(patch: Partial<QuoteDraft>) {
    editCount.current++;
    setError("");
    setNotice("");
    setDraft((d) => ({ ...d, ...patch }));
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const sender = (event.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement | null;
    const next = sender?.name === "next" ? sender.value : "";
    const go = (id: string) => {
      if (next) {
        navigating.current = true;
        window.location.assign("/quotes/" + id + "/" + next);
      }
    };
    if (saved && !dirty) {
      setNotice("All changes saved");
      go(saved.id);
      return;
    }
    const creating = !saved,
      atStart = editCount.current;
    const submitted = creating
      ? {
          ...draft,
          items: [
            { ...draft.items[0], description: draft.jobName, costRows: [] },
          ],
        }
      : draft;
    busy.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        saved ? "/api/quotes/" + saved.id : "/api/quotes",
        {
          method: saved ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            saved ? { ...submitted, version: saved.version } : submitted,
          ),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw Error(result.error || "Could not save the quote. Try again.");
      const persisted = result as Quote,
        clean = fields(persisted);
      setSaved(persisted);
      setBaseline(JSON.stringify(clean));
      setDraft((d) =>
        editCount.current === atStart
          ? clean
          : creating
            ? { ...d, items: clean.items }
            : d,
      );
      setPrice({ request: priceRequest(clean), totals: persisted.totals });
      setNotice(creating ? "Quote started" : "All changes saved");
      setRemovedItem(null);
      if (creating)
        window.history.replaceState(
          window.history.state,
          "",
          "/quotes/" + persisted.id,
        );
      if (editCount.current === atStart) go(persisted.id);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save the quote. Try again.",
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  async function addBenchmark() {
    if (busy.current || !saved || dirty || draft.benchmark) return;
    busy.current = true;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/quotes/" + saved.id + "/benchmark", {
        method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({version:saved.version}),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || "Could not add benchmark costs.");
      const data = fields(result as Quote);
      setSaved(result as Quote);
      setDraft(data);
      setBaseline(JSON.stringify(data));
      setNotice("Benchmark costs saved");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Could not add benchmark costs.");
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  const id = saved?.id;
  const awaitsTakeoff = automaticTakeoff && !!saved && status === "draft" &&
    !draft.benchmark?.takeoff && drawingId === initialDrawingId;
  function acceptDrawingBudget(result: Quote) {
    if (dirty || busy.current) return false;
    const clean=fields(result);
    setSaved(result);
    setDraft(clean);
    setBaseline(JSON.stringify(clean));
    setPrice({request:priceRequest(clean),totals:result.totals});
    setNotice("Drawing budget saved as a new quote version.");
    return true;
  }
  const customerPending = saved?.customer === drawingDraftCustomer;
  const placeholder = draft.items.some(isDrawingDraftPart);
  const needsPrice = draft.items.some((item) => !item.costRows.length);
  const hasCosts = draft.items.some(item => item.costRows.some(row => row.amount > 0 && row.rate > 0 || (row.review?.unitCost ?? 0) > 0));
  const benchmarkAvailable = canApplyBenchmark && drawingId === initialDrawingId && needsPrice && !draft.benchmark;
  const quantityPending = draft.items.find((item) => item.quantityPending);
  const budgetGroups = new Map<string,number>();
  if (draft.benchmark?.takeoff && totals) {
    for (const item of draft.items) {
      const cost = totals.items.find(priced=>priced.id===item.id);
      item.costRows.forEach((row,index)=>{
        const group = row.estimate?.templateId === "drawing-takeoff" ? row.estimate.workType : "Other priced work";
        budgetGroups.set(group,(budgetGroups.get(group) ?? 0) + (cost?.rows[index]?.cost ?? 0));
      });
    }
  }
  const pricingNotes = new Map<string,string[]>();
  for (const line of draft.benchmark?.unpriced ?? []) {
    const split = line.indexOf(" · ");
    const part = split < 0 ? "" : line.slice(0,split);
    const question = split < 0 ? line : line.slice(split+3);
    const group = pricingNotes.get(question) || [];
    if (part && !group.includes(part)) group.push(part);
    pricingNotes.set(question,group);
  }
  const quantityCount = draft.items.filter(item=>item.quantityPending).length;
  const costCount = draft.items.filter(item=>!item.costRows.length).length;
  const matching = draft.items.filter(item=> (itemFilter === "all" || (itemFilter === "quantity" ? item.quantityPending : !item.costRows.length))
    && item.description.toLowerCase().includes(partQuery.trim().toLowerCase()));
  const partPageSize = 6;
  const first = Math.min(pageStart, Math.max(0, Math.floor((matching.length-1)/partPageSize)*partPageSize));
  const shown = new Set(matching.slice(first,first+partPageSize).map(item=>item.id));
  function revealPart(itemId:string, focus=false) {
    const index = draft.items.findIndex(item=>item.id === itemId);
    setItemFilter("all");setPartQuery("");setPageStart(Math.max(0,Math.floor(index/partPageSize)*partPageSize));
    requestAnimationFrame(()=>{
      const panel=document.getElementById("part-"+itemId);
      if(panel instanceof HTMLDetailsElement){panel.open=true;panel.scrollIntoView({block:"nearest"});if(focus)panel.querySelector<HTMLElement>("input:invalid, textarea:invalid")?.focus();}
    });
  }
  const checkDrawing =
    drawingId && drawingId !== reviewedDrawingId && (placeholder || needsPrice);
  const editDrawing = checkDrawing
    ? "review/" + encodeURIComponent(drawingId)
    : "";
  const reviewLabel = dirty ? "Save & review quote" : "Review quote";
  return (
    <WorkspaceShell
      breadcrumbs={[
        { label: "Quotes", href: "/quotes" },
        { label: saved?.number ?? "New quote" },
      ]}
      drawingsHref={id ? "#drawings" : undefined}
    >
      {!saved ? (
        <div className="qe-new">
          <header>
            <h1>Start a quote</h1>
            <p>Upload what the customer sent, or enter the job yourself.</p>
          </header>
          <div className="intake-layout">
          <div className="intake-work">
          <div className="work-switch" role="group" aria-label="How to start">
            <button type="button" aria-pressed={startMode === "drawing"} onClick={() => setStartMode("drawing")}><Icon name="drawing"/>From a drawing</button>
            <button type="button" aria-pressed={startMode === "manual"} onClick={() => setStartMode("manual")}><Icon name="details"/>Start without a drawing</button>
          </div>
          <div hidden={startMode !== "drawing"}>
          <QuoteDrawingStart
            detailedReader={detailedReader}
            onStart={(url) => {
              navigating.current = true;
              window.location.assign(url);
            }}
          />
          </div>
          <div className="panel qe-manual" hidden={startMode !== "manual"}>
            <form onSubmit={save}>
              <div className="qe-heading">
                <span className="qe-emblem">
                  <Icon name="details" size={22} />
                </span>
                <h2>Job details</h2>
              </div>
              <JobFields draft={draft} change={update} />
              {error && (
                <p className="error-banner" role="alert">
                  {error}
                </p>
              )}
              <div className="qe-start-footer">
                <button
                  type="submit"
                  className="button primary"
                  disabled={saving}
                >
                  {saving ? <Activity>Saving</Activity> : "Save & add work"}{" "}
                  <Icon name="arrow" size={17} />
                </button>
              </div>
            </form>
          </div>
          </div>
          <aside className="intake-side" aria-label="How a quote works">
            <h2>What happens next</h2>
            <ol className="intake-steps">
              <li><strong>{startMode === "drawing" ? "Check the drawing" : "List the work"}</strong><span>{startMode === "drawing" ? "Review the parts and confirm what the shop will supply." : "Add the pieces and services the customer needs."}</span></li>
              <li><strong>Set the price</strong><span>Check material, time and the price for the customer.</span></li>
              <li><strong>Review and approve</strong><span>Confirm the scope and lead time, then download the proposal.</span></li>
            </ol>
          </aside>
          </div>
        </div>
      ) : (
        <div className="qe-editor">
          <header className="qe-title">
            <div>
              <span className="qe-status">
                {statusLabels[status as QuoteStatus] || "Draft"}
              </span>
              <h1>{draft.jobName || "Untitled job"}</h1>
              <p>
                {draft.customer} · {saved.number}
              </p>
              {sketchId && <p><a href={"/sketches/" + encodeURIComponent(sketchId)}>Open source sketch</a></p>}
 
            </div>
            <div className="qe-save" data-dirty={dirty}>
              <span role="status">
                {saving
                  ? <Activity>Saving</Activity>
                  : dirty
                    ? "Unsaved changes"
                    : <Activity done>{notice || "Saved"}</Activity>}
              </span>
              <button
                className="button secondary"
                type="submit"
                form="work-editor"
                disabled={saving || !dirty}
              >
                <Icon name="save" size={17} />
                Save changes
              </button>
            </div>
          </header>
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
          <nav className="qe-mobile-jumps" aria-label="Jump to a section">
            <a href="#quote-price">See price</a><a href="#parts">Parts &amp; work</a><a href="#drawings">Go to drawings</a>
          </nav>
          <div className="qe-layout">
            <div className="qe-work">
          <section className="panel qe-next" aria-label="Next step">
            <div>
              <h2>
                {awaitsTakeoff ? "Building the estimate" : checkDrawing
                  ? "Check what’s on the drawing"
                  : quantityPending
                    ? "Confirm order quantities"
                    : needsPrice
                    ? "Price the job"
                    : "Review & make the customer PDF"}
              </h2>
              <p>
                {awaitsTakeoff ? "The full drawing budget will appear here. You can review its scope and assumptions when it is ready." : checkDrawing
                  ? "Check the parts, quantity, and anything the drawing leaves out."
                  : quantityPending
                    ? "Check how many pieces the customer wants. Open a part to confirm its quantity or remove it from the quote."
                    : needsPrice
                    ? "Use your shop’s costs for materials and time, or enter costs by hand."
                    : "Check the customer, work included, and lead time before you approve."}
              </p>
            </div>
            {!awaitsTakeoff && <div className="qe-next-actions">
              {quantityPending && !checkDrawing ? <a className="button primary" href={"#part-" + quantityPending.id}
                onClick={() => revealPart(quantityPending.id)}>Check quantities</a> : <button
                form="work-editor"
                type="submit"
                name="next"
                value={editDrawing || (needsPrice ? "estimate" : "approval")}
                className="button primary"
                disabled={saving}
              >
                {checkDrawing
                  ? "Review drawing"
                  : needsPrice
                    ? "Price the job"
                    : reviewLabel}
                <Icon name="arrow" size={17} />
              </button>}
              {needsPrice && hasBlueprint && <a href="#quote-assistant" onClick={() => {
                const panel = document.getElementById("quote-assistant");
                if (panel instanceof HTMLDetailsElement) panel.open = true;
              }}>Plan costs with AI</a>}
 
            </div>}
          </section>
 
            <form className="qe-work" id="work-editor" onSubmit={save}>
              <details
                className="panel qe-customer"
                onInvalidCapture={event => { event.currentTarget.open = true; }}
              >
                <summary>
                  <Icon name="details" size={19} />
                  <b>Customer &amp; job details</b>
                  {customerPending && <small>Add customer</small>}
                  <Icon name="down" size={17} />
                </summary>
                <JobFields
                  draft={draft}
                  change={update}
                  allowPending={customerPending}
                />
              </details>
              <section className="panel" id="parts">
                <div className="qe-heading">
                  <span className="qe-emblem">
                    <Icon name="items" size={21} />
                  </span>
                  <div>
                    <h2 ref={nextHeading} tabIndex={-1}>
                      Parts &amp; work
                    </h2>
                    <p>
                      Amounts below are shop costs. Open a part to edit its quantity, material or time.
                    </p>
                  </div>
                </div>
                {(draft.items.length > 3 || itemFilter !== "all" || partQuery) && <div className="quote-index">
                  <label className="part-search"><Icon name="search" size={16}/><input type="search" value={partQuery} aria-label="Find a part or service" placeholder="Find a part or service" onChange={e=>{setPartQuery(e.target.value);setPageStart(0);}}/></label>
                  <div className="part-filters" role="group" aria-label="Which parts to show">
                    {([["all","All parts",draft.items.length],["quantity","Confirm quantity",quantityCount],["cost","Missing costs",costCount]] as const)
                      .map(([value,title,count])=><button type="button" key={value} aria-pressed={itemFilter===value}
                        onClick={()=>{setItemFilter(value);setPageStart(0);}}>{title} <span>{count}</span></button>)}
                  </div>
                </div>}
                {matching.length === 0 && <div className="parts-empty">No parts match this view. <button type="button" onClick={()=>{setItemFilter("all");setPartQuery("");setPageStart(0);}}>Show all parts</button></div>}
                {draft.items.map((item, index) => (
                  <details key={item.id} id={"part-" + item.id} className="qe-part-group" hidden={!shown.has(item.id)}
                    open={(initialQuote?.items.length ?? 0) <= 3 || !initialQuote?.items.some(original => original.id === item.id) || undefined}
                    onInvalidCapture={event => { event.currentTarget.open = true; if(!shown.has(item.id))revealPart(item.id,true); }}>
                    <summary>
                      <span className="part-summary-name">{item.description.split(/\r?\n/)[0] || "New item"}<small>{item.quantityPending ? "Confirm quantity" : "Qty " + item.quantity}</small></span>
                      <strong className="part-summary-cost" data-missing={!item.costRows.length}>{item.costRows.length ? dollars(totals?.items.find(line => line.id === item.id)?.cost) : "Add costs"}</strong>
                      <Icon name="down" size={16}/>
                    </summary>
                    <ItemView
                      item={item}
                      saved={saved.items.find((i) => i.id === item.id)}
                      index={index}
                      canRemove={draft.items.length > 1}
                      totals={totals?.items.find((i) => i.id === item.id)}
                      change={(patch) =>
                        update({
                          items: draft.items.map((i) =>
                            i.id === item.id ? { ...i, ...patch } : i,
                          ),
                        })
                      }
                      remove={() => {
                        setRemovedItem({ item, index });
                        update({
                          items: draft.items.filter((i) => i.id !== item.id),
                        });
                      }}
                    />
                  </details>
                ))}
                {matching.length > partPageSize && <nav className="part-pages" aria-label="More parts">
                  <button type="button" disabled={first===0} onClick={()=>setPageStart(first-partPageSize)}>Previous</button>
                  <span role="status">{first+1}–{Math.min(first+partPageSize,matching.length)} of {matching.length} parts</span>
                  <button type="button" disabled={first+partPageSize>=matching.length} onClick={()=>setPageStart(first+partPageSize)}>Next parts</button>
                </nav>}
                <div className="qe-item-footer">
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => {
                      const item = { ...newLineItem(), costRows: [] };
                      setItemFilter("all");setPartQuery("");setPageStart(Math.floor(draft.items.length/partPageSize)*partPageSize);
                      newItemId.current = item.id;
                      update({ items: [...draft.items, item] });
                    }}
                  >
                    <Icon name="plus" size={17} />
                    Add another item
                  </button>
                  {removedItem && (
                    <button
                      type="button"
                      className="qe-text"
                      onClick={() => {
                        const items = [...draft.items];
                        items.splice(removedItem.index, 0, removedItem.item);
                        update({ items });
                        setRemovedItem(null);
                      }}
                    >
                      Undo removed item
                    </button>
                  )}
                </div>
              </section>
              <div className="qe-shortcuts">
                {!needsPrice && (
                  <button
                    type="submit"
                    name="next"
                    value="estimate"
                    className="button secondary"
                    disabled={saving}
                  >
                    <Icon name="calculator" size={18} />
                    Use a shop template
                  </button>
                )}
                <a href={"/inbox?quoteId=" + id + "&version=" + saved.version}>
                  Customer emails <Icon name="arrow" size={15} />
                </a>
              </div>
            </form>
            </div>
            <aside className="qe-aside">
              <section
                className="panel qe-price"
                id="quote-price"
                tabIndex={-1}
              >
                <div className="qe-price-head">
                  <span>{awaitsTakeoff ? "Full drawing budget" : draft.benchmark?.takeoff ? (draft.benchmark.takeoff.scope==="installed" ?
                    (totals && totals.shopOnlySellingPrice === undefined ? "Fabrication budget" : "Installed budget") : "Shop-only budget") :
                    draft.benchmark ? (draft.benchmark.demo === false ? "Shop budget subtotal" : "Demo budget subtotal") : quantityPending || hasBlueprint && needsPrice ? "Budget price so far" : "Customer price"}</span>
                  <strong data-testid="selling-price">
                    {awaitsTakeoff ? "Pending" : price.request !== calculation ? <Activity>Updating</Activity> : price.error ? "Check inputs" : !hasCosts && !totals?.sellingPrice ? "Awaiting costs" : dollars(totals?.sellingPrice)}
                  </strong>
                  {totals?.shopOnlySellingPrice !== undefined && !awaitsTakeoff && <small>Shop-only option {dollars(totals.shopOnlySellingPrice)}</small>}
                  <small>{quantityPending ? "Uses working quantities · Before tax" : "Before tax"}</small>
                </div>
                <div className="qe-price-body">
                  {awaitsTakeoff && saved && <AutomaticDrawingBudget key={saved.version} id={saved.id} version={saved.version} onSave={acceptDrawingBudget}/>}
                  {!awaitsTakeoff && canBuildTakeoff && saved && status === "draft" && drawingId === initialDrawingId &&
                    <DrawingBudget key={saved.version} quote={saved} disabled={dirty || saving} contingencyDefault={contingencyDefault}
                      onApply={acceptDrawingBudget}/>}
                  {!awaitsTakeoff && draft.benchmark && <div className="qe-benchmark">
                    <strong>{draft.benchmark.name}</strong>
                    {draft.benchmark.takeoff?.scopeSummary && <p>{draft.benchmark.takeoff.scopeSummary}</p>}
                    {draft.benchmark.takeoff?.drawingStatus && <small>{draft.benchmark.takeoff.drawingStatus}</small>}
                    <p>{draft.benchmark.takeoff ? `Includes ${draft.benchmark.takeoff.contingencyPercent}% contingency. Review the assumed stock, hours and scope before sending.` :
                      draft.benchmark.demo === false ? "Partial budget. This covers the shop costs entered so far." :
                        "Partial budget. This covers only the operations and materials already priced."}</p>
                    {budgetGroups.size > 0 && <dl className="qe-budget-totals">
                      {[...budgetGroups].map(([group,cost])=><div key={group}><dt>{group}</dt><dd>{dollars(cost)}</dd></div>)}
                      {!!totals?.contingencyCost && <div><dt>Contingency</dt><dd>{dollars(totals.contingencyCost)}</dd></div>}
                    </dl>}
                    {!!draft.benchmark.unpriced.length && <details>
                      <summary>Pricing questions ({pricingNotes.size})</summary>
                      <div className="pricing-questions">{Array.from(pricingNotes,([question,parts])=><div key={question}>
                        <strong>{question}</strong>
                        {parts.length>0 && <details><summary>{parts.length} affected {parts.length===1?"part":"parts"}</summary>
                          <ul>{parts.map(part=>{
                            const item = draft.items.find(line=>line.description.split("\n")[0]===part);
                            return <li key={part}>{item ? <a href={"#part-"+item.id} onClick={()=>revealPart(item.id)}>{part}</a> : part}</li>;
                          })}</ul></details>}
                      </div>)}</div>
                    </details>}
                  </div>}
                  {benchmarkAvailable && !awaitsTakeoff && <div className="qe-benchmark">
                    <button className="button secondary" type="button" onClick={() => void addBenchmark()} disabled={saving || dirty}>
                      {usePracticeRates ? "Add U.S. benchmark costs" : "Add shop budget costs"}
                    </button>
                    <p>{dirty ? "Save changes before filling costs." : usePracticeRates ? "Fill unpriced drawing lines with editable demo allowances." : "Fill drawing costs from your current rates where the drawing supports them."}</p>
                  </div>}
                  <div className="summary-row">
                    <span>Shop cost</span>
                    <strong>{!hasCosts && !totals?.estimatedCost ? "—" : dollars(totals?.estimatedCost)}</strong>
                  </div>
                  <details className="qe-margin">
                    <summary>
                      Change profit margin <Icon name="down" size={15} />
                    </summary>
                    <label className="field">
                      <span>Target gross margin (%)</span>
                      <input
                        form="work-editor"
                        required
                        type="number"
                        min="0"
                        max="99.9999"
                        step="any"
                        value={amountText(draft.marginPercent)}
                        onChange={(e) =>
                          update({ marginPercent: e.target.valueAsNumber })
                        }
                      />
                    </label>
                    <p>The share of the selling price left after shop costs.</p>
                  </details>
                  {price.request === calculation && price.error && (
                    <p role="alert" className="field-error">
                      {price.error}
                    </p>
                  )}
                  {!draft.items.some((i) => i.costRows.length > 0) && (
                    <p className="qe-first-cost">
                      Add a cost to see the price for this job.
                    </p>
                  )}
                  {needsPrice && (
                    <button
                      form="work-editor"
                      type="submit"
                      name="next"
                      value="approval"
                      className="button secondary"
                      disabled={saving}
                    >
                      {reviewLabel} <Icon name="arrow" size={17} />
                    </button>
                  )}
                </div>
              </section>
              <ReviewAssistant kind="quote" id={saved.id} version={saved.version} draft={draft}
                sourceRevision={drawingId ?? (hasBlueprint ? "blueprint" : null)} locked={saving} onApply={update}/>
              <nav className="qe-tools-list" aria-label="Drawing and pricing tools">
                {dirty ? <button form="work-editor" type="submit" name="next" value="workspace" disabled={saving}>Save &amp; open drawing and quote workspace <Icon name="arrow" size={16}/></button> :
                  <a href={"/quotes/"+saved.id+"/workspace"}>Drawing &amp; quote workspace <Icon name="arrow" size={16}/></a>}
                {hasBlueprint && <a href={"/quotes/"+saved.id+"/blueprint"}>View drawing and original estimate <Icon name="arrow" size={16}/></a>}
              </nav>
              <DrawingPanel
                quoteId={saved.id}
                dirty={dirty}
                onSelectionChange={setDrawingId}
                onDrawingChange={async () => {
                  // Selecting a new drawing can open a new quote version after a review.
                  const response = await fetch("/api/quotes/" + saved.id, {
                    cache: "no-store",
                  }).catch(() => null);
                  if (!response?.ok) return;
                  const fresh = (await response.json()) as Quote;
                  setSaved((previous) =>
                    previous &&
                    fresh.version > previous.version &&
                    JSON.stringify(fields(fresh)) ===
                      JSON.stringify(fields(previous))
                      ? fresh
                      : previous,
                  );
                }}
              />
            </aside>
          </div>
        </div>
      )}
    </WorkspaceShell>
  );
}
