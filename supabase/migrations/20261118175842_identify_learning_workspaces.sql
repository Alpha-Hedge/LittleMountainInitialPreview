alter table lmm_learning.workspaces
  add column label text not null default 'Little Mountain Metalworks',
  add column purpose text not null default 'shop' check(purpose in ('shop','verification'));
