"use client";

import Activity from "@/components/Activity";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icons";
import ReviewSource from "./ReviewSource";
import { fieldKeys, fieldLabels } from "@/lib/review-types";
import { drawingDraftCustomer, isDrawingDraftPart } from "@/lib/quote-start";
import {
  pricingDecisionLabels,
  statusLabels,
  type QuoteReviewView,
  type PricingDecision,
} from "@/lib/workflow-types";

const money = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD" });
const date = (value: string) =>
  new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  });
const shopDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
type TextField = "scope" | "leadTime" | "terms" | "expiresOn" | "assumptions";
const customerInput = (name: string) => name === drawingDraftCustomer ? "" : name;

export default function QuoteApproval({ initial }: { initial: QuoteReviewView }) {
  const [view, setView] = useState(initial);
  const [details, setDetails] = useState(initial.snapshot.details);
  const [customer, setCustomer] = useState(() => customerInput(initial.snapshot.quote.customer));
  const [pendingAction, setAction] = useState("");
  const busy = !!pendingAction;
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [page, setPage] = useState(1);
  const heading = useRef<HTMLHeadingElement>(null);
  const { quote, drawing, reviewRuns, questions } = view.snapshot;
  const decision = details.pricingDecision;
  const needsReason = view.pricingReasonRequired || (!!decision && decision.kind !== "standard");
  const path = "/quotes/" + encodeURIComponent(quote.id);
  const api = "/api" + path + "/approval";
  const current = view.currentVersion === quote.version;
  const editable = current && view.status === "draft";
  const awaitingApproval = current && view.status === "awaiting_review";
  const pendingPart = editable && quote.items.some(isDrawingDraftPart);
  const pendingQuantity = editable && quote.items.find(item => item.quantityPending);
  const usingDemoRates = editable && quote.items.some(item => item.costRows.some(row => row.estimate?.demo));
  const noCosts = editable && !pendingPart && quote.items.every(item => item.costRows.length === 0);
  const dirty = customer !== customerInput(quote.customer) || JSON.stringify(details) !== JSON.stringify(view.snapshot.details);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function act(action: string) {
    if (busy) return;
    setAction(action);
    setError("");
    setFeedback("");
    try {
      const response = await fetch(api, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          version: quote.version,
          drawingId: drawing?.id ?? null,
          details,
          ...(editable ? { customer } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save this quote. Try again.");
      const next = data as QuoteReviewView;
      setView(next);
      setDetails(next.snapshot.details);
      setCustomer(customerInput(next.snapshot.quote.customer));
      setFeedback(
        action === "save"
          ? "Your progress is saved."
          : action === "approve"
            ? "Approved. The customer PDF is ready."
            : action === "submit"
              ? "Ready for Nick to approve."
              : "Saved.",
      );
      window.history.replaceState(null, "", path + "/approval?version=" + next.snapshot.quote.version);
      if (action !== "save")
        requestAnimationFrame(() => {
          heading.current?.focus();
          heading.current?.scrollIntoView({ block: "start" });
        });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this quote. Try again.");
    } finally {
      setAction("");
    }
  }

  function change(key: TextField, value: string) {
    setDetails((previous) => ({
      ...previous,
      [key]: value,
      ...(key === "scope"
        ? { scopeConfirmed: false }
        : key === "leadTime"
          ? { leadTimeConfirmed: false }
          : {}),
    }));
    setFeedback("");
  }
  function field(label: string, key: TextField, rows = 0, example = "") {
    const needsInput = key !== "assumptions" && !details[key].trim();
    return (
      <label className="approval-field" data-needs-input={needsInput || undefined}>
        <span>{label} {needsInput && <small aria-hidden="true">Required</small>}</span>
        {rows ? (
          <textarea
            aria-label={label}
            required={key !== "assumptions"}
            rows={rows}
            value={details[key]}
            placeholder={example}
            onChange={(e) => change(key, e.target.value)}
          />
        ) : (
          <input
            aria-label={label}
            required
            type={key === "expiresOn" ? "date" : "text"}
            min={key === "expiresOn" ? shopDate() : undefined}
            value={details[key]}
            placeholder={example}
            onChange={(e) => change(key, e.target.value)}
          />
        )}
      </label>
    );
  }
  const button = (action: string, label: string, primary = false) => (
    <button
      type="button"
      className={"button " + (primary ? "primary" : "secondary")}
      disabled={busy || !ready}
      onClick={() => act(action)}
    >
      {label}
    </button>
  );
  const pricingFields = (
    <div className="approval-fields">
      <p>
        First saved price {money(view.startingPrice.sellingPrice)} · Current price{" "}
        {money(quote.totals.sellingPrice)}
      </p>
      {editable ? (
        <>
          <label className="approval-field">
            <span>What changed?</span>
            <select
              value={decision?.kind ?? "standard"}
              onChange={(e) =>
                setDetails({
                  ...details,
                  pricingDecision: {
                    kind: e.target.value as PricingDecision["kind"],
                    reason: decision?.reason ?? "",
                  },
                })
              }
            >
              {Object.entries(pricingDecisionLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="approval-field" data-needs-input={needsReason && !decision?.reason.trim() || undefined}>
            <span>Reason for this price{needsReason ? "" : " (optional)"}</span>
            <textarea
              rows={2}
              required={needsReason}
              value={decision?.reason ?? ""}
              maxLength={3000}
              placeholder="For example, a discount on this order only"
              onChange={(e) =>
                setDetails({
                  ...details,
                  pricingDecision: { kind: decision?.kind ?? "standard", reason: e.target.value },
                })
              }
            />
          </label>
        </>
      ) : (
        <p>
          {decision ? pricingDecisionLabels[decision.kind] : "No pricing note"}
          {decision?.reason && " · " + decision.reason}
        </p>
      )}
    </div>
  );
  const lineItems = (
    <div className="approval-customer-lines">
      {quote.items.map((line, i) => (
        <div key={line.id}>
          <div>
            <strong>{details.lineDescriptions[line.id]}</strong>
            <small>Qty {line.quantity}</small>
          </div>
          <b>{money(view.customer.lines[i].sellingPrice)}</b>
        </div>
      ))}
    </div>
  );
  const title = editable
    ? "Review & make PDF"
    : awaitingApproval
      ? "Check and approve quote"
      : view.approvedAt
        ? "Customer quote"
        : "Saved quote";

  return (
    <div className="approval-review">
      <header className="approval-heading">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            {title}
          </h1>
          <p>{quote.jobName}{customerInput(quote.customer) && " · " + quote.customer}</p>
        </div>
        <a className="approval-link" href={path}>Back to quote</a>
      </header>
      <section className="approval-summary" aria-label="Quote at a glance">
        <div>
          <span>Customer price before tax</span>
          <strong>{money(view.customer.sellingPrice)}</strong>
        </div>
        <div className="approval-summary-next">
          {(awaitingApproval || view.approvedAt) && (
            <div className="approval-summary-action">
              {awaitingApproval ? (
                button("approve", "Approve and create PDF", true)
              ) : (
                <a
                  className="button primary"
                  href={api + "/pdf?version=" + quote.version}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open customer PDF <Icon name="arrow" size={18} />
                </a>
              )}
            </div>
          )}
          <p>{quote.number} · <b>{statusLabels[view.status]}</b></p>
        </div>
      </section>
      {feedback && (
        <p role="status" className="approval-feedback">
          {feedback}
        </p>
      )}
      <div className="approval-columns">
        <div className="approval-main">
          {editable ? (
            <form
              className="panel approval-form"
              onSubmit={(e) => {
                e.preventDefault();
                void act("submit");
              }}
            >
              <div className="panel-heading">
                <h2>Customer quote details</h2>
              </div>
              <fieldset disabled={busy || !ready} className="approval-fields">
                {pendingPart && (
                  <div className="approval-attention">
                    <p><b>Add the parts to quote.</b> The first line is waiting for a part description.</p>
                    <a className="button secondary" href={path + "#parts"}>Go to parts &amp; work</a>
                  </div>
                )}
                {pendingQuantity && (
                  <div className="approval-attention">
                    <p><b>Confirm the order quantities.</b> Some lines still use working quantities.</p>
                    <a className="approval-link" href={path + "#part-" + pendingQuantity.id}>Go to the first open quantity</a>
                  </div>
                )}
                {noCosts && (
                  <div className="approval-attention">
                    <p><b>No costs entered.</b> Add costs for a paid job.</p>
                    <a className="approval-link" href={path + "#parts"}>Go to parts &amp; work</a>
                  </div>
                )}
                {usingDemoRates && (
                  <div className="approval-attention">
                    <p><b>This quote uses demo rates.</b> Ask Nick to confirm the prices before sharing it.</p>
                    <a className="approval-link" href="/settings">Open shop settings</a>
                  </div>
                )}
                <label className="approval-field" data-needs-input={!customer.trim() || undefined}>
                  <span>Customer name {!customer.trim() && <small aria-hidden="true">Required</small>}</span>
                  <input
                    value={customer}
                    required
                    maxLength={500}
                    autoComplete="organization"
                    placeholder="Person or company receiving the quote"
                    onChange={(e) => {
                      setCustomer(e.target.value);
                      setFeedback("");
                    }}
                  />
                </label>
                {field(
                  "Work included",
                  "scope",
                  2,
                  "For example, cut, drill and deliver 10 mounting plates.",
                )}
                {!details.scope.trim() && (
                  <button
                    type="button"
                    className="button secondary approval-use-lines"
                    onClick={() =>
                      change(
                        "scope",
                        quote.items
                          .map(
                            (i) =>
                              i.quantity +
                              " × " +
                              (details.lineDescriptions[i.id] || i.description.split("\n")[0]),
                          )
                          .join("\n"),
                      )
                    }
                  >
                    Use items from this quote
                  </button>
                )}
                {field(
                  "When can the work be ready?",
                  "leadTime",
                  0,
                  "For example, 2 weeks after the order is placed",
                )}
                {field("Payment and other terms", "terms", 2, "For example, payment due on delivery")}
                {field("Customer can accept until", "expiresOn")}
                <details
                  className="approval-fold"
                  open={quote.items.some((i) => !details.lineDescriptions[i.id]?.trim()) || undefined}
                >
                  <summary>Parts and prices on the quote</summary>
                  <div className="approval-fields">
                    {quote.items.map((item, i) => (
                      <label className="approval-field" key={item.id} data-needs-input={!details.lineDescriptions[item.id]?.trim() || undefined}>
                        <span>
                          Item {i + 1} · Qty {item.quantity} ·{" "}
                          {money(view.customer.lines[i].sellingPrice)}
                        </span>
                        <textarea
                          required
                          rows={2}
                          value={details.lineDescriptions[item.id] ?? ""}
                          onChange={(e) =>
                            setDetails({
                              ...details,
                              scopeConfirmed: false,
                              lineDescriptions: {
                                ...details.lineDescriptions,
                                [item.id]: e.target.value,
                              },
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                </details>
                {questions.length > 0 && (
                  <section className="approval-questions">
                    <h3>Details to confirm</h3>
                    <p>Enter the customer’s answer or explain what the quote leaves out.</p>
                    {questions.map((q) => (
                      <label key={q.id} className="approval-field" data-needs-input={!details.resolutions[q.id]?.trim() || undefined}>
                        <span>{q.label}</span>
                        <textarea
                          rows={2}
                          required
                          value={details.resolutions[q.id] ?? ""}
                          onChange={(e) =>
                            setDetails({
                              ...details,
                              scopeConfirmed: false,
                              resolutions: { ...details.resolutions, [q.id]: e.target.value },
                            })
                          }
                        />
                      </label>
                    ))}
                  </section>
                )}
                <details className="approval-fold" open={needsReason || undefined}>
                  <summary>
                    {needsReason ? "Explain the price change" : "Add a pricing note (optional)"}
                  </summary>
                  {pricingFields}
                </details>
                <details className="approval-fold">
                  <summary>Shop-only notes (optional)</summary>
                  <div className="approval-fields">
                    {field("Assumptions behind this estimate", "assumptions", 2)}
                  </div>
                </details>
                <label className="approval-check">
                  <input
                    required
                    type="checkbox"
                    checked={details.scopeConfirmed && details.leadTimeConfirmed}
                    onChange={(e) =>
                      setDetails({
                        ...details,
                        scopeConfirmed: e.target.checked,
                        leadTimeConfirmed: e.target.checked,
                      })
                    }
                  />{" "}
                  I checked the work included and the timing.
                </label>
                {error && (
                  <p className="approval-error" role="alert">
                    {error}
                  </p>
                )}
                <div className="approval-submit">
                  <div className="approval-buttons">
                    <button className="button primary" type="submit" disabled={pendingPart || !!pendingQuantity}>
                      {busy ? <Activity>Saving review</Activity> : "Continue to approval"} <Icon name="arrow" size={18} />
                    </button>
                    {button("save", "Save for later")}
                  </div>
                  {dirty && <small>Changes to save</small>}
                </div>
              </fieldset>
            </form>
          ) : (
            <>
              <section className="panel">
                <div className="panel-heading">
                  <h2>Customer copy</h2>
                </div>
                <div className="approval-fields">
                  <div>
                    <b>Work included</b>
                    <p>{details.scope || "No scope saved."}</p>
                  </div>
                  {lineItems}
                  <dl className="approval-pairs">
                    <div>
                      <dt>Ready in</dt>
                      <dd>{details.leadTime || "Not entered"}</dd>
                    </div>
                    <div>
                      <dt>Terms</dt>
                      <dd>{details.terms || "Not entered"}</dd>
                    </div>
                    <div>
                      <dt>Valid through</dt>
                      <dd>{details.expiresOn}</dd>
                    </div>
                  </dl>
                  {awaitingApproval && (
                    <p>Nick’s approval locks this price and creates the customer PDF.</p>
                  )}
                  {view.approvedAt && (
                    <>
                      <small>Nick approved this copy on {date(view.approvedAt)}.</small>
                      {current && view.status === "approved" && (
                        <a
                          className="button secondary"
                          href={
                            "/inbox?quoteId=" +
                            encodeURIComponent(quote.id) +
                            "&version=" +
                            quote.version
                          }
                        >
                          Email this quote
                        </a>
                      )}
                    </>
                  )}
                  {view.status === "sent" && (
                    <div>
                      <p>Did the customer accept?</p>
                      <div className="approval-buttons">
                        {button("accept", "Customer accepted", true)}
                        {button("decline", "Customer declined")}
                      </div>
                    </div>
                  )}
                  {view.approvedAt && (
                    <a
                      className="approval-link"
                      href={"/jobs/" + encodeURIComponent(quote.id) + "/" + quote.version}
                    >
                      Record finished work →
                    </a>
                  )}
                  {current && view.status !== "draft" && button("revise", "Make a revised quote")}
                  {!current && (
                    <a className="approval-link" href={path + "/approval"}>
                      Open latest quote →
                    </a>
                  )}
                  {error && (
                    <p className="approval-error" role="alert">
                      {error}
                    </p>
                  )}
                </div>
              </section>
              {!!questions.length && (
                <details className="panel approval-fold">
                  <summary>Answers from the customer</summary>
                  <div className="approval-fields">
                    {questions.map((q) => (
                      <div key={q.id}>
                        <b>{q.label}</b>
                        <p>{details.resolutions[q.id] || "Awaiting answer"}</p>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
        </div>
        <aside className="approval-side">
          <section className="panel">
            <div className="panel-heading">
              <h2>Check job details</h2>
            </div>
            <details className="approval-fold">
              <summary>{drawing ? "Drawing and customer request" : "Customer request"}</summary>
              {drawing ? (
                <ReviewSource
                  quoteId={quote.id}
                  revision={drawing}
                  notes={quote.notes}
                  active
                  page={page}
                  onPageChange={setPage}
                />
              ) : (
                <div className="approval-fields">
                  <p>{quote.notes || "No customer note saved."}</p>
                  <a className="approval-link" href={path + "#drawings"}>
                    Open drawings →
                  </a>
                </div>
              )}
            </details>
            {reviewRuns.length > 0 && (
              <details className="approval-fold">
                <summary>Drawing details</summary>
                <div className="approval-fields">
                  {reviewRuns.map((run) => (
                    <div key={run.id}>
                      {run.parts.map((part, i) => {
                        const c = run.corrections[i];
                        if (!c?.selected) return null;
                        return (
                          <details key={i} className="approval-fold">
                            <summary>
                              {c.values.description ||
                                part.fields.description.value ||
                                "Part " + (i + 1)}
                            </summary>
                            <dl className="approval-pairs">
                              {fieldKeys.map((key) => (
                                <div key={key}>
                                  <dt>{fieldLabels[key]}</dt>
                                  <dd>
                                    {details.resolutions[run.id + "/" + i + "/" + key] ||
                                      c.values[key] ||
                                      part.fields[key].value ||
                                      part.fields[key].status}
                                    {part.fields[key].evidence.map((v, j) => (
                                      <small key={j}>
                                        {v.page ? "Drawing page " + v.page : "Customer message"} ·{" "}
                                        {v.excerpt}
                                      </small>
                                    ))}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          </details>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </details>
            )}
            <details className="approval-fold">
              <summary>Shop costs and profit</summary>
              <div className="approval-fields">
                <a className="button secondary" href={api + "/cost-sheet?version=" + quote.version}>
                  Download internal cost sheet (CSV)
                </a>
                <p>
                  Estimated cost <b>{money(quote.totals.estimatedCost)}</b> · Planned margin{" "}
                  <b>{quote.marginPercent}%</b>
                </p>
                {quote.items.map((line, i) => (
                  <section key={line.id} className="approval-breakdown">
                    <h3>
                      {line.description.split("\n")[0]} · {money(quote.totals.items[i].cost)}
                    </h3>
                    {line.costRows.map((row, j) => (
                      <div key={row.id}>
                        <b>
                          {row.label} · {money(quote.totals.items[i].rows[j].cost)}
                        </b>
                        <p>
                          {row.amount} {row.estimate?.unit || ""} × {money(row.rate)} ·{" "}
                          {row.basis === "batch" ? "once for the job" : "for each of " + line.quantity}
                        </p>
                        {row.estimate && (
                          <details>
                            <summary>How it was priced</summary>
                            <p>
                              {row.estimate.templateName} · {row.estimate.workType}
                              {row.estimate.demo ? " · Sample rates" : ""}
                            </p>
                            <p>
                              {row.estimate.rationale} {row.estimate.includes} · Minimum{" "}
                              {money(row.estimate.minimumCost)}
                            </p>
                            {row.estimate.rateSource && (
                              <p>
                                {row.estimate.rateSource} · {row.estimate.rateEffectiveOn}
                              </p>
                            )}
                            <p>
                              {row.estimate.assumption} {row.estimate.overrideReason}
                            </p>
                          </details>
                        )}
                      </div>
                    ))}
                  </section>
                ))}
                {!editable && (
                  <>
                    {pricingFields}
                    {details.assumptions && <p>Shop notes · {details.assumptions}</p>}
                  </>
                )}
              </div>
            </details>
            <details className="approval-fold">
              <summary>Earlier copies and changes</summary>
              <div className="approval-fields">
                <label className="approval-field">
                  <span>Open a saved copy</span>
                  <select
                    value={quote.version}
                    disabled={busy}
                    onChange={(e) =>
                      window.location.assign(path + "/approval?version=" + e.target.value)
                    }
                  >
                    {view.versions.map((v) => (
                      <option key={v.version} value={v.version}>
                        Version {v.version} · {statusLabels[v.status]}
                      </option>
                    ))}
                  </select>
                </label>
                <ol className="approval-events">
                  {view.events.map((event, i) => (
                    <li key={i}>
                      <b>{event.message}</b>
                      <small>
                        Version {event.version} · {date(event.at)}
                      </small>
                    </li>
                  ))}
                  <li>
                    <b>Quote created</b>
                    <small>{date(quote.createdAt)}</small>
                  </li>
                </ol>
              </div>
            </details>
          </section>
        </aside>
      </div>
    </div>
  );
}
