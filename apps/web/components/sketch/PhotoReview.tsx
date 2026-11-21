"use client";

import { useEffect, useRef, useState } from "react";
import {
  sketchStates,
  type SketchConversion,
  type PhotoReading,
  type PhotoPart,
  type Pin,
} from "@/lib/sketch/conversion-types";
import type { Point } from "@/lib/sketch/types";
import { ReadingFields, fieldNames, targetName } from "./ReadingFields";
import { sketchRequest } from "./request";
import { PhotoCanvas } from "../BlueprintCanvas";
import ReviewAssistant from "../ReviewAssistant";
import MeasurementChecks from "./MeasurementChecks";
import Activity from "../Activity";
import { Icon } from "../Icons";
import SketchVisualPreview from "./SketchVisualPreview";
import FeatureEditor, {
  movedPoint,
  targetPoint,
  type FeaturePoint,
} from "./FeatureEditor";

const busyState = (s: string) => s === "queued" || s === "reading";
const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

export default function PhotoReview({
  id,
  version,
}: {
  id: string;
  version?: string;
}) {
  const base = "/api/sketch-conversions/" + encodeURIComponent(id);
  const [record, setRecord] = useState<SketchConversion | null>(null);
  const [reading, setReading] = useState<PhotoReading | null>(null);
  const [verified, setVerified] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [checkPart, setCheckPart] = useState("*");
  const [selectedCheck, setSelectedCheck] = useState(0);
  const savedNavigation = useRef(false);
  const [working, setWorking] = useState(false);
  const [saving, setSaving] = useState<"check" | "files" | null>(null);
  const [saveError, setSaveError] = useState("");
  const [saveResult, setSaveResult] = useState("");
  const submitting = useRef(false);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const [makingDraft, setMakingDraft] = useState(false);
  const [draftMessage, setDraftMessage] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [overlay, setOverlay] = useState(false);
  const [focus, setFocus] = useState<Point | null>(null);
  const [boundTo, setBoundTo] = useState<Point[]>([]);
  const [placing, setPlacing] = useState<FeaturePoint | null>(null);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [ack, setAck] = useState<Record<number, boolean>>({});
  const [showCheckMarkers, setShowCheckMarkers] = useState(false);
  const [photoCheck,setPhotoCheck] = useState<number | null>(null);
  const [showAIReadings, setShowAIReadings] = useState(false);
  const [revise, setRevise] = useState(false);
  const [selectedView, setSelectedView] = useState<"sheet" | "review" | "files" | null>(null);
  const hasViews = !!reading && (record?.state === "needs_review" || record?.state === "released");
  const view = selectedView ?? (record?.state === "released" ? "files" : "sheet");

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const row = await sketchRequest<SketchConversion>(
          base + (version ? "?version=" + encodeURIComponent(version) : ""),
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setRecord(row);
        setError("");
        if (busyState(row.state)) timer = setTimeout(load, 1800);
        else {
          setReading(row.reading);
          setVerified(row.verified || []);
          const intent = window.location.hash;
          if (intent === "#review-saved" || intent === "#files-requested") {
            const count = row.solution?.pins.length ?? 0;
            if (row.state === "needs_review") {
              setSelectedView("review");
              setSaveResult(`Revision ${row.version} saved. ` + (count
                ? `${count} open ${count === 1 ? "check remains" : "checks remain"} before cut files can be made.`
                : "Measurements checked. Confirm to make the shop files."));
            } else if (row.state === "released") {
              setSelectedView("files");
              setSaveResult(`Revision ${row.version} saved. Your shop files are ready.`);
            }
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not open the sketch.",
          );
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [base, version, attempt]);

  const pins = record?.solution?.pins || [];
  const dirty = !!reading && !!record && (
    JSON.stringify(reading) !== JSON.stringify(record.reading) ||
    JSON.stringify(verified) !== JSON.stringify(record.verified ?? []) ||
    Object.values(edits).some(value => value.trim()) || Object.values(ack).some(Boolean) || !!note.trim()
  );
  useEffect(() => {
    if (!dirty) return;
    function protect(event: BeforeUnloadEvent) { if (!savedNavigation.current) event.preventDefault(); }
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);
  useEffect(() => {
    if (window.location.hash === "#measurements") setSelectedView("review");
  }, []);
  const old = !!record && record.version !== record.history[0]?.version;
  const locked = working || old || (record?.state === "released" && !revise);
  function updatePart(index: number, part: PhotoPart) {
    setReading((r) => {
      if (!r) return r;
      const used = new Set(
        [part, ...part.holes, ...part.bends].map(
          (feature) => feature.candidate,
        ),
      );
      return {
        ...r,
        parts: r.parts.map((p, i) => (i === index ? part : p)),
        dismissed: r.dismissed
          .map((d) => ({ ...d, ids: d.ids.filter((ref) => !used.has(ref)) }))
          .filter((d) => d.ids.length),
      };
    });
  }
  function locate(point: Point, targets: Point[] = []) {
    setFocus(point);
    setBoundTo(targets);
  }
  function startPlacement(choice: FeaturePoint) {
    setPlacing(choice);
    setOverlay(true);
    document
      .getElementById("registered-photo")
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  function focusPin(index: number) {
    setSelectedCheck(index);
    locate(pins[index].at);
    if (checkPart !== "*" && checkPart !== (pins[index].part_id || "")) setCheckPart("*");
    requestAnimationFrame(() => {
      const target = document.getElementById("pin-" + index);
      target?.scrollIntoView({ block: "nearest" });
      target?.focus({ preventScroll: true });
    });
  }
  function follow(row: SketchConversion, confirmed: boolean) {
    const href = "/sketches/photo/" + id + "?version=" + row.version;
    savedNavigation.current = true;
    window.location.assign(href + (confirmed ? "#files-requested" : "#review-saved"));
  }
  function pendingReading() {
      if (!reading || !record) return null;
      const next = structuredClone(reading);
      pins.forEach((p, i) => {
        const part = next.parts.find((part) => part.part_id === p.part_id);
        const value = edits[i]?.trim();
        if (part && p.field && value)
          part.annotations.push({
            kind: p.field,
            value,
            targets: [p.target],
            at: p.at,
            confidence: 1,
            evidence: "Staff confirmed " + value,
          });
        if (p.code === "clarify" && ack[i] && (value || note.trim())) {
          const remaining = (part?.questions || next.questions).filter(
            (q) => q.text !== p.message || !samePoint(q.at, p.at),
          );
          if (part) part.questions = remaining;
          else next.questions = remaining;
        }
        if (p.code === "unbound" && ack[i] && value) {
          const candidate = record.evidence.candidates?.find(
            (c) => samePoint(c.anchor, p.at) && p.message.includes(c.id + " "),
          );
          if (candidate)
            next.dismissed.push({ ids: [candidate.id], reason: value });
        }
      });
      return next;
  }
  const pending = pendingReading();
  async function downloadDraft() {
    if (!pending || !record || makingDraft || working) return;
    setMakingDraft(true);
    setDraftMessage("");
    setError("");
    try {
      const response = await fetch(base + "/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({version: record.version, reading: pending, verified}),
      });
      if (!response.ok) {
        const details = await response.json().catch(() => null);
        throw new Error(details?.error || "Could not make the draft drawing. Try again.");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "draft-drawing-rev-" + record.version + ".pdf";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (response.headers.get("x-assembly-reference") === "pending") {
        setDraftMessage("The dimensioned draft downloaded. Try again to include the assembly view.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not make the draft drawing.");
    } finally {
      setMakingDraft(false);
    }
  }
  async function save(confirmed: boolean) {
    if (!pending || !record || working || submitting.current || old) return;
    submitting.current = true;
    setSaving(confirmed ? "files" : "check");
    setSaveError("");
    setSaveResult("");
    setWorking(true);
    setError("");
    try {
      const next = pending;
      if (
        !note.trim() &&
        pins.some((pin) => pin.code === "engineering_note" && pin.review_key && verified.includes(pin.review_key) && !record.verified?.includes(pin.review_key))
      ) {
        setSelectedView("review");
        requestAnimationFrame(() => noteInput.current?.focus());
        throw new Error("You marked engineering as confirmed. Enter the reviewer’s name or the approved drawing reference here, or clear that check to save your progress.");
      }
      const changedParts = next.parts.filter((part, i) => JSON.stringify(part) !== JSON.stringify(record.reading?.parts[i]));
      const summary = changedParts.length ? "Updated measurements or details for " + changedParts.map(p => p.name || p.part_id).join(", ") + "." :
        confirmed ? "Requested shop files after checking this revision." : "Saved measurement review in progress.";
      const answers = pins.flatMap((p,i) => p.code === "clarify" && ack[i] && edits[i]?.trim()
        ? [p.message + " — " + edits[i].trim()] : []);
      const reviewNote = [note.trim(), ...answers].filter(Boolean).join("\n") || summary.slice(0,2000);
      if (reviewNote.length > 2000) throw new Error("The answers and review note exceed 2,000 characters. Shorten them or save a few answers in this revision first.");
      follow(
        await sketchRequest<SketchConversion>(base + "/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: record.version,
            reading: next,
            review_note: reviewNote,
            confirmed,
            verified,
          }),
        }), confirmed,
      );
    } catch (cause) {
      setSaveError(
        cause instanceof Error ? cause.message : "Could not save the review.",
      );
      setWorking(false);
      setSaving(null);
      submitting.current = false;
    }
  }
  async function quoteOrRetry(quote: boolean) {
    if (!record || working) return;
    setWorking(true);
    setError("");
    try {
      const url =
        base + (quote ? "/quote" : "/retry") + "?version=" + record.version;
      if (quote) {
        const result = await sketchRequest<{ quoteId: string }>(url, {
          method: "POST",
        });
        window.location.assign("/quotes/" + result.quoteId);
      } else {
        await sketchRequest(url, { method: "POST" });
        setWorking(false);
        setAttempt((n) => n + 1);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Try opening the sketch again.",
      );
      setWorking(false);
    }
  }
  function pinField(p: Pin, i: number) {
    if (p.review_key) {
      const key = p.review_key;
      return (
        <label className="ph-check">
          <input
            type="checkbox"
            disabled={locked}
            checked={verified.includes(key)}
            onChange={(e) =>
              setVerified((v) =>
                e.target.checked ? [...v, key] : v.filter((s) => s !== key),
              )
            }
          />
          {p.code === "engineering_note"
            ? "I confirmed the engineering requirements for this revision"
            : p.code === "tentative_thickness"
              ? "I confirmed the thickness and updated it if needed"
              : p.code === "source_comparison"
                ? "I compared the source and resolved the difference"
              : "The marked feature matches the sketch"}
        </label>
      );
    }
    if (p.field)
      return (
        <label>
          {fieldNames[p.field]} · {targetName(p.target)}
          <input
            disabled={locked}
            aria-label={
              "Supply " + p.part_id + " " + p.target + " " + fieldNames[p.field]
            }
            value={edits[i] || ""}
            onChange={(e) => setEdits({ ...edits, [i]: e.target.value })}
          />
        </label>
      );
    if (p.code === "clarify" || p.code === "unbound")
      return (
        <>
          <label className="ph-check">
            <input
              type="checkbox"
              checked={!!ack[i]}
              disabled={locked}
              onChange={(e) => setAck({ ...ack, [i]: e.target.checked })}
            />
            {p.code === "clarify"
              ? "I have an answer"
              : "This is a non-cut mark"}
          </label>
          {p.code === "clarify" && ack[i] && <label>Answer for this question
            <input value={edits[i] || ""} disabled={locked} onChange={e => setEdits({...edits,[i]:e.target.value})}/>
            <small>Enter the answer here or in the review note. Otherwise this question stays open.</small>
          </label>}
          {p.code === "unbound" && ack[i] && (
            <label>
              What does this mark represent?
              <input
                value={edits[i] || ""}
                disabled={locked}
                onChange={(e) => setEdits({ ...edits, [i]: e.target.value })}
              />
            </label>
          )}
        </>
      );
    if (p.annotation !== null && p.part_id)
      return (
        <a href={"#mark-" + p.part_id + "-" + p.annotation}
          onClick={() => { const group = document.getElementById("mark-" + p.part_id + "-" + p.annotation)?.closest("details.ph-fields"); if (group instanceof HTMLDetailsElement) group.open = true; }}>
          Check this measurement
        </a>
      );
    return null;
  }

  return (
    <div className="sk-workspace ph-desk">
      <header className="sk-page-heading sk-editor-heading">
        <div>
          <h1>{record?.reading?.title || "Review sketch"}</h1>
          <p>
            {record
              ? record.filename +
                " · Revision " +
                record.version +
                " · " +
                sketchStates[record.state]
              : <Activity>Opening the saved photo</Activity>}
          </p>
        </div>
        {record && record.history.length > 1 &&
          <label className="ph-revisions">Saved revisions
            <select value={record.version} onChange={event => window.location.assign("/sketches/photo/" + id + "?version=" + event.target.value)}>
              {record.history.map(h => <option value={h.version} key={h.version}>Revision {h.version} · {sketchStates[h.state]}</option>)}
            </select>
          </label>}
      </header>
      {hasViews && <div className="workspace-views" role="group" aria-label="Sketch workspace">
        <button type="button" aria-pressed={view === "sheet"} onClick={() => setSelectedView("sheet")}><Icon name="drawing"/>Drawing sheet</button>
        <button type="button" aria-pressed={view === "review"} onClick={() => setSelectedView("review")}><Icon name="details"/>Review measurements</button>
        <button type="button" aria-pressed={view === "files"} onClick={() => setSelectedView("files")}><Icon name="library"/>Shop files</button>
      </div>}
      {dirty && <p className="sk-edit-notice">Measurements have unsaved changes.{" "}
        <button type="button" className="ph-link" disabled={locked} onClick={() => save(false)}>{saving === "check" ? <Activity>Saving</Activity> : "Save this review"}</button>
      </p>}
      {saveError && <p className="sk-danger ph-error">{saveError}</p>}
      {saveResult && !dirty && <p className="sk-edit-notice" role="status">{saveResult}{" "}
        {!!pins.length && <button type="button" className="ph-link" onClick={() => {setSelectedView("review"); focusPin(0);}}>Go to first check</button>}
      </p>}
      {error && (
        <div role="alert" className="sk-danger ph-error">
          {error}{" "}
          {!record && (
            <button onClick={() => setAttempt((n) => n + 1)}>Try again</button>
          )}
        </div>
      )}
      {record && pending && (record.state === "needs_review" || record.state === "released") && (
        <div hidden={hasViews && view !== "sheet"}>
          <SketchVisualPreview key={record.version} base={base} version={record.version} hasPhoto={!!record.evidence.registration} />
        </div>
      )}
      <div hidden={hasViews && view !== "review"}>
      {record && pending && !old && <ReviewAssistant kind="sketch" id={id} version={record.version} draft={pending} locked={locked}
        onApply={(next, instruction) => {
          setReading(next);
          setEdits({});
          setAck({});
          setNote(text => [text, "AI-assisted review · " + instruction].filter(Boolean).join("\n").slice(0,2000));
        }}/>}
      </div>
      {hasViews && view === "files" && record.state !== "released" &&
        <section className="panel sk-card ph-files-state">
          <Icon name="library" size={28}/><h2>Prepare the shop files</h2>
          <p>{old ? "This earlier revision is available for review. Select the latest revision to prepare files." :
            pins.length ? "Review the open measurements before releasing the full-size DXF, shop PDF and cut list." :
            "Confirm the measurements to release the full-size DXF, shop PDF and cut list."}</p>
          <button type="button" className="button primary" onClick={() => setSelectedView("review")}>Check the drawing details <Icon name="arrow"/></button>
        </section>}
      <div hidden={hasViews && view !== "files"}>
      {record && pending && record.evidence.registration && (record.state === "needs_review" || revise) && (
        <details className="panel sk-card ph-technical">
          <summary>Technical draft PDF</summary>
          <div className="ph-draft">
            <div>
              <p>{makingDraft ? "Reading and drawing larger assemblies can take a minute." :
                "Download the dimensioned review copy with open details."}</p>
              {makingDraft && <Activity>Preparing PDF</Activity>}
              {draftMessage && <p role="status">{draftMessage}</p>}
            </div>
            <button type="button" className="button secondary" onClick={downloadDraft} disabled={working || makingDraft}>
              {makingDraft ? "Making technical PDF…" : "Download technical PDF"}
            </button>
          </div>
        </details>
      )}
      </div>
      {record && (
        <div className="ph-layout" hidden={hasViews && (view === "sheet" || view === "files" && record.state !== "released")}
          data-files={hasViews && view === "files"}>
          <aside className="panel sk-card ph-preview" hidden={hasViews && view !== "review"}>
            <div className="ph-toolbar">
              <h2>Original sketch</h2>
              <a href={base + "/source"} target="_blank" rel="noreferrer">Open original</a>
            </div>
            {record.evidence.registration ? (
              <>
                <div className="ph-toolbar">
                  <label className="ph-check">
                    <input
                      type="checkbox"
                      checked={overlay}
                      onChange={(e) => setOverlay(e.target.checked)}
                    />
                    Show detected features
                  </label>
                </div>
                {placing && (
                  <p role="status">
                    Tap the location of {targetName(placing.key).toLowerCase()}{" "}
                    on the photo.{" "}
                    <button
                      className="ph-link"
                      onClick={() => setPlacing(null)}
                    >
                      Cancel
                    </button>
                  </p>
                )}
                <div id="registered-photo" className="ph-photo">
                  <img
                    src={base + "/preview/" + (overlay ? "overlay" : "page")}
                    alt="Deskewed sketch with handwritten dimensions"
                  />
                  {focus && boundTo.length > 0 && (
                    <svg
                      className="ph-bindings"
                      viewBox="0 0 1000 1000"
                      preserveAspectRatio="none"
                      aria-label="Selected annotation and its geometric feature"
                    >
                      {boundTo.map((to, n) => (
                        <g key={n}>
                          <line x1={focus.x} y1={focus.y} x2={to.x} y2={to.y} />
                          <circle cx={to.x} cy={to.y} r="8" />
                        </g>
                      ))}
                    </svg>
                  )}
                  {placing && reading && (
                    <button
                      className="ph-placement"
                      aria-label={"Place " + targetName(placing.key)}
                      onClick={(e) => {
                        if (!e.detail) return;
                        const box = e.currentTarget.getBoundingClientRect();
                        const point = {
                          x: Math.max(
                            0,
                            Math.min(
                              1000,
                              Math.round(
                                (1000 * (e.clientX - box.left)) / box.width,
                              ),
                            ),
                          ),
                          y: Math.max(
                            0,
                            Math.min(
                              1000,
                              Math.round(
                                (1000 * (e.clientY - box.top)) / box.height,
                              ),
                            ),
                          ),
                        };
                        updatePart(
                          placing.part,
                          movedPoint(
                            reading.parts[placing.part],
                            placing.key,
                            point,
                          ),
                        );
                        locate(point);
                        setPlacing(null);
                      }}
                    />
                  )}
                  {showCheckMarkers && pins.map((p, i) => (
                    <button
                      key={i}
                      type="button"
                      className="ph-pin"
                      style={{
                        left: p.at.x / 10 + "%",
                        top: p.at.y / 10 + "%",
                      }}
                      title={p.message}
                      aria-label={"Go to check " + (i + 1)}
                      onClick={() => focusPin(i)}
                    >
                      {i + 1}
                    </button>
                  ))}
                  {focus && (
                    <span
                      className="ph-location"
                      aria-label="Selected source location"
                      style={{
                        left: focus.x / 10 + "%",
                        top: focus.y / 10 + "%",
                      }}
                    />
                  )}
                </div>
              </>
            ) : (
              <p>
                The original photo is saved. Its reading copy will appear here.
              </p>
            )}
            {photoCheck != null && <button type="button" className="ph-link" onClick={()=>{focusPin(photoCheck);setPhotoCheck(null);}}>Back to check {photoCheck+1}</button>}
            <a href={base + "/source"}>Download original photo</a>
 
          </aside>
          <div className="ph-sections">
            {busyState(record.state) && (
              <section className="panel sk-card" role="status">
                <h2><Activity>{record.version > 1 ? "Checking the saved revision" : "Reading your sketch"}</Activity></h2>
                <p>
                  You can leave this page and reopen the photo from Saved
                  sketches.
                </p>
              </section>
            )}
            {record.state === "failed" && (
              <section className="panel sk-card">
                <h2>The photo needs another try</h2>
                <p>{record.error}</p>
                <button
                  className="button secondary"
                  disabled={working}
                  onClick={() => quoteOrRetry(false)}
                >
                  Retry saved photo
                </button>
              </section>
            )}
            {record.state === "released" && (
              <section className="panel sk-card ph-release" hidden={hasViews && view !== "files"}>
                <h2>Drawing files ready</h2>
                <p>
                  Revision {record.version} ·{" "}
                  {record.solution?.drawing?.parts.length} part design(s) ·{" "}
                  {record.reading?.units === "mm" ? "Millimeters" : "Inches"}
                </p>
                <ul>
                  {record.files.map((f) => (
                    <li key={f.name}>
                      <a
                        href={base + "/files/" + record.version + "/" + f.name}
                      >
                        {f.name.endsWith(".dxf")
                          ? "Full-size DXF · " + f.name
                          : f.name.endsWith(".pdf")
                            ? "Annotated shop PDF"
                            : "Cut list (CSV BOM)"}
                      </a>
                    </li>
                  ))}
                </ul>
                <div className="sk-actions">
                  <button
                    className="button primary"
                    disabled={working}
                    onClick={() => quoteOrRetry(true)}
                  >
                    Create or open quote
                  </button>
                  {!old && !revise && (
                    <button
                      className="button secondary"
                      onClick={() => { setRevise(true); setSelectedView("review"); }}
                    >
                      Revise drawing
                    </button>
                  )}
                </div>
              </section>
            )}
            {reading && !busyState(record.state) && (
              <div className="ph-review-sections" hidden={hasViews && view !== "review"}>
                {pins.length > 0 && record.reading && <MeasurementChecks
                  pins={pins} reading={reading} original={record.reading} canSave={!old && (!locked || working)}
                  partFilter={checkPart} setFilter={setCheckPart} selected={selectedCheck}
                  select={index => {setSelectedCheck(index); locate(pins[index].at);}}
                  showPhoto={pin => {setPhotoCheck(pins.indexOf(pin));locate(pin.at); document.getElementById("registered-photo")?.scrollIntoView({block:"center"});}}
                  markers={showCheckMarkers} toggleMarkers={() => setShowCheckMarkers(v => !v)}
                  control={pinField} answered={(pin,i) => !!(pin.review_key && verified.includes(pin.review_key)
                    || pin.field && edits[i]?.trim() || ack[i] && (edits[i]?.trim() || pin.code === "clarify" && note.trim()))}
                />}
                <section className="panel sk-card" id="sketch-drawing-details">
                  <h2>Drawing details</h2>
                  <p>Choose a part below to check or change its measurements. Enter fractions as written on the sketch.</p>
                  {record.evidence.registration && <details onToggle={event => setShowAIReadings(event.currentTarget.open)}>
                    <summary>Inspect AI readings and drawing preview</summary>
                    <p>Select a colored marker to see the value the AI read and where it came from.</p>
                    {showAIReadings && <PhotoCanvas key={record.version} record={record} reading={reading}
                      verified={verified} onChange={setReading} locked={locked}/>}
                  </details>}
                  <div className="ph-form">
                    <label>
                      Drawing name
                      <input
                        value={reading.title}
                        disabled={locked}
                        onChange={(e) =>
                          setReading({ ...reading, title: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Drawing units
                      <select
                        aria-label="Drawing units"
                        value={reading.units || ""}
                        disabled={locked}
                        onChange={(e) => {
                          const units = (e.target.value ||
                            null) as PhotoReading["units"];
                          setReading({
                            ...reading,
                            units,
                            unit_confidence: 1,
                            unit_evidence: units
                              ? "Staff confirmed " + units
                              : "",
                          });
                        }}
                      >
                        <option value="">Choose units</option>
                        <option value="in">Inches</option>
                        <option value="mm">Millimeters</option>
                      </select>
                    </label>
                    {pins.some(
                      (p) =>
                        p.target === "drawing" &&
                        /inch|millimeter|units/i.test(p.message),
                    ) && (
                      <label>
                        Source for the drawing units
                        <input
                          value={reading.unit_evidence}
                          disabled={locked}
                          onChange={(e) =>
                            setReading({
                              ...reading,
                              unit_evidence: e.target.value,
                              unit_confidence: 1,
                            })
                          }
                        />
                      </label>
                    )}
                  </div>
                </section>
                {reading.parts.map((part, i) => (
                  <ReadingFields
                    key={i}
                    part={part}
                    onChange={(p) => updatePart(i, p)}
                    onLocate={(at, targets) =>
                      locate(
                        at,
                        targets
                          .map((t) => targetPoint(part, t))
                          .filter((p): p is Point => !!p),
                      )
                    }
                    locked={locked}
                  >
                    {!locked && (
                      <FeatureEditor
                        index={i}
                        part={part}
                        candidates={record.evidence.candidates || []}
                        onChange={(p) => updatePart(i, p)}
                        begin={startPlacement}
                      />
                    )}
                  </ReadingFields>
                ))}
                {!locked && (
                  <button
                    className="button secondary"
                    onClick={() => {
                      let n = reading.parts.length + 1;
                      while (reading.parts.some((p) => p.part_id === "P" + n))
                        n++;
                      setReading({
                        ...reading,
                        parts: [
                          ...reading.parts,
                          {
                            part_id: "P" + n,
                            name: "Part " + n,
                            shape: "unknown",
                            candidate: null,
                            confidence: 1,
                            vertices: [],
                            holes: [],
                            bends: [],
                            annotations: [],
                            questions: [],
                          },
                        ],
                      });
                    }}
                  >
                    Add a missing part
                  </button>
                )}
                {!old && (!locked || working) && (
                  <section className="panel sk-card ph-confirm" id="sketch-signoff">
                    <h2>Save your review</h2>
                    <p>Save at any point. To make the DXF, shop PDF and cut list, confirm your measurements. Any remaining checks will appear on the saved revision.</p>
                    <label>
                      Review note <small>Optional unless confirming engineering</small>
                      <textarea
                        rows={2}
                        ref={noteInput}
                        maxLength={2000}
                        value={note}
                        disabled={working}
                        onChange={(e) => {setNote(e.target.value); setSaveError("");}}
                        placeholder="Where did a corrected size or instruction come from?"
                      />
                    </label>
                    <div className="sk-actions">
                      <button
                        type="button"
                        className="button primary"
                        disabled={working}
                        onClick={() => save(true)}
                      >
                        {saving === "files" ? <Activity>Checking for release</Activity> : "Confirm and make files"}
                      </button>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={working}
                        onClick={() => save(false)}
                      >
                        {saving === "check" ? <Activity>Saving and checking</Activity> : "Save and check"}
                      </button>
                    </div>
                    {saveError && <p role="alert" className="sk-danger ph-error">{saveError}</p>}
                    {saveResult && !dirty && <p role="status">{saveResult}</p>}
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
