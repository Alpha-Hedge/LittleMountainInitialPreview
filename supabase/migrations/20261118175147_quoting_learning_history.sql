-- Private shop history. The workstation exports each entity in one transaction.
create schema lmm_learning;
revoke all on schema lmm_learning from public, anon, authenticated;
create role lmm_history_ingest nologin;
create role lmm_history_read nologin;
grant usage on schema lmm_learning to lmm_history_ingest, lmm_history_read;

create table lmm_learning.workspaces (
  id uuid primary key,
  created_at timestamptz not null default now()
);
create table lmm_learning.entities (
  workspace_id uuid not null references lmm_learning.workspaces(id),
  entity_key text not null,
  generation bigint not null check (generation >= 0),
  synced_at timestamptz not null default now(),
  primary key (workspace_id, entity_key)
);
create table lmm_learning.files (
  sha256 text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
  original bytea not null check (sha256 = encode(sha256(original),'hex')),
  byte_length bigint generated always as (octet_length(original)::bigint) stored,
  inserted_at timestamptz not null default now()
);
create table lmm_learning.records (
  workspace_id uuid not null,
  entity_key text not null,
  kind text not null,
  record_key text not null,
  data jsonb not null check (jsonb_typeof(data)='object'),
  primary key (workspace_id,entity_key,kind,record_key),
  foreign key (workspace_id,entity_key) references lmm_learning.entities
);
create index records_kind_lookup on lmm_learning.records(kind,workspace_id,entity_key);

-- One candidate per approved line and version. Actuals retain their source edit number.
create table lmm_learning.approved_lines (
  workspace_id uuid not null,
  entity_key text not null,
  quote_id text not null,
  quote_version integer not null check (quote_version>0),
  line_id text not null,
  evidence jsonb not null check (jsonb_typeof(evidence)='object'),
  work_type text generated always as (lower(evidence->>'workType')) stored,
  material text generated always as (lower(evidence->>'material')) stored,
  quantity numeric generated always as ((evidence->>'quantity')::numeric) stored,
  primary key(workspace_id,entity_key,quote_version,line_id),
  foreign key (workspace_id,entity_key) references lmm_learning.entities
);
create index approved_lines_search on lmm_learning.approved_lines(work_type,material,quantity);
create index approved_lines_quote on lmm_learning.approved_lines(workspace_id,quote_id,quote_version);

do $$
declare relation text;
begin
  foreach relation in array array['workspaces','entities','records','files','approved_lines'] loop
    execute format('alter table lmm_learning.%I enable row level security', relation);
    execute format('create policy shop_ingest on lmm_learning.%I to lmm_history_ingest using(true) with check(true)', relation);
    execute format('create policy shop_read on lmm_learning.%I for select to lmm_history_read using(true)', relation);
  end loop;
end $$;
revoke all on all tables in schema lmm_learning from public, anon, authenticated;
grant select,insert on lmm_learning.workspaces,lmm_learning.files to lmm_history_ingest;
grant select,insert,update on lmm_learning.entities to lmm_history_ingest;
grant select,insert,update,delete on lmm_learning.records,lmm_learning.approved_lines to lmm_history_ingest;
grant select on all tables in schema lmm_learning to lmm_history_read;

create view lmm_learning.request_evidence with (security_invoker=true) as
  select * from lmm_learning.records where kind in ('quote','drawing_attachment','drawing_revision','drawing_selection','request_message','message_attachment','message_thread','review_run','review_edit','applied_specification');
create view lmm_learning.pricing_history with (security_invoker=true) as
  select * from lmm_learning.records where kind in ('shop_rate','estimating_settings','estimating_template','quote_version','workflow_version','quote_event','allowance_proposal');
create view lmm_learning.job_actuals with (security_invoker=true) as
  select * from lmm_learning.records where kind='completed_job_edit';
create view lmm_learning.estimate_decisions with (security_invoker=true) as
  select * from lmm_learning.records where kind in ('history_estimate','allowance_proposal','workflow_version','quote_event');
grant select on lmm_learning.request_evidence,lmm_learning.pricing_history,lmm_learning.job_actuals,lmm_learning.estimate_decisions to lmm_history_read;
