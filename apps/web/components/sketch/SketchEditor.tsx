"use client";

import Activity from "@/components/Activity";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icons";
import { drawingIssues } from "@/lib/sketch/geometry";
import {
  blankPart,
  type SketchDraft,
  type SketchJob,
} from "@/lib/sketch/types";
import PartEditor, { SketchField, type CornerEdit } from "./PartEditor";
import SketchPreview from "./SketchPreview";
import { sketchRequest } from "./request";

type Action = "read" | "save" | "confirm" | "quote";
type SelectedCorner = CornerEdit & { partIndex: number };

function SketchDownloads({
  job,
  endpoint,
  startQuote,
  busy,
}: {
  job: SketchJob;
  endpoint: string;
  startQuote: () => void;
  busy: boolean;
}) {
  const file = (format: string, part?: number) =>
    endpoint +
    "/export?" +
    new URLSearchParams({
      format,
      version: String(job.version),
      ...(part === undefined ? {} : { part: String(part) }),
    });

  return (
    <section
      className="panel sk-card sk-downloads"
      id="sk-downloads"
      aria-labelledby="sk-downloads-heading"
      tabIndex={-1}
    >
      <h2 id="sk-downloads-heading">
        <Icon name="check" size={24} /> Ready for the shop
      </h2>
      <div className="sk-actions">
        <a className="button primary" href={file("pdf")} download>
          Download shop PDF
        </a>
        <a className="button secondary" href={file("csv")} download>
          Download cut list
        </a>
      </div>
      <ul className="sk-inline-list sk-dxf-list">
        {job.draft.parts.map((part, i) => (
          <li key={i}>
            <span>
              <strong>{part.name}</strong>
              <small>
                Full-size DXF ·{" "}
                {job.draft.units === "in" ? "Inches" : "Millimeters"}
              </small>
            </span>
            <a
              className="button secondary"
              href={file("dxf", i)}
              download
              aria-label={"Download DXF for " + part.name}
            >
              Download DXF
            </a>
          </li>
        ))}
      </ul>
      <div className="sk-quote-link">
        {job.linkedQuoteId ? (
          <a
            className="button primary"
            href={"/quotes/" + encodeURIComponent(job.linkedQuoteId)}
          >
            Open linked quote <Icon name="arrow" size={17} />
          </a>
        ) : (
          <button
            type="button"
            className="button primary"
            onClick={startQuote}
            disabled={busy}
          >
            {busy ? <Activity>Creating quote</Activity> : "Start quote from cut list"}{" "}
            <Icon name="arrow" size={17} />
          </button>
        )}
      </div>
    </section>
  );
}

