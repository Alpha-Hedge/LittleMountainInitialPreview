import { engineeringConnection } from "./engineering-connection";
import { shopDate } from "./estimating";
import { QuoteError } from "./quotes";

export type CatalogKind = "work-centers" | "materials";
export interface CenterRate { id:string; name:string; hourly_rate:string; default_setup_minutes:string; efficiency_factor:string; effective_on:string; includes:string }
export interface MaterialRate { id:string; spec_code:string; category:string; supplier:string; density_lb_per_in3:string; cost_per_lb:string; default_scrap_pct:string; k_factor:string|null; effective_on:string; includes:string }
export interface EngineeringCatalog { work_centers:CenterRate[]; materials:MaterialRate[]; as_of:string }

export async function catalogRequest(kind?: CatalogKind, entry?: object): Promise<EngineeringCatalog> {
  const config = engineeringConnection();
  if (!config) throw new QuoteError("The engineering catalog is available on the connected shop desk.", 503);
  let response: Response;
  try {
    const resource = kind ? "/" + kind : "?as_of=" + shopDate();
    response = await fetch(config.origin + "/v1/catalog" + resource, {
      method:kind ? "POST" : "GET", headers:{Authorization:"Bearer " + config.token,"Content-Type":"application/json"},
      body:kind ? JSON.stringify(entry) : undefined, redirect:"error", cache:"no-store", signal:AbortSignal.timeout(5000),
    });
  } catch { throw new QuoteError("The engineering catalog is offline.", 503); }
  if (!response.ok) {
    if (response.status === 409) throw new QuoteError("A rate with that name and effective date already exists. Choose the effective date for the new revision.", 409);
    if (response.status === 422) throw new QuoteError("Check the required fields, units and decimal precision for this rate.",422);
    throw new QuoteError("The engineering service could not open this catalog.",503);
  }
  if (kind) {
    try {
      return await catalogRequest();
    } catch {
      throw new QuoteError("The dated rate was saved. Reopen the catalog to refresh the rate list.", 503);
    }
  }
  return response.json();
}
