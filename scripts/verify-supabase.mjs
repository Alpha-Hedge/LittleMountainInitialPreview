import "./test-typescript.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
const { cloudConfigured, syncLearningHistory, readApprovedFile } = await import(
  "../apps/web/lib/cloud-history.ts"
);
const { getLearningWorkspaceId, exportLearningEntity, getLearningSyncCounts } = await import(
  "../apps/web/lib/learning-export.ts"
);
const { listQuotes } = await import("../apps/web/lib/quotes.ts");
const { getDb } = await import("../apps/web/lib/db.ts");
assert.ok(cloudConfigured(), "Load .env.local for the data directory being verified.");
await syncLearningHistory();
const workspace = getLearningWorkspaceId();
const client = new pg.Client({
  connectionString: process.env.LMM_SUPABASE_READ_URL,
  ssl: {
    ca: await readFile(process.env.LMM_SUPABASE_CA_FILE || "supabase/prod-ca.crt", "utf8"),
    rejectUnauthorized: true,
  },
});
await client.connect();
try {
  const roles =
    await client.query(`SELECT has_table_privilege(current_user,'lmm_learning.records','SELECT') AS can_read,
    has_table_privilege(current_user,'lmm_learning.records','UPDATE') AS can_change,
    has_table_privilege(current_user,'lmm_learning.approved_lines','INSERT') AS can_invent,
    has_schema_privilege('anon','lmm_learning','USAGE') AS public_access`);
  assert.deepEqual(roles.rows[0], {
    can_read: true,
    can_change: false,
    can_invent: false,
    public_access: false,
  });
  let records = 0,
    checkedFiles = 0;
  const seen = new Set();
  const archived = getDb().prepare("SELECT entity_key FROM learning_queue WHERE entity_key LIKE 'engineering:%'").all();
  for (const entity of ["shop", ...listQuotes().map((q) => "quote:" + q.id), ...archived.map(r => r.entity_key)]) {
    const snapshot = exportLearningEntity(entity);
    const cloud = await client.query(
      "SELECT kind,record_key,data FROM lmm_learning.records WHERE workspace_id=$1 AND entity_key=$2",
      [workspace, entity],
    );
    const lookup = new Map(cloud.rows.map((r) => [JSON.stringify([r.kind, r.record_key]), r.data]));
    assert.equal(snapshot.records.length, lookup.size);
    for (const r of snapshot.records) {
      assert.deepEqual(lookup.get(JSON.stringify([r.kind, r.key])), JSON.parse(JSON.stringify(r.data)));
      if (r.kind === "workflow_version" && r.data.approved_at) {
        const file = await readApprovedFile(workspace, entity.slice(6), Number(r.data.version), "pdf");
        assert.equal(createHash("sha256").update(file.bytes).digest("hex"), r.data.customer_pdf.sha256);
      }
    }
    for (const file of snapshot.files) {
      if (seen.has(file.sha256)) continue;
      seen.add(file.sha256);
      const bytes = await client.query("SELECT original FROM lmm_learning.files WHERE sha256=$1", [
        file.sha256,
      ]);
      assert.ok(file.bytes.equals(bytes.rows[0].original));
      checkedFiles++;
    }
    records += lookup.size;
  }
  assert.equal(getLearningSyncCounts().pending, 0);
  console.log(
    "Verified",
    records,
    "Supabase records and",
    checkedFiles,
    "byte-identical originals or previews. Estimator login is read-only. Anonymous access is closed.",
  );
} finally {
  await client.end();
}
