create or replace view lmm_learning.request_evidence with (security_invoker=true) as
select * from lmm_learning.records where kind in ('quote','drawing_attachment','drawing_revision','drawing_selection','request_message','message_attachment','message_thread','review_run','review_edit','applied_specification','confirmed_specification');
