"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { AssistantKind, AssistantReply, AssistantTurn } from "@/lib/review-assistant-types";
import { Icon } from "./Icons";
import Activity from "./Activity";
import AssistantMessage from "./AssistantMessage";
import "./review-assistant.css";

const money = (value: number) => value.toLocaleString("en-US",{style:"currency",currency:"USD"});

const presets: Record<AssistantKind,[string,string][]> = {
  quote: [
    ["Plan the work", "Review this scope and prepare the work and costs you can support with current shop rates and established allowances. Ask me only for the remaining facts."],
    ["What’s missing?", "What must I confirm or price before this quote is ready? Explain the highest-priority details in plain shop language."],
  ],
  blueprint: [
    ["Check the drawing", "Compare this page with the current reading. Suggest missing parts, holes, slots, bends, welds, profile corners and shop requirements where the written evidence establishes them. Ask about the rest."],
    ["What’s missing?", "What are the next facts I need to confirm on this drawing? Put the most important one first."],
  ],
  sketch: [
    ["Check the sketch", "Read the sketch again and propose missing measurements and openings that are supported by a written callout and a clear feature. Ask where you need a measurement."],
    ["What’s missing?", "Explain the most important issue preventing this sketch from becoming a shop drawing."],
  ],
};

export default function ReviewAssistant<T extends object>({kind,id,version,draft,sourceRevision,locked=false,onApply}: {
  kind:AssistantKind; id:string; version:number; draft:T; locked?:boolean;
  sourceRevision?:string|null;
  onApply:(next:T,instruction:string,paths:string[])=>void;
}) {
  const label=useId();
  const [input,setInput]=useState(""), [turns,setTurns]=useState<AssistantTurn[]>([]),
    [working,setWorking]=useState(false), [recording,setRecording]=useState(false),
    [listening,setListening]=useState(false), [error,setError]=useState(""),
    [inspect,setInspect]=useState(kind!=="quote"||!!sourceRevision), [notice,setNotice]=useState("");
  const [openQuestions,setOpenQuestions]=useState<string[]>([]);
  const [proposed,setProposed]=useState<{reply:AssistantReply<T>;snapshot:string;instruction:string}|null>(null);
  const conversation=useRef<HTMLDivElement>(null);
  useEffect(()=>{const el=conversation.current;if(el)el.scrollTop=el.scrollHeight;},[turns,working]);
  const current=JSON.stringify({version,draft,sourceRevision});
  const request=useRef<AbortController|null>(null);
  const voice=useRef<{recorder:MediaRecorder;stream:MediaStream;timer:number}|null>(null);
  const mounted=useRef(true);
  useEffect(()=>{
    mounted.current=true;
    return ()=>{
      mounted.current=false;
      request.current?.abort();
      const active=voice.current;
      if (active) {
        active.recorder.onstop=null;
        if(active.recorder.state==="recording") active.recorder.stop();
        active.stream.getTracks().forEach(track=>track.stop());
        window.clearTimeout(active.timer);
      }
    };
  },[]);

  async function ask(message:string, seeDrawing=inspect, planCosts=false, display=message) {
    const instruction=message.trim();
    if(!instruction || working || recording || listening)return;
    const controller=new AbortController();
    request.current?.abort();
    request.current=controller;
    setError("");setNotice("");setWorking(true);setProposed(null);setOpenQuestions([]);
    const snapshot=current;
    const typed = message === input;
    if (typed) setInput("");
    const page=Number(instruction.match(/\bpage\s+(\d{1,2})\b/i)?.[1] || "1");
    setTurns(history=>[...history,{role:"operator",text:display}] as AssistantTurn[]);
    try{
      const response=await fetch("/api/assistant",{
        method:"POST",headers:{"Content-Type":"application/json"},signal:controller.signal,
        body:JSON.stringify({kind,id,version,draft,instruction,turns:turns.slice(-12),inspect:seeDrawing,page,planCosts}),
      });
      const reply=await response.json() as AssistantReply<T> & {error?:string};
      if(!response.ok)throw Error(reply.error || "Try the request again.");
      setTurns(history=>[...history,{role:"assistant",text:reply.answer}] as AssistantTurn[]);
      if(reply.draft)setProposed({reply,snapshot,instruction});
      else setOpenQuestions(reply.checks);
    }catch(problem){
      if(!controller.signal.aborted) {
        setError(problem instanceof Error?problem.message:"The assistant could not respond.");
        if (typed) setInput(value=>value || message);
      }
    }finally{if(!controller.signal.aborted)setWorking(false);}
  }

  function stopVoice() {
    if (voice.current?.recorder.state==="recording") voice.current.recorder.stop();
  }

  async function startVoice(){
    if(recording){stopVoice();return;}
    if(!navigator.mediaDevices?.getUserMedia || !("MediaRecorder" in window)){
      setError("Microphone access needs a supported browser on the local desk or HTTPS. You can type here.");return;
    }
    let stream:MediaStream | undefined;
    setError("");setListening(true);
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:true});
      if(!mounted.current){stream.getTracks().forEach(track=>track.stop());return;}
      const type=["audio/webm;codecs=opus","audio/mp4","audio/ogg;codecs=opus"].find(t=>MediaRecorder.isTypeSupported(t));
      if(!type)throw Error("This browser cannot record voice for the desk. You can type here.");
      const recorder=new MediaRecorder(stream,{mimeType:type});
      const audio:Blob[]=[];
      recorder.ondataavailable=e=>{if(e.data.size)audio.push(e.data);};
      recorder.onstop=async()=>{
        stream?.getTracks().forEach(track=>track.stop());
        if(voice.current)window.clearTimeout(voice.current.timer);
        voice.current=null;
        setRecording(false);setListening(true);
        try{
          const clip=new Blob(audio,{type:recorder.mimeType.split(";")[0]});
          const response=await fetch("/api/assistant/transcribe",{method:"POST",headers:{"Content-Type":clip.type},body:clip});
          const result=await response.json();
          if(!response.ok)throw Error(result.error || "Could not transcribe the recording.");
          if(mounted.current)setInput(value=>[value,result.text].filter(Boolean).join(" ").slice(0,2000));
        }catch(problem){if(mounted.current)setError(problem instanceof Error?problem.message:"Voice could not be transcribed.");}
        finally{if(mounted.current)setListening(false);}
      };
      recorder.start();
      voice.current={recorder,stream,timer:window.setTimeout(stopVoice,45000)};
      setRecording(true);setListening(false);
    }catch(problem){
      stream?.getTracks().forEach(track=>track.stop());setListening(false);
      setError(problem instanceof Error && problem.name!=="NotAllowedError"?problem.message:"Allow microphone access or type your instruction here.");
    }
  }

  return <details className="shop-assistant" id={kind === "quote" ? "quote-assistant" : undefined}>
    <summary><span className="assistant-mark"><Icon name="chat" size={19}/></span><span>Ask AI</span><small className="chat-hint">{kind==="quote" ? "Ask about a cost" : "Ask about the drawing"}</small><Icon name="down" size={15}/></summary>
    <div className="shop-assistant-body">
      <div className="chat-scroll" ref={conversation} role="log" aria-label="Assistant conversation" aria-live="polite" aria-relevant="additions">
        {turns.map((turn,i)=><div key={i} className={"chat-message " + turn.role}>
          <span className="chat-speaker">{turn.role==="operator"?"You":"Shop assistant"}</span>
          {turn.role==="assistant"?<AssistantMessage text={turn.text}/>:<p>{turn.text}</p>}
        </div>)}
        {working&&<span className="chat-thinking" role="status"><i aria-hidden="true"/><i aria-hidden="true"/><i aria-hidden="true"/><span>{inspect?"Reviewing the source":"Reviewing the job"}</span></span>}
      </div>
      {error&&<p className="chat-error" role="alert">{error}</p>}
      <div className="chat-starters">{presets[kind].map(([title,message])=><button key={title} type="button"
        disabled={working||recording||listening} onClick={()=>void ask(message,inspect,kind==="quote" && title==="Plan the work",title)}>{title}<Icon name="arrow" size={13}/></button>)}</div>
      {notice&&<p role="status"><Activity done>{notice}</Activity></p>}
      {!!openQuestions.length&&<div><strong>{kind==="quote"?"Still needed for pricing":"Open drawing questions"}</strong><ul>
        {openQuestions.map(question=><li key={question}>{question}</li>)}
      </ul></div>}
      {proposed&&<section className="shop-assistant-proposal" aria-label="Suggested changes">
        <h3>Suggested changes</h3>
        <ul className="change-list">{proposed.reply.changes.map((change,i)=><li key={i}><strong>{change.label}</strong>
          <div className="change-values"><span><small>Current</small>{change.before || "Not set"}</span><span><small>Proposed</small>{change.after || "Remove"}</span></div>
          {change.evidence&&<details><summary>Why this change?</summary><p>{change.evidence}</p></details>}</li>)}</ul>
        {typeof proposed.reply.sellingPrice==="number"&&<p>{proposed.reply.checkedBy ? "Budget price with these costs" : "Suggested price before tax"} <strong>{money(proposed.reply.sellingPrice)}</strong></p>}
        {!!proposed.reply.checks.length&&<><strong>{proposed.reply.checkedBy ? "Still needed for pricing" : "Still needs review"}</strong><ul>{proposed.reply.checks.map((issue,i)=><li key={i}>{issue}</li>)}</ul></>}
        {proposed.snapshot!==current&&<p role="status">The draft changed. Ask again to get a current suggestion.</p>}
        {locked&&<p>Open a revision to apply changes.</p>}
        <div className="shop-assistant-actions">
          <button type="button" className="shop-assistant-primary" disabled={locked||proposed.snapshot!==current}
            onClick={()=>{
              if(locked||proposed.snapshot!==current||!proposed.reply.draft)return;
              onApply(proposed.reply.draft,proposed.instruction,proposed.reply.changedPaths);
              if (proposed.reply.checkedBy) setOpenQuestions(proposed.reply.checks);
              setProposed(null);
              setNotice("Changes applied to this draft. Save to keep them.");
            }}>Apply suggested changes</button>
          <button type="button" onClick={()=>setProposed(null)}>Dismiss</button>
        </div>
      </section>}
      <div className="chat-composer">
        <textarea id={label} rows={2} value={input} maxLength={2000} aria-label="Your instruction" onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>{if(e.key==="Enter" && !e.shiftKey && !e.nativeEvent.isComposing){e.preventDefault();void ask(input);}}}
          placeholder={kind==="quote"?"Ask about a cost or describe a change…":kind==="sketch"?"Ask about a measurement or describe a change…":"Ask about a part or describe a change…"}/>
        <div className="chat-tools"><label className="shop-assistant-source"><input type="checkbox" checked={inspect} onChange={e=>setInspect(e.target.checked)}/>Look at the {kind==="sketch"?"photo":"drawing"}</label>
          <button type="button" className="chat-icon" title={recording?"Stop recording":"Use microphone"} aria-label={recording?"Stop recording":"Use microphone"}
            aria-pressed={recording} disabled={working||listening} onClick={()=>void startVoice()}><Icon name={recording?"stop":"mic"} size={17}/></button>
          <button type="button" className="chat-send" aria-label="Send" title="Send" disabled={!input.trim()||working||recording||listening} onClick={()=>void ask(input)}><Icon name="send" size={18}/></button>
        </div>
      </div>
      {recording&&<p role="status"><Activity>Recording · tap stop when finished</Activity></p>}
      {listening&&<p role="status"><Activity>Preparing voice input</Activity></p>}
    </div>
  </details>;
}
