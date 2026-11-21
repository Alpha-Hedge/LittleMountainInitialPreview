"use client";
import Activity from "@/components/Activity";
import { useState } from "react";
import type { cloudStatus } from "@/lib/cloud-history";
type Status = Awaited<ReturnType<typeof cloudStatus>>;
export default function CloudHistoryStatus({ initial }: { initial: Status }) {
  const [status, setStatus] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function sync() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/learning/sync", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setStatus(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sync shop history.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="panel est-disclose est-panel-details est-support">
      <summary>Saved job history and connection</summary>
      <div className="est-pad est-stack">
        {status.enabled ? (
          <>
            <strong>{status.reachable ? "Connected to the shop’s history" : "Waiting for the shop’s history connection"}</strong>
            <span>
              {status.lines} approved {status.lines === 1 ? "item" : "items"} saved ·{" "}
              {status.pending===0?"All changes sent":status.pending+" changes waiting to send"}
            </span>
            {status.lastSync && (
              <small>
                Latest saved history ·{" "}
                {new Date(status.lastSync).toLocaleString("en-US", { timeZone: "America/New_York" })}{" "}
                Eastern
              </small>
            )}
            <div>
              <button type="button" className="button secondary" disabled={busy} onClick={sync}>
                {busy ? <Activity>Updating history</Activity> : "Update job history"}
              </button>
            </div>
          </>
        ) : (
          <span>
            This computer is using its own saved jobs.
          </span>
        )}
        {(error || status.error) && <p role="alert">{error || status.error}</p>}
      </div>
    </details>
  );
}
