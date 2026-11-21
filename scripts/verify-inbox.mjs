import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import PostalMime from "postal-mime";

const script=fileURLToPath(import.meta.url), root=path.dirname(path.dirname(script));
const stage=process.argv[2];
if (!stage) {
  const base=path.join(root,".test-results");
  mkdirSync(base,{recursive:true});
  const dir=mkdtempSync(path.join(base,"inbox-"));
  for (const phase of ["import","reopen"]) execFileSync(process.execPath,[script,phase],{
    cwd:root,env:{...process.env,LMM_DATA_DIR:dir,LMM_GMAIL_CLIENT_ID:"fixture",LMM_GMAIL_CLIENT_SECRET:"local-test-only"},stdio:"inherit",windowsHide:true});
  console.log("Verified inbox archive and captured email in",dir);
} else {
  assert.ok(["import","reopen"].includes(stage) && process.env.LMM_DATA_DIR?.startsWith(path.join(root,".test-results","inbox-")));
  registerHooks({
    resolve(specifier,context,next) {
      try { return next(specifier,context); } catch(e) {
        if (e.code==="ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && !path.extname(specifier)) return next(specifier+".ts",context);
        throw e;
      }
    },
    load(url,context,next) {
      if (!url.startsWith("file:") || !url.endsWith(".ts")) return next(url,context);
      return {format:"module",shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(url),"utf8"),{compilerOptions:{
        module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};
    }
  });
  const {importEmail,draftClarification}=await import("../apps/web/lib/email/import.ts");
  const {mailDb,testRecipient,testSender}=await import("../apps/web/lib/email/store.ts");
  const {getQuote,updateQuote,listQuotes}=await import("../apps/web/lib/quotes.ts");
  const {getDrawingState}=await import("../apps/web/lib/drawings.ts");
  const {getQuoteReview,changeWorkflow,getApprovedPackage,getWorkflowStatus}=await import("../apps/web/lib/workflow.ts");
  const {sendApproved}=await import("../apps/web/lib/email/delivery.ts");
  const {finishConsent,selectGmailLabel,importLabel,gmailSettings}=await import("../apps/web/lib/email/gmail.ts");
  const db=mailDb();
  const fixtures=["request","revision"].map(n=>readFileSync(path.join(root,"fixtures","mail",n+".eml")));
  const fakeSender="nick@shop.example", customer="rfq@ridgeline.example", thread="fixture-thread";
  let calls=0, allowLookup=stage==="reopen", incoming=["request","revision"], heldDraft;
  // Model the official Gmail REST shapes locally. No call falls through to the network.
  globalThis.fetch=async (resource,options={})=>{
    const url=new URL(resource), req=url.pathname.split("/users/me/")[1];
    if(url.origin==="https://oauth2.googleapis.com" && url.pathname==="/token") return Response.json({access_token:"fixture",refresh_token:"fixture-refresh",
      scope:"https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose"});
    assert.equal(url.origin,"https://gmail.googleapis.com");
    assert.equal(options.headers.Authorization,"Bearer fixture");
    if(req==="profile") return Response.json({emailAddress:fakeSender});
    if(req==="labels") return Response.json({labels:[{id:"Label_5",name:"Quoting"}]});
    if(req==="messages" && url.searchParams.get("labelIds")==="Label_5") return Response.json({messages:incoming.toReversed().map(id=>({id,threadId:thread}))});
    if(req==="messages/request" || req==="messages/revision") {
      const index=req.endsWith("request")?0:1;
      return Response.json({id:["request","revision"][index],threadId:thread,labelIds:["Label_5"],raw:fixtures[index].toString("base64url")});
    }
    if(req==="messages" && url.searchParams.get("labelIds")==="SENT") {
      const id=url.searchParams.get("q").replace("rfc822msgid:","");
      const found=allowLookup && db.prepare("SELECT receipt FROM mail_test_mailbox WHERE rfc_id=?").get(id);
      return Response.json({messages:found ? [{id:found.receipt,threadId:thread}]:[]});
    }
    if(req==="drafts" && options.method==="GET") return Response.json({drafts:[]});
    if(req==="drafts" && options.method==="POST") { heldDraft=JSON.parse(options.body).message;return Response.json({id:"draft-001"}); }
    if(req==="drafts/draft-001") return Response.json({}, {status:404});
    if(req==="drafts/send"){
      calls++;
      const {id,message}=JSON.parse(options.body);
      assert.equal(id,"draft-001");assert.deepEqual(message,heldDraft);assert.equal(message.threadId,thread);
      const raw=Buffer.from(message.raw,"base64url"),parsed=await PostalMime.parse(raw);
      assert.equal(parsed.to[0].address,customer);assert.equal(parsed.from.address,fakeSender);assert.equal(parsed.inReplyTo,"<fp108-A@ridgeline.example>");
      db.prepare("INSERT INTO mail_test_mailbox VALUES(?,?,?,?,?)").run("gmail-fixture-01",parsed.messageId,customer,raw,new Date().toISOString());
      throw new Error("Synthetic lost response after provider acceptance");
    }
    throw new Error("Unexpected fixture request " + req);
  };
  if(stage==="import") {
    const baseline=listQuotes().length;
    const first=await importEmail(fixtures[0]);
    const duplicates=await Promise.all([importEmail(fixtures[0]),importEmail(fixtures[0])]);
    assert.ok(duplicates.every(x=>x.duplicate && x.quoteId===first.quoteId));
    const id=first.quoteId;
    assert.equal(listQuotes().length,baseline+1);
    assert.deepEqual(Buffer.from(db.prepare("SELECT raw FROM mail_messages WHERE id=?").get(first.messageId).raw),fixtures[0]);
    assert.match(getQuote(id).notes,/six indexing fixture plates/);
    assert.match(draftClarification(id),/material grade/);
    await finishConsent("fixture-code");assert.equal(gmailSettings().sender,fakeSender);
    assert.ok(!db.prepare("SELECT sealed_refresh FROM mail_account").get().sealed_refresh.includes("fixture-refresh"));
    await assert.rejects(importLabel(),/Select the quoting label/);
    await selectGmailLabel("Quoting");
    incoming=["request"];assert.deepEqual(await importLabel(),{imported:0,failed:0});assert.equal(getQuote(id).version,1);
    const initial=getDrawingState(id);assert.equal(initial.attachments.length,1);assert.equal(initial.attachments[0].revisions[0].label,"A");
    await assert.rejects(sendApproved(id,1,testRecipient,"test"),/approved version/);
    const estimated=getQuote(id);
    estimated.items[0].description="Indexing fixture plate";
    estimated.items[0].quantity=6;
    estimated.items[0].costRows=[{id:"material",label:"Fixture material",amount:1,rate:12,basis:"per_unit"}];
    updateQuote(id,estimated);
    let v=getQuoteReview(id);
    v=await changeWorkflow(id,{action:"submit",version:v.currentVersion,drawingId:initial.selectedRevisionId,details:{...v.snapshot.details,
      scope:"Fabricate six indexing fixture plates.",scopeConfirmed:true,leadTime:"Two weeks",leadTimeConfirmed:true,terms:"Net 30."}});
    const version=v.currentVersion;
    await changeWorkflow(id,{action:"approve",version,drawingId:initial.selectedRevisionId});
    const local=await Promise.allSettled([sendApproved(id,version,testRecipient,"test"),sendApproved(id,version,testRecipient,"test")]);
    assert.ok(local.some(v=>v.status==="fulfilled"));assert.equal(getWorkflowStatus(id,version),"approved");
    const sent=await sendApproved(id,version,testRecipient,"test");
    assert.equal(sent.receipt,db.prepare("SELECT receipt FROM mail_test_mailbox WHERE recipient=?").get(testRecipient).receipt);
    const parsed=await PostalMime.parse(Buffer.from(db.prepare("SELECT raw FROM mail_test_mailbox WHERE recipient=?").get(testRecipient).raw));
    assert.equal(parsed.from.address,testSender);assert.equal(parsed.to[0].address,testRecipient);
    assert.deepEqual(Buffer.from(parsed.attachments[0].content),getApprovedPackage(id,version).pdf);
    await assert.rejects(sendApproved(id,version,customer,"gmail"),/receipt unavailable/);
    assert.equal(calls,1);
    await assert.rejects(sendApproved(id,version,customer,"gmail"),/consumed the draft/);
    assert.equal(calls,1);
    incoming=["request","revision"];
    assert.deepEqual(await importLabel(),{imported:1,failed:0});
    assert.deepEqual(await importLabel(),{imported:0,failed:0});assert.equal(listQuotes().length,baseline+1);
    const state=getDrawingState(id);
    assert.equal(state.attachments.length,1);assert.deepEqual(state.attachments[0].revisions.map(r=>r.label),["B","A"]);
    assert.equal(state.selectedRevisionId,state.attachments[0].revisions[0].id);
    assert.equal(getQuote(id).version,version+1);
    assert.equal(getApprovedPackage(id,version).approval.drawing.id,initial.selectedRevisionId);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_messages WHERE quote_id=?").get(id).n,2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_files").get().n,2);
    console.log("Verified duplicate imports, drawing revisions, sender and thread linkage, local test PDF capture and uncertain send protection.");
  } else {
    const entry=db.prepare("SELECT quote_id,version FROM mail_outbox WHERE channel='gmail'").get();
    const result=await sendApproved(entry.quote_id,entry.version,customer,"gmail",true);
    assert.equal(result.receipt,"gmail-fixture-01");
    assert.equal((await sendApproved(entry.quote_id,entry.version,customer,"gmail")).receipt,result.receipt);
    assert.equal(calls,0);assert.equal(getWorkflowStatus(entry.quote_id,entry.version),"sent");
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_test_mailbox WHERE recipient=?").get(customer).n,1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_test_mailbox WHERE recipient=?").get(testRecipient).n,1);
    const raw=db.prepare("SELECT raw FROM mail_test_mailbox WHERE recipient=?").get(customer).raw;
    const email=await PostalMime.parse(Buffer.from(raw));
    assert.deepEqual(Buffer.from(email.attachments[0].content),getApprovedPackage(entry.quote_id,entry.version).pdf);
    assert.deepEqual(Buffer.from(db.prepare("SELECT raw FROM mail_messages WHERE provider_id='revision'").get().raw),fixtures[1]);
    const result2=await importEmail(Buffer.from("From: Pat <pat@fixture.example>\r\nSubject: Acceptance\r\nMessage-ID: <after-sent@fixture.example>\r\nIn-Reply-To: "+email.messageId+"\r\n\r\nThanks."));
    assert.equal(result2.quoteId,entry.quote_id);
    console.log("Verified receipt reconciliation after restart and revision, exactly one captured message per test recipient, approved PDF bytes and replies to the issued quote.");
  }
}

