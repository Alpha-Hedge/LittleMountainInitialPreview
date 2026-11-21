import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { learningSources, type LearningSource } from "./learning-tables";

const watched = new WeakMap<DatabaseSync, number>();
const clock = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const advance = `ON CONFLICT(entity_key) DO UPDATE SET generation=MAX(learning_queue.generation+1,excluded.generation)`;

function entityExpr(owner: LearningSource["owner"], alias: string): string {
  if (!owner) return "'shop'";
  const id =
    typeof owner === "string"
      ? alias + "." + owner
      : `(SELECT quote_id FROM ${owner.parent} WHERE id=${alias}.${owner.column})`;
  return "'quote:' || " + id;
}

export function initializeLearningTracking(db: DatabaseSync) {
  const schemaVersion = () => Number(db.prepare("PRAGMA schema_version").get()!.schema_version);
  if (watched.get(db) === schemaVersion()) return;
  db.exec("SAVEPOINT install_learning_tracking");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS learning_queue (
      entity_key TEXT PRIMARY KEY, generation INTEGER NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS learning_pending ON learning_queue(entity_key) WHERE generation>acknowledged;`);
    db.prepare("INSERT OR IGNORE INTO app_meta(name,value) VALUES ('learning_workspace',?)").run(
      randomUUID(),
    );
    db.prepare(
      `INSERT OR IGNORE INTO learning_queue(entity_key,generation) VALUES ('shop',${clock})`,
    ).run();
    const names = new Set(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','trigger')")
        .all()
        .map((r) => String(r.name)),
    );
    for (const source of learningSources) {
      if (!names.has(source.table)) continue;
      const prefix = "lmm_queue_" + source.table;
      let added = false;
      for (const action of ["INSERT", "UPDATE", "DELETE"]) {
        const trigger = prefix + "_" + action.toLowerCase();
        if (names.has(trigger)) continue;
        const entity = entityExpr(source.owner, action === "DELETE" ? "OLD" : "NEW");
        db.exec(`CREATE TRIGGER ${trigger} AFTER ${action} ON ${source.table} WHEN (${entity}) IS NOT NULL
          BEGIN INSERT INTO learning_queue(entity_key,generation) VALUES (${entity},${clock}) ${advance}; END;`);
        added = true;
      }
      // Existing rows may predate this migration, or a feature may create its own table lazily.
      // Enqueue its owners in the same transaction that installs the triggers to close that gap.
      if (added) {
        const entity = entityExpr(source.owner, "s");
        db.exec(`INSERT INTO learning_queue(entity_key,generation)
          SELECT DISTINCT ${entity},${clock} FROM ${source.table} s WHERE (${entity}) IS NOT NULL ${advance}`);
      }
    }
    db.exec("RELEASE install_learning_tracking");
    if (!db.isTransaction) watched.set(db, schemaVersion());
  } catch (error) {
    db.exec("ROLLBACK TO install_learning_tracking; RELEASE install_learning_tracking");
    throw error;
  }
}
