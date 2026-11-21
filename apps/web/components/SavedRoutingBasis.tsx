import type { LineItem } from "@/lib/types";
import type { FrozenRouting } from "@/lib/routing-types";
import { savedRouting } from "@/lib/work-center-routing";
import { formatRate, formatUSD } from "./EstimatingFields";

export function SavedRoutingBasis({ quoteId, item, version }: { quoteId: string; item: LineItem; version: number }) {
  const saved: FrozenRouting | null = savedRouting(quoteId, item.id, version);
  if (!saved) return null;
  const { stock, result } = saved;
  const retained = saved.rowIds.filter(id => item.costRows.some(row => row.id === id)).length;
  return <details className="est-disclose routing-basis">
    <summary>Stock and work-center inputs · version {saved.quoteVersion}</summary>
    <p>Recorded for {saved.quantity} pieces. {retained} of {saved.rowIds.length} original cost rows are present in this version.</p>
    <dl className="est-specs">
      <div><dt>Purchased stock</dt><dd>{stock.width} × {stock.height} mm · {formatUSD(stock.sheetCost)} per sheet</dd></div>
      <div><dt>Rectangular blank</dt><dd>{stock.blankWidth} × {stock.blankHeight} mm · {stock.margin} mm edge margin · {stock.gap} mm clear gap · {stock.allowRotation ? "90° rotation allowed" : "fixed orientation"}</dd></div>
      <div><dt>Material allowance</dt><dd>{result.sheetCount} sheets at {result.piecesPerSheet} pieces per full sheet · {formatUSD(result.materialCost)}</dd></div>
      {saved.stockSource && <div><dt>Supplier price used</dt><dd>{saved.stockSource.material.spec_code} · {saved.stockSource.material.supplier} · {saved.stockSource.material.effective_on}
        {" · "}{saved.stockSource.weightLb.toLocaleString("en-US",{maximumFractionDigits:4})} lb per sheet at {formatRate(Number(saved.stockSource.material.cost_per_lb))}/lb</dd></div>}
      {saved.centerSources?.map((c,i)=>c && <div key={i}><dt>Work-center rate source</dt><dd>{c.name} · {c.effective_on} · {formatRate(Number(c.hourly_rate))}/h · efficiency {Number(c.efficiency_factor)} · {c.includes}
        {saved.operations[i]?.overrideReason && " · Adjustment: " + saved.operations[i].overrideReason}</dd></div>)}
      {saved.operations.map((op, i) => <div key={i}><dt>{op.name}</dt><dd>{op.setupMinutes} min setup · {op.unitsPerPiece} {op.unit} per piece · {op.unitsPerHour} {op.unit} per hour · {formatRate(op.hourlyRate)} per hour</dd></div>)}
      <div><dt>Original batch estimate</dt><dd>{formatUSD(result.total)}</dd></div>
    </dl>
  </details>;
}
