"use client";

import Activity from "@/components/Activity";
import { useRef, useState, type FormEvent } from "react";
import { maxDrawingBytes } from "@/lib/drawing-types";
import { startBlueprint } from "@/lib/start-blueprint";
import { Icon } from "./Icons";
import DrawingFilePicker from "./DrawingFilePicker";

export default function QuoteDrawingStart({
  onStart,
  detailedReader,
}: {
  onStart: (reviewUrl: string) => void;
  detailedReader: boolean;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const submission = useRef("");
  const busy = useRef(false);
  const detailed = detailedReader && /\.(pdf|dxf)$/i.test(fileName);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    if (!(file instanceof File) || !file.size || file.size > maxDrawingBytes) {
      setError("Choose a drawing file up to 20 MB.");
      return;
    }
    submission.current ||= crypto.randomUUID();
    form.set("token", submission.current);
    busy.current = true;
    setWorking(true);
    setError("");
    try {
      const useQuickReader = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value === "quick";
      if (detailedReader && /\.(pdf|dxf)$/i.test(file.name) && !useQuickReader) {
        const notes = String(form.get("notes") ?? "");
        if (notes.length > 16000) throw new Error("Use up to 16,000 characters for the drawing notes.");
        onStart(await startBlueprint(file, submission.current, { notes }));
        return;
      }
      const response = await fetch("/api/quotes/from-drawing", {
        method: "POST",
        body: form,
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error || "Could not start the quote. Try again.",
        );
      onStart(
        "/quotes/" +
          result.quoteId +
          "/review/" +
          result.revisionId +
          "?read=1",
      );
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : "Could not start the quote. Try again.",
      );
      busy.current = false;
      setWorking(false);
    }
  }

  return (
    <form
      className="panel qe-intake"
      onSubmit={start}
      onChange={() => {
        submission.current = "";
        setError("");
      }}
    >
      <fieldset disabled={working}>
        <DrawingFilePicker name="file" label="Drawing or photo" fileName={fileName} required
          accept={detailedReader ? ".pdf,.dxf,.png,.jpeg,.jpg,.webp" : ".pdf,.png,.jpeg,.jpg,.webp"}
          formats={detailedReader ? "PDF, DXF, JPG, PNG or WebP" : "PDF, JPG, PNG or WebP"}
          onSelect={file => setFileName(file?.name ?? "")}/>
        {detailed && <p className="intake-reader-note">Next, check the parts and quantities found on this drawing.</p>}
        <label className="field">
          <span>
            Customer notes <small>Optional</small>
          </span>
          <textarea
            name="notes"
            rows={3}
            maxLength={detailed ? 16000 : 50000}
            placeholder="Paste the email or enter the order quantity, finish, or delivery details."
          />
        </label>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        {working && <p role="status">Uploading your drawing. The review will open here.</p>}
        <button type="submit" className="button primary">
          {working ? <Activity>Uploading drawing</Activity> : "Read drawing & start quote"}{" "}
          <Icon name="arrow" size={18} />
        </button>
        {error && detailed && /\.pdf$/i.test(fileName) && <button className="button secondary" type="submit" value="quick">Start a basic quote instead</button>}
      </fieldset>
    </form>
  );
}
