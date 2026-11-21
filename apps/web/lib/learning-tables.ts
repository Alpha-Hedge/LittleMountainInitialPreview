// Only these columns are eligible for the shop's shared learning database.
// In particular, account credentials, refresh tokens and delivery leases are private to the workstation.
export interface LearningSource {
  table: string;
  kind: string;
  columns: string;
  key: string[];
  owner: string | { column: string; parent: string } | null;
  json?: string[];
}

const quote = "quote_id";
export const learningSources: LearningSource[] = [
  {
    table: "quotes",
    kind: "quote",
    columns: "id, sequence, version, draft, created_at, updated_at",
    key: ["id"],
    owner: "id",
    json: ["draft"],
  },
  {
    table: "quote_versions",
    kind: "quote_version",
    columns: "id, version, sequence, draft, created_at, updated_at",
    key: ["version"],
    owner: "id",
    json: ["draft"],
  },
  {
    table: "drawing_attachments",
    kind: "drawing_attachment",
    columns: "id, quote_id, name",
    key: ["id"],
    owner: quote,
  },
  {
    table: "drawing_revisions",
    kind: "drawing_revision",
    columns: "id, attachment_id, label, file_name, mime, original, thumbnail, created_at",
    key: ["id"],
    owner: { column: "attachment_id", parent: "drawing_attachments" },
  },
  {
    table: "drawing_selections",
    kind: "drawing_selection",
    columns: "quote_id, revision_id",
    key: ["quote_id"],
    owner: quote,
  },
  {
    table: "review_runs",
    kind: "review_run",
    columns:
      "id, quote_id, revision_id, quote_version, notes, provider, model, raw_result, parts, created_at",
    key: ["id"],
    owner: quote,
    json: ["parts"],
  },
  {
    table: "review_edits",
    kind: "review_edit",
    columns: "run_id, version, corrections, action, created_at",
    key: ["run_id", "version"],
    owner: { column: "run_id", parent: "review_runs" },
    json: ["corrections"],
  },
  {
    table: "review_applied_items",
    kind: "applied_specification",
    columns: "run_id, part_index, item_id, source_identity",
    key: ["run_id", "part_index"],
    owner: { column: "run_id", parent: "review_runs" },
    json: ["source_identity"],
  },
  {
    table: "quote_workflow",
    kind: "workflow_version",
    columns: "quote_id, version, status, snapshot, approved_at, customer_json, customer_pdf, expires_on",
    key: ["version"],
    owner: quote,
    json: ["snapshot", "customer_json"],
  },
  {
    table: "quote_events",
    kind: "quote_event",
    columns: "id, quote_id, version, kind, message, at",
    key: ["id"],
    owner: quote,
  },
  {
    table: "completed_job_edits",
    kind: "completed_job_edit",
    columns: "quote_id, quote_version, edit, payload, recorded_at",
    key: ["quote_version", "edit"],
    owner: quote,
    json: ["payload"],
  },
  {
    table: "history_estimates",
    kind: "history_estimate",
    columns: "id, quote_id, item_id, template_id, body, provider_raw, applied_version, edits",
    key: ["id"],
    owner: quote,
    json: ["body", "edits"],
  },
  {
    table: "template_allowance_proposals",
    kind: "allowance_proposal",
    columns:
      "id, run_id, template_id, operation_id, label, before_op, after_amount, unit, reason, status, decision_at, decided_by, settings_version",
    key: ["id"],
    owner: { column: "run_id", parent: "history_estimates" },
    json: ["before_op"],
  },
  {
    table: "estimating_settings",
    kind: "estimating_settings",
    columns: "version, body, created_at",
    key: ["version"],
    owner: null,
    json: ["body"],
  },
  {
    table: "mail_messages",
    kind: "request_message",
    columns:
      "id, quote_id, rfc_id, account, provider_id, thread_id, sender, sender_name, reply_to, subject, body, sent_at, raw",
    key: ["id"],
    owner: quote,
  },
  {
    table: "mail_files",
    kind: "message_attachment",
    columns: "id, message_id, name, mime, original, drawing_revision",
    key: ["id"],
    owner: { column: "message_id", parent: "mail_messages" },
  },
  {
    table: "mail_clarifications",
    kind: "clarification",
    columns: "quote_id, body, updated",
    key: ["quote_id"],
    owner: quote,
  },
  {
    table: "mail_links",
    kind: "message_thread",
    columns: "identifier, quote_id",
    key: ["identifier"],
    owner: quote,
  },
  {
    table: "mail_outbox",
    kind: "delivery",
    columns:
      "id, quote_id, version, channel, recipient, sender, rfc_id, thread_id, raw, status, receipt, detail, updated",
    key: ["id"],
    owner: quote,
  },
];
