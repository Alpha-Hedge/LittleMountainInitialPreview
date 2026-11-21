"use client";
import Activity from "@/components/Activity";
import { useEffect, useRef, useState } from "react";
import type { Quote } from "@/lib/types";
import type { DrawingRevision } from "@/lib/drawing-types";
import { isDrawingDraftPart } from "@/lib/quote-start";
import {
  fieldLabels,
  type ReviewRun,
  type PartCorrection,
  type FieldKey,
} from "@/lib/review-types";
import { Icon } from "./Icons";
import ReviewSource from "./ReviewSource";
import "./drawing-check.css";

type Props = {
  quote: Quote;
  revision: DrawingRevision;
  active: boolean;
  savedRuns: ReviewRun[];
  autoRead: boolean;
};

const reviewFieldOrder: FieldKey[] = [
  "description",
  "quantity",
  "material",
  "thickness",
  "dimensions",
  "units",
  "finish",
  "revision",
  "requirements",
];

function fieldInputId(part: number, key: FieldKey) {
  return `drawing-part-${part}-${key}`;
}

function timeLabel(value: string) {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

export default function DrawingReview({
  quote: initial,
  revision,
  active,
  savedRuns,
  autoRead,
}: Props) {
  const quote = initial;
  const [runs, setRuns] = useState(savedRuns);
  const [selected, setSelected] = useState(savedRuns[0]?.id ?? "");
  const run = runs.find((r) => r.id === selected);
  const [edits, setEdits] = useState<PartCorrection[]>(run?.corrections ?? []);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const firstReadStarted = useRef(false);
  const requesting = useRef(false);
  const openingPrice = useRef(false);
  const dirty =
    !!run && JSON.stringify(edits) !== JSON.stringify(run.corrections);
  const stale = !!run && run.quoteVersion !== quote.version;
  const endpoint = "/api/reviews/" + quote.id + "/" + revision.id;
  const quoteUrl = "/quotes/" + quote.id;
  const priceUrl = quoteUrl + "/estimate";
  const starter = quote.items.find(isDrawingDraftPart);
  const starterIndex =
    starter &&
    !run?.appliedAt &&
    !edits.some((edit) => edit.selected && edit.targetItemId === starter.id)
      ? edits.findIndex((edit) => edit.selected && !edit.targetItemId)
      : -1;
  const mappedEdits =
    starter && starterIndex >= 0
      ? edits.map((edit, index) =>
          index === starterIndex ? { ...edit, targetItemId: starter.id } : edit,
        )
      : edits;
  const pendingFields =
    run?.parts.map((part, index) =>
      reviewFieldOrder.filter((key) => {
        if (!edits[index].selected || run.appliedAt) return false;
        const field = part.fields[key];
        const correction = edits[index].values[key];
        const value = (
          correction ?? (field.status === "found" ? field.value : "")
        ).trim();
        if (key === "description") return !value;
        if (key === "quantity") {
          const quantity = Number(value);
          return (
            !Number.isSafeInteger(quantity) ||
            quantity < 1 ||
            quantity > 1_000_000_000
          );
        }
      return field.status === "conflict" && !value;
      }),
    ) ?? [];
  const firstPendingPart = pendingFields.findIndex((part) => part.length > 0);
  const hasSelectedPart = edits.some((edit) => edit.selected);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      if (!openingPrice.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  function choose(next: ReviewRun) {
    setSelected(next.id);
    setEdits(next.corrections);
    setError("");
    setNotice("");
  }
  function change(index: number, update: Partial<PartCorrection>) {
    setEdits((current) =>
      current.map((part, i) => (i === index ? { ...part, ...update } : part)),
    );
    setNotice("");
  }
  function changeField(index: number, key: FieldKey, value: string) {
    change(index, { values: { ...edits[index].values, [key]: value } });
  }
  function setTarget(index: number, targetItemId: string | null) {
    setEdits((current) =>
      current.map((part, i) => {
        if (i === index) return { ...part, targetItemId };
        if (
          starter &&
          targetItemId === starter.id &&
          part.targetItemId === targetItemId
        ) {
          return { ...part, targetItemId: null };
        }
        return part;
      }),
    );
    setNotice("");
  }
  function focusMissingField() {
    const id = fieldInputId(
      firstPendingPart,
      pendingFields[firstPendingPart][0],
    );
    document.getElementById(id)?.focus();
  }
  function showEvidence(sourcePage: number | null) {
    if (sourcePage) setPage(sourcePage);
    const source = document.getElementById(
      sourcePage ? "review-source" : "source-notes",
    );
    source?.focus({ preventScroll: true });
    if (window.matchMedia("(max-width: 1100px)").matches)
      source?.scrollIntoView({ block: "start" });
  }
  async function request(action: "extract" | "save" | "apply") {
    if (requesting.current) return;
    requesting.current = true;
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const extracting = action === "extract";
      const body = extracting
        ? { action, version: quote.version }
        : {
            action,
            runId: run?.id,
            editVersion: run?.editVersion,
            corrections: mappedEdits,
          };
      const result = await fetch(endpoint, {
        method: extracting ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await result.json();
      if (!result.ok) throw new Error(data.error || "Review request failed.");
      const next: ReviewRun = extracting ? data : data.run;
      if (action === "apply") {
        openingPrice.current = true;
        window.location.assign(priceUrl);
        return;
      }
      setRuns((current) =>
        extracting
          ? [next, ...current]
          : current.map((r) => (r.id === next.id ? next : r)),
      );
      choose(next);
      if (action === "save") setNotice("Corrections saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Review request failed.");
    } finally {
      requesting.current = false;
      setBusy("");
    }
  }
  useEffect(() => {
    if (!autoRead || !active || savedRuns.length || firstReadStarted.current)
      return;
    firstReadStarted.current = true;
    void request("extract");
  }, [active, autoRead, savedRuns.length, request]);
  let nextTitle = "Fill in details from the drawing";
  let nextDescription =
    "Read the drawing to find the parts, material and sizes. You’ll fill in anything missing.";
  let nextAction = (
    <button
      type="button"
      className="button primary"
      disabled={!!busy || dirty}
      onClick={() => request("extract")}
    >
      {busy === "extract"
        ? <Activity>Reading drawing</Activity>
        : run
          ? "Read drawing again"
          : "Read drawing"}
    </button>
  );
  if (!active) {
    nextTitle = "Earlier drawing revision";
    nextDescription = "Choose this revision on the quote to use it.";
  } else if (busy === "extract") {
    nextTitle = "Reading the drawing";
    nextDescription = "The drawing and any customer notes are being checked.";
  } else if (run?.appliedAt) {
    nextTitle = "Drawing details saved";
    nextDescription =
      "Choose the type of work and check the time and shop costs next.";
    nextAction = (
      <a className="button primary" href={priceUrl}>
        Price the job <Icon name="arrow" size={17} />
      </a>
    );
  } else if (stale) {
    nextTitle = "The quote has changed";
    nextDescription = dirty
      ? "Save your corrections below before rereading the drawing."
      : "Read the drawing again before using these details.";
  } else if (firstPendingPart >= 0) {
    nextTitle = "Some answers need your help";
    nextDescription =
      "Fill in the highlighted boxes. For quantity, enter the number of finished pieces the customer wants.";
    nextAction = (
      <button
        type="button"
        className="button primary"
        onClick={focusMissingField}
      >
        Go to missing answers <Icon name="arrow" size={17} />
      </button>
    );
  } else if (run) {
    nextTitle = "Check the part details";
    nextDescription = hasSelectedPart
      ? "Check the quantity and any blanks before moving on to the price."
      : "Choose at least one part to put on this quote.";
    nextAction = (
      <button
        type="button"
        className="button primary"
        disabled={!!busy || !hasSelectedPart}
        onClick={() => request("apply")}
      >
        {busy === "apply" ? <Activity>Saving details</Activity> : "Save details & price the job"}{" "}
        <Icon name="arrow" size={17} />
      </button>
    );
  }
  return (
    <>
      <div className="page-heading shelf-heading">
        <div>
          <h1>Check the drawing</h1>
          <p>
            {quote.jobName} <span aria-hidden="true">·</span> Revision{" "}
            {revision.label}
          </p>
        </div>
        <a className="review-back" href={quoteUrl}>
          Back to quote
        </a>
      </div>
      <section className="review-next" id="review-next" aria-label="Next step">
        <div aria-live="polite">
          <h2>{nextTitle}</h2>
          <p>{nextDescription}</p>
        </div>
        {active && nextAction}
      </section>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="review-notice">
          {notice}
        </p>
      )}
      <div className="review-layout">
        {run && (
          <section className="panel review-fields drawing-check">
            <div className="panel-heading">
              <span className="section-icon">
                <Icon name="details" />
              </span>
              <h2>Parts to quote</h2>
              <a className="review-source-anchor" href="#review-source">
                View drawing
              </a>
            </div>
            <div className="review-part-list">
              {run.parts.map((part, i) => (
                <section className="review-part" key={run.id + i}>
                  <div className="part-header">
                    <h3>
                      {edits[i].values.description ||
                        part.fields.description.value ||
                        "Part " + (i + 1)}
                    </h3>
                    {(run.parts.length > 1 || !edits[i].selected) && (
                      <label>
                        <input
                          type="checkbox"
                          disabled={!!busy || !!run.appliedAt}
                          checked={edits[i].selected}
                          onChange={(e) =>
                            change(i, { selected: e.target.checked })
                          }
                        />
                        Include part {i + 1}
                      </label>
                    )}
                  </div>
                  <div className="review-fields-grid">
                    {reviewFieldOrder.map((key) => {
                      const field = part.fields[key];
                      const corrected = Object.hasOwn(edits[i].values, key);
                      const value =
                        edits[i].values[key] ??
                        (field.status === "conflict" ? "" : field.value);
                      const pending = pendingFields[i].includes(key);
                      const placeholder =
                        key === "quantity"
                          ? "How many finished pieces?"
                          : key === "description"
                            ? "Name of the finished part"
                            : key === "requirements"
                              ? "Holes, welds, tolerances or other notes"
                              : "Enter if known";
                      const status = pending
                        ? "Needs an answer"
                        : corrected && value.trim()
                          ? "Entered by you"
                          : field.status === "found" && !corrected
                            ? ""
                            : key === "requirements" &&
                                field.status === "missing"
                              ? "Optional"
                              : "Missing";
                      const attributes = {
                        id: fieldInputId(i, key),
                        "aria-label": fieldLabels[key] + " for part " + (i + 1),
                        "aria-required":
                          !run.appliedAt &&
                          edits[i].selected &&
                          (key === "description" || key === "quantity"),
                        "aria-invalid": pending || undefined,
                        readOnly: !!busy || !!run.appliedAt,
                        value,
                        placeholder,
                      };
                      return (
                        <div
                          className={
                            "review-field" +
                            (key === "requirements" ? " review-field-wide" : "")
                          }
                          key={key}
                        >
                          <label className="field">
                            <span>
                              {key === "quantity"
                                ? "Order quantity"
                                : fieldLabels[key]}{" "}
                              {status && (
                                <em
                                  className={
                                    "field-status " +
                                    (pending
                                      ? "conflict"
                                      : status === "Entered by you"
                                        ? "corrected"
                                        : "missing")
                                  }
                                >
                                  {status}
                                </em>
                              )}
                            </span>
                            {key === "requirements" ? (
                              <textarea
                                {...attributes}
                                rows={3}
                                onChange={(e) =>
                                  changeField(i, key, e.target.value)
                                }
                              />
                            ) : (
                              <input
                                {...attributes}
                                inputMode={
                                  key === "quantity" ? "numeric" : undefined
                                }
                                onChange={(e) =>
                                  changeField(i, key, e.target.value)
                                }
                              />
                            )}
                          </label>
                          {field.status === "conflict" && (
                            <small className="original-value">
                              Different answers found · {field.value}
                            </small>
                          )}
                          {corrected && field.status !== "conflict" && (
                            <small className="original-value">
                              Original reading · {field.value || "Missing"}
                            </small>
                          )}
                          {!!field.evidence.length && (
                            <details className="drawing-citation">
                              <summary>See source</summary>
                              {field.evidence.map((src, j) => (
                                <div className="evidence" key={j}>
                                  <button
                                    type="button"
                                    onClick={() => showEvidence(src.page)}
                                  >
                                    {src.page
                                      ? "Page " + src.page
                                      : "Customer notes"}
                                  </button>
                                  <span>
                                    {src.page === null || src.verbatim
                                      ? "“" + src.excerpt + "”"
                                      : "Drawing reading · " + src.excerpt}
                                  </span>
                                </div>
                              ))}
                            </details>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {!run.appliedAt &&
                    (!starter ||
                      quote.items.length > 1 ||
                      run.parts.length > 1) && (
                      <details className="review-item-map">
                        <summary>Where does this part go?</summary>
                        <label className="field target-select">
                          <span>Quote item</span>
                          <select
                            disabled={!!busy}
                            value={mappedEdits[i].targetItemId ?? ""}
                            onChange={(e) =>
                              setTarget(i, e.target.value || null)
                            }
                          >
                            <option value="">
                              Add a new item to the quote
                            </option>
                            {quote.items.map((item, index) => (
                              <option key={item.id} value={item.id}>
                                {isDrawingDraftPart(item)
                                  ? "Use the blank starter item"
                                  : "Update line " +
                                    (index + 1) +
                                    " · " +
                                    item.description.split("\n")[0]}
                              </option>
                            ))}
                          </select>
                        </label>
                      </details>
                    )}
                </section>
              ))}
            </div>
            <div className="review-footer">
              {active &&
                (run.appliedAt ? (
                  <a className="button primary" href={priceUrl}>
                    Continue to pricing <Icon name="arrow" size={17} />
                  </a>
                ) : stale ? (
                  <a href="#review-next">Back to next step</a>
                ) : firstPendingPart >= 0 ? (
                  <button
                    className="button secondary"
                    type="button"
                    onClick={focusMissingField}
                  >
                    Fill in required details
                  </button>
                ) : (
                  <button
                    className="button primary"
                    type="button"
                    disabled={!!busy || !hasSelectedPart}
                    onClick={() => request("apply")}
                  >
                    {busy === "apply" ? <Activity>Saving details</Activity> : "Continue to pricing"}{" "}
                    <Icon name="arrow" size={17} />
                  </button>
                ))}
              {!run.appliedAt && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={!!busy || !dirty}
                  onClick={() => request("save")}
                >
                  Save corrections for later
                </button>
              )}
            </div>
            <details className="run-select">
              <summary>
                {runs.length > 1
                  ? "Earlier drawing checks"
                  : "About this drawing check"}
              </summary>
              {runs.length > 1 && (
                <label className="field">
                  <span>Choose a saved check</span>
                  <select
                    disabled={!!busy || dirty}
                    value={run.id}
                    onChange={(e) =>
                      choose(runs.find((r) => r.id === e.target.value)!)
                    }
                  >
                    {runs.map((saved, i) => (
                      <option value={saved.id} key={saved.id}>
                        {timeLabel(saved.createdAt)} · Check {runs.length - i} ·{" "}
                        {saved.parts.length} part
                        {saved.parts.length === 1 ? "" : "s"}
                        {saved.appliedAt ? " · Applied" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <small>
                {run.provider} · {run.model} · Quote version {run.quoteVersion}
              </small>
              {active && (!stale || run.appliedAt) && (
                <button
                  className="button secondary"
                  type="button"
                  disabled={!!busy || dirty}
                  onClick={() => request("extract")}
                >
                  Read drawing again
                </button>
              )}
            </details>
          </section>
        )}
        <ReviewSource
          quoteId={quote.id}
          revision={revision}
          page={page}
          onPageChange={setPage}
          active={active}
          notes={run ? run.notes : quote.notes}
        />
      </div>
    </>
  );
}
