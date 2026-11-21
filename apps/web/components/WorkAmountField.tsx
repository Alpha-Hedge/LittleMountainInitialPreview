"use client";
import { useState } from "react";
import type { CostBasis } from "@/lib/types";
import {Field, DecimalField} from "./EstimatingFields";
export function usesHours(unit:string) {
  return ["h","hr","hrs","hour","hours"].includes(unit.trim().toLowerCase());
}

export function WorkAmountField({unit,basis,value,onChange}:{unit:string;basis:CostBasis;value:number;onChange:(value:number)=>void}) {
  const [typed,setTyped]=useState<string|null>(null);
  const suffix=basis==="batch"?"for the whole batch":"for each piece";
  if(!usesHours(unit)) return <DecimalField label={`Amount ${suffix} (${unit})`} value={value} onChange={onChange}/>;
  const minutes=Number.isFinite(value)?String(Number((value*60).toFixed(2))):"";
  return <Field label={`Minutes ${suffix}`}><input min="0" type="number" inputMode="decimal" step="any" required
    value={typed??minutes} onFocus={()=>setTyped(minutes)} onBlur={()=>setTyped(null)}
    onChange={event=>{setTyped(event.target.value);onChange(Number((event.target.valueAsNumber/60).toFixed(4)));}}/></Field>;
}

