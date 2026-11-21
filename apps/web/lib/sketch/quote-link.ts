import { getDb } from "../db";

export function sourceSketchId(quoteId: string) {
  const db = getDb();
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name='photo_release_quotes' AND type='table'",
      )
      .get()
  ) {
    const remote = db
      .prepare(
        "SELECT source_id,revision FROM photo_release_quotes WHERE quote_id=?",
      )
      .get(quoteId);
    if (remote) return "release-" + remote.source_id + "-v" + remote.revision;
  }
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name = 'sketch_revisions' AND type = 'table'",
      )
      .get()
  ) {
    return null;
  }
  const row = db
    .prepare("SELECT sketch_id FROM sketch_revisions WHERE quote_id = ?")
    .get(quoteId);
  return row ? String(row.sketch_id) : null;
}
