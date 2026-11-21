import { engineeringConnection as connection } from "./engineering-connection";
import { engineeringDb, freezeEngineeringApproval } from "./engineering-ledger";
import { getDrawingRevision } from "./drawings";

export function archiveStatus() {
  const db = engineeringDb();
  const stats = db.prepare("SELECT count(*) AS total,count(receipt) AS stored FROM engineering_approvals").get()!;
  const issue = db.prepare("SELECT last_error FROM engineering_approvals WHERE receipt IS NULL AND last_error IS NOT NULL LIMIT 1").get();
  return { enabled:!!connection(), stored:Number(stats.stored), pending:Number(stats.total)-Number(stats.stored), issue:issue ? String(issue.last_error) : null };
}

let active: Promise<void> | undefined;
export function syncEngineeringArchive() {
  if (!active) active = synchronize().finally(() => { active = undefined; });
  return active;
}

async function synchronize() {
  const config = connection();
  if (!config) return;
  const db = engineeringDb();
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='quote_workflow'").get()) return;
  // Recover old approvals and resume interrupted uploads using the frozen approval record.
  const old = db.prepare(`SELECT w.snapshot,w.customer_json,w.approved_at FROM quote_workflow w
    LEFT JOIN engineering_approvals e ON e.quote_id=w.quote_id AND e.version=w.version
    WHERE w.approved_at IS NOT NULL AND e.quote_id IS NULL LIMIT 16`).all();
  for (const row of old) freezeEngineeringApproval(JSON.parse(String(row.snapshot)), JSON.parse(String(row.customer_json)), String(row.approved_at));
  const jobs = db.prepare(`SELECT quote_id,version,payload,attempts FROM engineering_approvals
    WHERE receipt IS NULL AND retry_after<=? ORDER BY retry_after,version LIMIT 10`).all(Date.now());
  async function post(route: string, type: string, body: BodyInit) {
    const result = await fetch(config!.origin + route, { method:"POST", redirect:"error", cache:"no-store",
      headers:{ Authorization:"Bearer " + config!.token, "Content-Type":type }, body, signal:AbortSignal.timeout(30_000) });
    if (!result.ok) throw new Error("Engineering archive returned HTTP " + result.status);
    const receipt = await result.json();
    if (typeof receipt.id !== "string") throw new Error("Engineering archive returned an incomplete receipt.");
    return receipt;
  }
  for (const job of jobs) {
    const id = String(job.quote_id), version = Number(job.version);
    try {
      const payload = JSON.parse(String(job.payload));
      const drawing = payload.pricing_inputs.drawing;
      if (drawing && !payload.drawing_id) {
        const source = getDrawingRevision(id, drawing.id);
        if (!source) throw new Error("The selected drawing revision is unavailable.");
        const ordinal = db.prepare(`SELECT count(*) AS number FROM drawing_revisions WHERE attachment_id=?
          AND rowid <= (SELECT rowid FROM drawing_revisions WHERE id=?)`).get(source.attachmentId, source.id)!;
        const query = new URLSearchParams({drawing_key:source.attachmentId, revision:String(ordinal.number), filename:source.fileName,
          source_type:source.mimeType === "application/pdf" ? "CUSTOMER_PDF" : "CUSTOMER_IMAGE"});
        const receipt = await post("/v1/drawings?" + query, source.mimeType, new Uint8Array(source.bytes));
        payload.drawing_id = receipt.id;
      }
      const receipt = await post("/v1/quote-versions", "application/json", JSON.stringify(payload));
      db.prepare("UPDATE engineering_approvals SET receipt=?,last_error=NULL WHERE quote_id=? AND version=?")
        .run(JSON.stringify(receipt), id, version);
    } catch (error) {
      const message = error instanceof Error && (error.message.startsWith("Engineering archive") || error.message.startsWith("The selected drawing"))
        ? error.message : "Engineering archive is unavailable. A retry is scheduled.";
      const wait = Math.min(300_000, 1000 * 2 ** Math.min(9, Number(job.attempts)));
      db.prepare("UPDATE engineering_approvals SET attempts=attempts+1,last_error=?,retry_after=? WHERE quote_id=? AND version=? AND receipt IS NULL")
        .run(message, Date.now() + wait, id, version);
    }
  }
}

const tasks = globalThis as typeof globalThis & { engineeringArchiveTimer?: ReturnType<typeof setInterval> };
export function startEngineeringArchive() {
  if (tasks.engineeringArchiveTimer || !connection()) return;
  const tick = () => { void syncEngineeringArchive().catch(() => console.error("Engineering archive synchronization could not complete.")); };
  tasks.engineeringArchiveTimer = setInterval(tick, 15_000);
  tasks.engineeringArchiveTimer.unref();
  tick();
}
