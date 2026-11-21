"use client";

import Activity from "@/components/Activity";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SketchJob } from "@/lib/sketch/types";
import {
  sketchStates,
  type SketchSummary,
} from "@/lib/sketch/conversion-types";
import { maxDrawingBytes } from "@/lib/drawing-types";
import { Icon } from "@/components/Icons";
import DrawingFilePicker from "@/components/DrawingFilePicker";
import { sketchRequest } from "./request";

const acceptedPhotos =
  ".jpg,.jpeg,.png,.webp,.heic,.heif,image/jpeg,image/png,image/webp,image/heic,image/heif";

export default function SketchList({ engineering }: { engineering: boolean }) {
  const [jobs, setJobs] = useState<SketchJob[] | null>(null);
  const [photos, setPhotos] = useState<SketchSummary[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState("");
  const [photosLoaded, setPhotosLoaded] = useState(!engineering);
  const submission = useRef("");
  const busy = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    if (engineering)
      sketchRequest<SketchSummary[]>("/api/sketch-conversions", {
        signal: controller.signal,
      })
        .then(result => { setPhotos(result); setPhotosLoaded(true); })
        .catch((problem) => {
          if (!controller.signal.aborted) setListError(problem.message);
        });
    sketchRequest<SketchJob[]>("/api/sketches", { signal: controller.signal })
      .then((result) => setJobs(result))
      .catch((problem) => {
        if (!controller.signal.aborted) setListError(problem.message);
      });
    return () => controller.abort();
  }, [refresh, engineering]);

  function choose(photo: File | null) {
    setFile(photo);
    setError("");
    submission.current = "";
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || !file) return;
    if (!file.size || file.size > maxDrawingBytes) {
      setError("Choose a file up to 20 MB.");
      return;
    }
    busy.current = true;
    setUploading(true);
    setError("");
    submission.current ||= window.crypto.randomUUID();
    const body = new FormData();
    body.set("file", file);
    body.set("token", submission.current);
    try {
      if (engineering) {
        const photo = await sketchRequest<SketchSummary>(
          "/api/sketch-conversions?filename=" + encodeURIComponent(file.name),
          {
            method: "POST",
            body: file,
            headers: {
              "Idempotency-Key": submission.current,
              "Content-Type": file.type || "application/octet-stream",
            },
          },
        );
        window.location.assign("/sketches/photo/" + photo.drawing_id);
        return;
      }
      const job = await sketchRequest<SketchJob>("/api/sketches", {
        method: "POST",
        body,
      });
      window.location.assign(
        "/sketches/" + encodeURIComponent(job.id) + "?read=1",
      );
    } catch (problem) {
      busy.current = false;
      setUploading(false);
      setError(
        problem instanceof Error
          ? problem.message
          : "Could not upload the photo. Try again.",
      );
    }
  }

  const search = query.toLowerCase().trim();
  const matchingPhotos = photos.filter(photo => photo.filename.toLowerCase().includes(search));
  const matchingJobs = (jobs || []).filter(job => (job.draft.title + " " + job.fileName).toLowerCase().includes(search));
  return (
    <div className="sk-workspace">
      <header className="sk-page-heading">
        <h1>Sketch to drawing</h1>
        <p>
          Upload a hand sketch to make an illustrated drawing. Check the measurements when you need cut files.
        </p>
      </header>

      <div className="sk-start-grid">
        <section
          className="panel sk-card sk-upload"
          aria-labelledby="new-sketch-heading"
        >
          <h2 id="new-sketch-heading">
            <Icon name="drawing" size={23} /> {engineering ? "Start with a photo or scan" : "Start with a photo"}
          </h2>
 
          <form onSubmit={upload}>
            <fieldset disabled={uploading} className="sk-reset">
              <div className="sk-photo-choices">
                <DrawingFilePicker accept={acceptedPhotos + (engineering ? ",.pdf,application/pdf" : "")}
                  label={engineering ? "Choose photo or PDF" : "Choose photo"} fileName={file?.name || ""}
                  formats={engineering ? "Photo or one-page PDF" : "JPG, PNG, WebP or HEIC"} onSelect={choose}/> 
                <label className="button secondary sk-file-button sk-camera">
                  Take photo
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    aria-label="Take photo"
                    onChange={(event) => {
                      if (event.currentTarget.files?.length)
                        choose(event.currentTarget.files[0]);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              </div>
 
              {error && (
                <p role="alert" className="sk-danger">
                  {error}
                </p>
              )}
              <button type="submit" className="button primary" disabled={!file}>
                {uploading ? <Activity>Uploading sketch</Activity> : "Upload & read sketch"}{" "}
                <Icon name="arrow" size={18} />
              </button>
            </fieldset>
          </form>
        </section>
        <section
          className="panel sk-card sk-checklist"
          aria-labelledby="photo-checklist"
        >
          <h2 id="photo-checklist">What to write on the sketch</h2>
          <ul>
            <li>Part size and units, in inches or millimeters</li>
            <li>Hole sizes and their locations from the edges</li>
            <li>Material, thickness, and number of pieces</li>
          </ul>
          <p>Photograph the whole page from above so every note can be read.</p>
        </section>
      </div>

      <section
        className="panel sk-card sk-jobs"
        aria-labelledby="saved-sketches-heading"
      >
        <div className="library-head"><h2 id="saved-sketches-heading">Saved sketches</h2>
          <label className="library-search"><Icon name="search" size={16}/><input type="search" aria-label="Find a sketch" placeholder="Find a sketch" value={query} onChange={event => setQuery(event.target.value)}/></label>
        </div>
        {listError && (
          <div className="sk-danger" role="alert">
            <p>{listError}</p>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setListError("");
                setRefresh((value) => value + 1);
              }}
            >
              Try again
            </button>
          </div>
        )}
        {!listError && (!jobs || !photosLoaded) && <p role="status"><Activity>Opening saved sketches</Activity></p>}
        {!!search && jobs && photosLoaded && !matchingJobs.length && !matchingPhotos.length && <p role="status">No sketches match this search.</p>}
        {jobs?.length === 0 && photosLoaded && !photos.length && !listError && !search && (
          <p>Your sketches will appear here after you upload a photo.</p>
        )}
        {(!!jobs?.length || !!photos.length) && (
          <ul className="sk-job-list">
            {matchingPhotos.map((photo) => (
              <li key={photo.drawing_id}>
                <a href={"/sketches/photo/" + photo.drawing_id}>
                  <Icon name="drawing" size={19} />
                  <span className="sk-job-name">
                    <strong>{photo.filename}</strong>
                    <small>Revision {photo.version} · {new Date(photo.created_at).toLocaleString("en-US", {month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"})}</small>
                  </span>
                  <span
                    className={
                      "sk-status" +
                      (photo.state === "released" ? " sk-status-confirmed" : "")
                    }
                  >
                    {sketchStates[photo.state]}
                  </span>
                  <Icon name="chevron" size={17} />
                </a>
              </li>
            ))}
            {matchingJobs.map((job) => (
              <li key={job.id}>
                <a href={"/sketches/" + encodeURIComponent(job.id)}>
                  <Icon name="drawing" size={19} />
                  <span className="sk-job-name">
                    <strong>{job.draft.title || job.fileName}</strong>
                    <small>{job.fileName}</small>
                  </span>
                  <span
                    className={
                      "sk-status" +
                      (job.confirmed ? " sk-status-confirmed" : "")
                    }
                  >
                    {job.confirmed ? "Ready to download" : "Needs review"}
                  </span>
                  <Icon name="chevron" size={17} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
