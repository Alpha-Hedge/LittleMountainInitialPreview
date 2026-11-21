import { workspaceRoot } from "./workspace-root";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { getDataDir } from "./db";
import {
  acknowledgeLearningEntity,
  exportLearningEntity,
  getLearningSyncCounts,
  getLearningWorkspaceId,
  getPendingLearningEntities,
  type LearningEntity,
} from "./learning-export";
import type { Comparable } from "./job-types";
import { QuoteError } from "./quotes";
import type { ReviewSnapshot } from "./workflow-types";
import type { JobRecord } from "./job-types";
import { captureEngineeringLearning } from "./engineering-learning";

type CloudRuntime = {
  reader?: Pool;
  writer?: Pool;
  syncing?: Promise<void>;
  timer?: NodeJS.Timeout;
  lastError?: string;
  lastSuccess?: string;
  capturing?: boolean;
  engineeringCursor?: string;
  engineeringError?: string;
};
const globalRuntime = globalThis as typeof globalThis & { lmmCloudHistory?: CloudRuntime };
const runtime = (globalRuntime.lmmCloudHistory ??= {});
const unavailable = "Supabase history is unavailable. Saved edits are queued on this workstation.";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function cloudConfigured() {
  // Separate working copies and verification databases must opt in to publishing.
  if (getDataDir() !== path.resolve(workspaceRoot(), process.env.LMM_SUPABASE_DATA_DIR || "data")) return false;
  if (!process.env.LMM_SUPABASE_READ_URL && !process.env.LMM_SUPABASE_WRITE_URL) return false;
  if (!process.env.LMM_SUPABASE_READ_URL || !process.env.LMM_SUPABASE_WRITE_URL) {
    throw new QuoteError("Configure both Supabase server connection URLs.", 503);
  }
  return true;
}
function pool(role: "reader" | "writer") {
  if (!cloudConfigured()) throw new QuoteError("Supabase is not configured for this workspace.", 503);
  if (!runtime[role]) {
    const ca = readFileSync(
      path.resolve(workspaceRoot(), process.env.LMM_SUPABASE_CA_FILE || "supabase/prod-ca.crt"),
      "utf8",
    );
    const uri = new URL(
      (role === "reader" ? process.env.LMM_SUPABASE_READ_URL : process.env.LMM_SUPABASE_WRITE_URL)!,
    );
    // The TLS configuration is owned by the server. URI sslmode can override CA/hostname verification in pg.
    for (const option of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "sslnegotiation"])
      uri.searchParams.delete(option);
    const p = new Pool({
      connectionString: uri.href,
      ssl: { ca, rejectUnauthorized: true },
      max: 2,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 15000,
      statement_timeout: 60000,
      allowExitOnIdle: true,
      application_name: "Little Mountain " + role,
    });
    p.on("error", () => {
      runtime.lastError = unavailable;
    });
    runtime[role] = p;
  }
  return runtime[role];
}
function readableWorkspaces() {
  const others = (process.env.LMM_SUPABASE_SHARED_WORKSPACES || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => uuid.test(s));
  return [...new Set([getLearningWorkspaceId(), ...others])];
}
async function upload(client: PoolClient, id: string, snapshot: LearningEntity) {
  const key = snapshot.key;
  const purpose = process.env.LMM_SUPABASE_WORKSPACE_KIND === "verification" ? "verification" : "shop";
  const label =
    process.env.LMM_SUPABASE_WORKSPACE_LABEL ||
    (purpose === "shop" ? "Little Mountain Metalworks" : "Verification workspace");
  await client.query(
    "INSERT INTO lmm_learning.workspaces(id,label,purpose) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    [id, label, purpose],
  );
  await client.query(
    "INSERT INTO lmm_learning.entities(workspace_id,entity_key,generation) VALUES($1,$2,0) ON CONFLICT DO NOTHING",
    [id, key],
  );
  const locked = await client.query(
    "SELECT generation FROM lmm_learning.entities WHERE workspace_id=$1 AND entity_key=$2 FOR UPDATE",
    [id, key],
  );
  if (Number(locked.rows[0].generation) >= snapshot.generation) return;
  if (snapshot.files.length) {
    const existing = await client.query(
      "SELECT sha256 FROM lmm_learning.files WHERE sha256=ANY($1::text[])",
      [snapshot.files.map((f) => f.sha256)],
    );
    const known = new Set(existing.rows.map((r) => r.sha256));
    for (const file of snapshot.files)
      if (!known.has(file.sha256)) {
        await client.query(
          "INSERT INTO lmm_learning.files(sha256,original) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [file.sha256, file.bytes],
        );
      }
  }
  await client.query("DELETE FROM lmm_learning.records WHERE workspace_id=$1 AND entity_key=$2", [
    id,
    key,
  ]);
  for (let offset = 0; offset < snapshot.records.length; offset += 100) {
    await client.query(
      `INSERT INTO lmm_learning.records(workspace_id,entity_key,kind,record_key,data)
      SELECT $1,$2,r.kind,r.key,r.data FROM jsonb_to_recordset($3::jsonb) AS r(kind text,key text,data jsonb)`,
      [id, key, JSON.stringify(snapshot.records.slice(offset, offset + 100))],
    );
  }
  await client.query("DELETE FROM lmm_learning.approved_lines WHERE workspace_id=$1 AND entity_key=$2", [
    id,
    key,
  ]);
  if (snapshot.candidates.length) {
    await client.query(
      `INSERT INTO lmm_learning.approved_lines(workspace_id,entity_key,quote_id,quote_version,line_id,evidence)
      SELECT $1,$2,v->>'quoteId',(v->>'version')::integer,v->>'lineId',v FROM jsonb_array_elements($3::jsonb) AS v`,
      [id, key, JSON.stringify(snapshot.candidates)],
    );
  }
  await client.query(
    "UPDATE lmm_learning.entities SET generation=$3,synced_at=now() WHERE workspace_id=$1 AND entity_key=$2",
    [id, key, snapshot.generation],
  );
}
async function flush() {
  const id = getLearningWorkspaceId();
  for (;;) {
    const pending = getPendingLearningEntities(25);
    if (!pending.length) break;
    for (const entity of pending) {
      const snapshot = exportLearningEntity(entity.key);
      const client = await pool("writer").connect();
      let failed = false;
      try {
        await client.query("BEGIN");
        await upload(client, id, snapshot);
        await client.query("COMMIT");
        acknowledgeLearningEntity(entity.key, snapshot.generation);
      } catch (error) {
        failed = true;
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release(failed);
      }
    }
  }
  runtime.lastError = undefined;
  runtime.lastSuccess = new Date().toISOString();
}
export async function syncLearningHistory() {
  if (!cloudConfigured()) return;
  runtime.syncing ??= flush()
    .catch((error: unknown) => {
      runtime.lastError = unavailable;
      // Only log the driver code. Connection strings and customer records stay out of the logs.
      console.error(
        "Learning history sync failed",
        error && typeof error === "object" && "code" in error ? error.code : "sync",
      );
      throw new QuoteError(unavailable, 503);
    })
    .finally(() => {
      runtime.syncing = undefined;
    });
  await runtime.syncing;
}
export function startLearningSync() {
  if (runtime.timer || !cloudConfigured()) return;
  const tick = () => {
    void syncLearningHistory().catch(() => {});
    if (!runtime.capturing) {
      runtime.capturing = true;
      void captureEngineeringLearning(runtime.engineeringCursor || "").then((cursor) => {
        runtime.engineeringCursor = cursor;
        runtime.engineeringError = undefined;
        return syncLearningHistory().catch(() => {});
      }).catch(() => {
        runtime.engineeringError = "Engineering drawings are waiting to sync.";
      }).finally(() => { runtime.capturing = false; });
    }
  };
  runtime.timer = setInterval(tick, 15000);
  runtime.timer.unref();
  setTimeout(tick, 500).unref();
}
export async function readLearningCandidates(): Promise<Comparable[] | null> {
  if (!cloudConfigured()) return null;
  await syncLearningHistory();
  const localId = getLearningWorkspaceId();
  try {
    const res = await pool("reader").query(
      `SELECT workspace_id,evidence FROM lmm_learning.approved_lines
      WHERE workspace_id=ANY($1::uuid[]) ORDER BY workspace_id,quote_id,quote_version DESC,line_id`,
      [readableWorkspaces()],
    );
    return res.rows.map((row) => {
      const c = row.evidence as Comparable,
        workspace = String(row.workspace_id);
      return {
        ...c,
        sourceWorkspace: workspace,
        evidenceHref:
          workspace === localId
            ? undefined
            : "/learning/" + workspace + "/" + encodeURIComponent(c.quoteId) + "?version=" + c.version,
      };
    });
  } catch {
    throw new QuoteError(
      "Could not read the approved evidence from Supabase. Retry the comparison.",
      503,
    );
  }
}
export async function cloudStatus() {
  const local = getLearningSyncCounts();
  try {
    if (!cloudConfigured())
      return {
        enabled: false,
        reachable: false,
        ...local,
        entities: 0,
        lines: 0,
        lastSync: null,
        error: "",
      };
    const state = await pool("reader").query(
      `SELECT count(*)::int AS entities,max(synced_at) AS at,
      (SELECT count(*)::int FROM lmm_learning.approved_lines WHERE workspace_id=$1) AS lines FROM lmm_learning.entities WHERE workspace_id=$1`,
      [getLearningWorkspaceId()],
    );
    const row = state.rows[0];
    return {
      enabled: true,
      reachable: true,
      ...local,
      entities: Number(row.entities),
      lines: Number(row.lines),
      lastSync: row.at ? new Date(row.at).toISOString() : null,
      error: runtime.lastError || runtime.engineeringError || "",
    };
  } catch {
    return {
      enabled: true,
      reachable: false,
      ...local,
      entities: 0,
      lines: 0,
      lastSync: null,
      error: unavailable,
    };
  }
}
export async function readApprovedEvidence(
  workspace: string,
  quoteId: string,
  version: number,
  edit?: number,
) {
  if (
    !cloudConfigured() ||
    !uuid.test(workspace) ||
    !readableWorkspaces().includes(workspace) ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    return null;
  const client = pool("reader"),
    key = "quote:" + quoteId;
  const snap = await client.query(
    `SELECT data FROM lmm_learning.records WHERE workspace_id=$1 AND entity_key=$2
    AND kind='workflow_version' AND record_key=$3 AND data->>'approved_at' IS NOT NULL`,
    [workspace, key, String(version)],
  );
  if (!snap.rowCount) return null;
  const actual = await client.query(
    `SELECT data FROM lmm_learning.records WHERE workspace_id=$1 AND entity_key=$2
    AND kind='completed_job_edit' AND (data->>'quote_version')::integer=$3 AND ($4::integer IS NULL OR (data->>'edit')::integer=$4)
    ORDER BY (data->>'edit')::integer DESC LIMIT 1`,
    [workspace, key, version, edit ?? null],
  );
  if (edit !== undefined && !actual.rowCount) return null;
  return {
    snapshot: snap.rows[0].data.snapshot as ReviewSnapshot,
    approvedAt: String(snap.rows[0].data.approved_at),
    actual: (actual.rows[0]?.data?.payload ?? null) as JobRecord | null,
  };
}
export async function readApprovedFile(
  workspace: string,
  quoteId: string,
  version: number,
  asset: "pdf" | "drawing",
) {
  const record = await readApprovedEvidence(workspace, quoteId, version);
  if (!record) return null;
  const kind = asset === "pdf" ? "workflow_version" : "drawing_revision";
  const key = asset === "pdf" ? String(version) : record.snapshot.drawing?.id;
  if (!key) return null;
  const field = asset === "pdf" ? "customer_pdf" : "original";
  const result = await pool("reader").query(
    `SELECT f.original,r.data->$5::text AS file FROM lmm_learning.records r
    JOIN lmm_learning.files f ON f.sha256=(r.data->$5::text->>'sha256')
    WHERE r.workspace_id=$1 AND r.entity_key=$2 AND r.kind=$3 AND r.record_key=$4`,
    [workspace, "quote:" + quoteId, kind, key, field],
  );
  if (!result.rowCount) return null;
  const { original, file } = result.rows[0];
  return { bytes: original as Buffer, mime: String(file.mimeType), name: String(file.fileName) };
}
