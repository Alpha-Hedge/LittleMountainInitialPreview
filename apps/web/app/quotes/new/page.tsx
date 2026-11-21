import QuoteEditor from "@/components/QuoteEditor";
import { engineeringConnection } from "@/lib/engineering-connection";
import { getEstimatingSettings } from "@/lib/estimating";

export const dynamic = "force-dynamic";

export default function NewQuote() {
  return <QuoteEditor initialQuote={null} defaultMargin={getEstimatingSettings().defaultMargin} detailedReader={!!engineeringConnection()} />;
}
