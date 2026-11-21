import { QuoteError } from "./quotes";
import { EngineeringInputError, runPricing } from "./python-engine";

export function actualCosts(rows: unknown) {
  if (!Array.isArray(rows) || rows.length > 500 || rows.some(pair => !Array.isArray(pair) || pair.length !== 2 ||
    pair.some(n => n !== null && (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1_000_000_000)))) {
    throw new QuoteError("Check the quantities and rates for the job entries.");
  }
  try {
    return runPricing<{ rows: (number | null)[]; total: number }>({ operation: "actuals", rows });
  } catch (error) {
    if (error instanceof EngineeringInputError) throw new QuoteError(error.message, 422);
    throw error;
  }
}