export default function SketchEditor({
  id,
  readOnOpen,
}: {
  id: string;
  readOnOpen: boolean;
}) {
  const endpoint = "/api/sketches/" + encodeURIComponent(id);
  const [job, setJob] = useState<SketchJob | null>(null);
  const [draft, setDraft] = useState<SketchDraft | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [checked, setChecked] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [corner, setCorner] = useState<SelectedCorner | null>(null);
  const running = useRef(false);
  const readAttempted = useRef(false);
  const focusDownloads = useRef(false);
  const openedAssets = useRef<HTMLDetailsElement>(null);
  const dirty =
    !!draft && !!job && JSON.stringify(draft) !== JSON.stringify(job.draft);
  const loaded = !!job;

  useEffect(() => {
    const controller = new AbortController();
    sketchRequest<SketchJob>(endpoint, { signal: controller.signal })
      .then((result) => {
        setJob(result);
        setDraft(result.draft);
      })
      .catch((problem) => {
        if (!controller.signal.aborted) setError(problem.message);
      });
    return () => controller.abort();
  }, [endpoint]);

  useEffect(() => {
    if (
      openedAssets.current &&
      window.matchMedia("(min-width: 980px)").matches
    ) {
      openedAssets.current.open = true;
    }
  }, [loaded]);

  useEffect(() => {
    if (!job?.confirmed || !focusDownloads.current || dirty) return;
    focusDownloads.current = false;
    document.getElementById("sk-downloads")?.focus();
  }, [job?.confirmed, job?.version, dirty]);

  useEffect(() => {
    if (!dirty && !corner) return;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, corner]);

  const perform = useCallback(
    async (action: Action, version: number, changes?: SketchDraft) => {
      if (running.current) return;
      running.current = true;
      setBusy(action);
      setError("");
      setNotice("");
      try {
        const result = await sketchRequest<SketchJob>(endpoint, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            version,
            ...(changes ? { draft: changes } : {}),
            ...(action === "confirm" ? { acknowledged: true } : {}),
          }),
        });
        if (action === "confirm") focusDownloads.current = true;
        setJob(result);
        setDraft(result.draft);
        setChecked(false);
        setCorner(null);
        setPreviewIndex((i) =>
          Math.min(i, Math.max(0, result.draft.parts.length - 1)),
        );
        if (action === "read")
          setNotice("Sketch read. Check the answers below against the photo.");
        if (action === "save")
          setNotice("Draft saved. Come back any time to finish.");
        if (action === "quote")
          setNotice("Quote draft created from this cut list.");
        if (action === "confirm") setNotice("Drawing confirmed.");
      } catch (problem) {
        setError(
          problem instanceof Error
            ? problem.message
            : "Could not update the sketch. Try again.",
        );
      } finally {
        running.current = false;
        setBusy(null);
      }
    },
    [endpoint],
  );

  useEffect(() => {
    if (
      !readOnOpen ||
      !job ||
      job.version !== 1 ||
      job.readAt ||
      job.confirmed ||
      readAttempted.current
    )
      return;
    readAttempted.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("read");
    window.history.replaceState(window.history.state, "", url);
    void perform("read", job.version);
  }, [job, perform, readOnOpen]);

  function change(next: SketchDraft) {
    setDraft(next);
    setChecked(false);
    setNotice("");
  }

  if (!job || !draft) {
    return (
      <div className="sk-workspace">
        <header className="sk-page-heading">
          <h1>Check the sketch</h1>
        </header>
        <section className="panel sk-card">
          {error ? (
            <p role="alert" className="sk-danger">
              {error}
            </p>
          ) : (
            <p role="status"><Activity>Opening the sketch</Activity></p>
          )}
          <a href="/sketches">Back to saved sketches</a>
        </section>
      </div>
    );
  }

  const ready = job.confirmed && !dirty && !corner;
  const issues = drawingIssues(draft);
  const preview = Math.min(previewIndex, Math.max(0, draft.parts.length - 1));

  return (
    <div className="sk-workspace">
      <header className="sk-page-heading sk-editor-heading">
        <div>
          <h1>Check the sketch</h1>
          <p>{draft.title || job.fileName}</p>
        </div>
        <a href="/sketches">Back to saved sketches</a>
      </header>

      <div className="sk-edit-grid">
        <div className="sk-editor-form">
          <div className="sk-alerts" aria-live="polite">
            {notice && <p className="sk-callout">{notice}</p>}
            {busy === "read" && (
              <p className="sk-callout" role="status">
                <Activity>Reading the photo and written dimensions</Activity>
              </p>
            )}
          </div>
          {error && (
            <p role="alert" className="sk-danger">
              {error}
            </p>
          )}
          {ready && (
            <SketchDownloads
              endpoint={endpoint}
              job={job}
              startQuote={() => perform("quote", job.version)}
              busy={busy === "quote"}
            />
          )}
          <section
            className="panel sk-card sk-review-start"
            aria-labelledby="sk-review-heading"
          >
            <h2 id="sk-review-heading">
              {ready ? "Drawing details" : "Check the dimensions"}
            </h2>
            <p>
              Use the written measurements on the photo. You can type fractions
              like 1/4 or decimals like 0.25.
            </p>
            <div className="sk-actions">
              <a
                className="button secondary sk-show-photo"
                href="#sk-original-photo"
                onClick={() => {
                  if (openedAssets.current) openedAssets.current.open = true;
                }}
              >
                See original photo
              </a>
              {!ready && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy !== null || dirty || !!corner}
                  onClick={() => {
                    if (
                      job.version > 1 &&
                      !window.confirm(
                        "Read the photo again and replace the current drawing details?",
                      )
                    )
                      return;
                    void perform("read", job.version);
                  }}
                >
                  {job.readAt ? "Read sketch again" : "Read sketch"}
                </button>
              )}
              {!ready && !issues.length && !corner && (
                <a className="button secondary" href="#sk-confirm-heading">
                  Go to confirmation
                </a>
              )}
            </div>
            {!ready && dirty && (
              <small>Save the draft before reading the photo again.</small>
            )}
            {!!job.questions.length && !ready && (
              <div className="sk-questions">
                <h3>Answers to check</h3>
                <ul>
                  {job.questions.map((question, i) => (
                    <li key={i}>{question}</li>
                  ))}
                </ul>
              </div>
            )}
            {!!job.questions.length && ready && (
              <details className="sk-findings">
                <summary>Questions checked during review</summary>
                <ul>
                  {job.questions.map((question, i) => (
                    <li key={i}>{question}</li>
                  ))}
                </ul>
              </details>
            )}
            {!!job.findings.length && (
              <details className="sk-findings">
                <summary>Measurements read from the photo</summary>
                <dl>
                  {job.findings.map((finding, i) => (
                    <div key={i}>
                      <dt>{finding.label}</dt>
                      <dd>
                        {finding.value}
                        {finding.evidence && (
                          <small>
                            Written on the sketch: {finding.evidence}
                          </small>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}
          </section>
          <fieldset
            className="sk-reset sk-editor-fields"
            disabled={busy !== null}
          >
            <section
              className="panel sk-card sk-form-grid"
              aria-label="Drawing name and units"
            >
              <SketchField label="Drawing name">
                <input
                  value={draft.title}
                  maxLength={100}
                  onChange={(e) => change({ ...draft, title: e.target.value })}
                />
              </SketchField>
              <SketchField label="Units written on the sketch">
                <select
                  value={draft.units ?? ""}
                  onChange={(e) =>
                    change({
                      ...draft,
                      units:
                        e.target.value === "in" || e.target.value === "mm"
                          ? e.target.value
                          : null,
                    })
                  }
                >
                  <option value="">Choose units</option>
                  <option value="in">Inches (in)</option>
                  <option value="mm">Millimeters (mm)</option>
                </select>
              </SketchField>
            </section>
            {draft.parts.map((part, index) => (
              <PartEditor
                key={job.version + "-" + index}
                part={part}
                index={index}
                corner={corner?.partIndex === index ? corner : null}
                editingCorner={!!corner}
                onCorner={(value) =>
                  setCorner(value ? { ...value, partIndex: index } : null)
                }
                onChange={(value) => {
                  change({
                    ...draft,
                    parts: draft.parts.map((current, i) =>
                      i === index ? value : current,
                    ),
                  });
                  setPreviewIndex(index);
                }}
                remove={
                  draft.parts.length > 1
                    ? () => {
                        change({
                          ...draft,
                          parts: draft.parts.filter((_, i) => i !== index),
                        });
                        setPreviewIndex(0);
                      }
                    : undefined
                }
              />
            ))}
            <button
              type="button"
              className="button secondary sk-add-part"
              onClick={() => {
                change({ ...draft, parts: [...draft.parts, blankPart()] });
                setPreviewIndex(draft.parts.length);
              }}
            >
              <Icon name="plus" size={17} /> Add another part
            </button>
            {!ready && (
              <section
                className="panel sk-card sk-confirm"
                aria-labelledby="sk-confirm-heading"
              >
                <h2 id="sk-confirm-heading">Confirm the shop drawing</h2>
                {!!issues.length && (
                  <div className="sk-questions">
                    <h3>Finish these before exporting</h3>
                    <ul>
                      {issues.map((issue, i) => (
                        <li key={i}>{issue}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {!!corner && (
                  <p className="sk-callout">
                    Save or cancel the corner you are editing.
                  </p>
                )}
                <label className="sk-checkbox">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => setChecked(event.target.checked)}
                  />
                  I checked the dimensions and answered the questions from the
                  sketch
                </label>
                <div className="sk-actions">
                  <button
                    type="button"
                    className="button primary"
                    disabled={!checked || issues.length > 0 || !!corner}
                    onClick={() => perform("confirm", job.version, draft)}
                  >
                    {busy === "confirm"
                      ? <Activity>Checking dimensions</Activity>
                      : "Confirm shop drawing"}{" "}
                    <Icon name="check" size={18} />
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!dirty || !!corner}
                    onClick={() => perform("save", job.version, draft)}
                  >
                    {busy === "save" ? <Activity>Saving sketch</Activity> : "Save for later"}
                  </button>
                </div>
              </section>
            )}
          </fieldset>
        </div>
        <aside className="sk-assets" aria-label="Drawing and original photo">
          <section
            className="panel sk-card"
            aria-labelledby="sk-preview-heading"
          >
            <h2 id="sk-preview-heading">Drawing preview</h2>
            {draft.parts.length > 1 && (
              <SketchField label="Preview part">
                <select
                  value={preview}
                  onChange={(e) => setPreviewIndex(Number(e.target.value))}
                >
                  {draft.parts.map((part, i) => (
                    <option key={i} value={i}>
                      {part.name || "Part " + (i + 1)}
                    </option>
                  ))}
                </select>
              </SketchField>
            )}
            <SketchPreview draft={draft} index={preview} endpoint={endpoint} />
          </section>
          <details
            ref={openedAssets}
            className="panel sk-card sk-photo-panel"
            id="sk-original-photo"
          >
            <summary>Original photo</summary>
            <a
              className="sk-photo-frame"
              href={endpoint + "/photo"}
              target="_blank"
              rel="noreferrer"
              aria-label="Open a larger view of the sketch"
            >
              {/* This is the stored upload, served by the sketch photo route. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={endpoint + "/photo"}
                alt={"Original sketch: " + job.fileName}
              />
            </a>
            <a href={endpoint + "/photo?original=1"} download>
              Download original photo
            </a>
          </details>
        </aside>
      </div>
    </div>
  );
}

