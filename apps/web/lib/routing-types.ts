export type RoutingStock = {
  materialId?: string; thicknessMm?: number;
  width: number; height: number; blankWidth: number; blankHeight: number;
  margin: number; gap: number; sheetCost: number; allowRotation: boolean;
};
export const routingUnits = ["mm cut", "bend", "mm weld", "piece"] as const;
export type RoutingOperation = {
  centerId?: string;
  overrideReason?: string;
  name: string; unit: (typeof routingUnits)[number]; unitsPerPiece: number;
  unitsPerHour: number; setupMinutes: number; hourlyRate: number;
};
export type RoutingResult = {
  sheetCount: number; piecesPerSheet: number; yieldPercent: number; materialCost: number; total: number;
  operationHours: { name: string; setupHours: number; runHours: number; totalHours: number }[];
};
export type FrozenRouting = {
  stockSource?: { material:{ spec_code:string;supplier:string;effective_on:string;density_lb_per_in3:string;cost_per_lb:string }; weightLb:number; cost:number } | null;
  centerSources?: ({name:string;effective_on:string;hourly_rate:string;includes:string;efficiency_factor:string} | null)[];
  stock: RoutingStock; operations: RoutingOperation[]; result: RoutingResult;
  quantity: number; quoteVersion: number; rowIds: string[];
};
