# Little Mountain Metalworks Engineering Desk

Staff can quote a fabrication request or convert a dimensioned sketch into a reviewed flat-part drawing. Python calculates dimensions, machining allowances and prices. The model supplies structured readings and proposed labor adjustments. Nick approves the version issued to a customer.

## Run on the shop workstation

The configured machine has Python 3.12, WSL Ubuntu 24.04, Docker and the Node 24/pnpm 11 launcher. Start Docker and run these commands from the repository root in PowerShell.

```powershell
.\scripts\setup-engineering.ps1 -WslDistro Ubuntu-24.04
.\infra\setup.ps1 start
.\quote.cmd install --frozen-lockfile
.\quote.cmd build
.\quote.cmd start
```

On subsequent starts, open **Open Quote Desk.cmd**. Use `.\quote.cmd dev` for development. The [shop desk](http://127.0.0.1:3100), [service readiness](http://127.0.0.1:8140/health/ready) and [interactive API documentation](http://127.0.0.1:8140/docs) run locally. **Open practice quote.cmd** under `output/pdf` uses a separate SQLite workspace.

Windows installations that support the native CAD libraries can run `.\scripts\setup-engineering.ps1` with Python 3.12 available through the Python launcher, or pass `-Python` with its executable path. On Linux, create `.venv` with Python 3.12 and install `requirements-engineering.txt`. Configuration and renewal of the API, database and object-store credentials are covered in the [infrastructure guide](infra/README.md).

## Vercel Services configuration

Use the repository root as the Vercel project directory. The `web` service owns the application pages and the Next.js `/api/*` handlers. The `api` service builds FastAPI from the repository's Dockerfile so it can import the shared Python packages. It has no public rewrite. Next.js calls it at runtime through the Vercel-injected `NFIP_INTERNAL_API_URL`. Keep `NFIP_API_TOKEN` as a server-side secret shared by the two services and leave the binding variable to Vercel. The regular workstation launcher continues to use `NFIP_API_URL` or the private Compose settings.

Use `vercel dev --local` from the repository root to test the service routing without linking a Vercel project. Install the workspace dependencies first and run Docker on the same host as the CLI. The FastAPI image listens on port 8140. A hosted Vercel container environment would need `PORT=8140` to match it.

Vercel production and preview deployments serve a read-only example quote and the quick guide. The same deployment keeps live quote, upload, and settings routes closed while the hosted desk lacks storage. The local workstation and `vercel dev --local` continue to use SQLite and Compose. A writable hosted desk needs persistent quote storage, a reachable PostgreSQL, Redis and S3-compatible object store, and a running Celery worker. See [Vercel Services](https://vercel.com/docs/services), [service bindings](https://vercel.com/docs/services/bindings), and [function filesystem support](https://vercel.com/docs/functions/runtimes#file-system-support).

## Review a drawing and price

Open a saved quote and choose **Drawing & quote workspace**. Select a numbered reading to see its source. **Edit drawing measurements** opens the revision for changes. A valid measurement rebuilds the review PDF and audited DXF in memory. Save the drawing revision and confirm its checks to issue shop files. On older blueprints, **Align outline to page** registers a flat view by its lower-left, lower-right and upper-left corners.

Enter Nick’s hours or a direct cost beside the original proposal. Row labels show whether the amount is for a piece or a batch. Include stock rows in the scrap buffer as needed. **Save pricing revision** stores the amounts, reasons and margin together. **Review scope and approve** issues the customer PDF for that revision. **Download Internal Shop Traveler & CSV** downloads a ZIP for the selected revision.

Under **Shop settings → Nick’s Rules**, expand **Supporting jobs** to inspect the original and approved figures before approving or dismissing a suggestion. The local Celery worker compares finalized quote revisions using saved evidence. It needs the engineering stack running and uses no model API credits.

## Engineering workflows

| In the app | What is recorded |
| --- | --- |
| **Blueprint estimates** → **Read drawing and estimate** | The PDF or DXF revision, original model response, page or entity evidence, review decisions, cost calculations, comparable approvals and applied rules. **Open editable quote draft** carries the result into the existing approval workflow. |
| **Sketch to drawing** → **Upload & read sketch** → **Confirm and make files** | The original photo, located measurements, confirmed flat geometry and the exact MinIO versions of the shop PDF, cut list and per-part DXFs. |
| **Shop settings** → **Engineering rate catalog** | Supplier prices by material, unit and date, and work-center rates with setup time, efficiency and included work. |
| **Price the work** → **Calculate sheet stock and work-center time** | Whole-sheet purchases, blank count, sheet yield, one setup per work center, run hours, rate sources and entered adjustments. Estimates use measured or shop-supplied throughput. |
| **Quote review** → approval | The exact customer prices, public PDF and internal cost sheet. Background transfer stores the approved lines and original drawing version. |
| **Shop settings** → **Engineering records** | The count of archived versions, pending transfers and the last transfer error. Transfers retry automatically when services return. |

Supplier stock can be priced per sheet or by sheet volume × catalog density × supplier price per pound. The calculator uses rectangular blank yield, physical sheet dimensions and an explicit edge margin and spacing. Purchased whole sheets include the unused stock. Each operation records both its setup and production allowance. Editing quantity after applying a batch routing requires recalculation before approval.

## Repository

| Path | Responsibility |
| --- | --- |
| [apps/web](apps/web) | Next.js 15 App Router, TypeScript, Tailwind, the Fabric.js inspector and the SVG drawing and quote review workspace. |
| [apps/api](apps/api) | Authenticated FastAPI, Pydantic, async SQLAlchemy, versioned storage and Celery. |
| [packages/cad](packages/cad/README.md) | Pydantic part AST, Shapely geometry checks, audited ezdxf writer, ANSI B shop sheets, BOM, stock planning and an OpenCV image-preparation utility. |
| [packages/costing](packages/costing) | Decimal pricing, inch/metric measurements, machine allowances, shop routing, row minimums and allocation of public prices to cents. |
| [packages/ai](packages/ai) | Validates drawing readings, finds comparable quotes and proposes shop rules from repeated, documented pricing decisions. |
| [infra](infra/README.md) | Compose services, migrations at startup, private network and service credentials. |

PostgreSQL stores the Phase 1 engineering records, generation jobs and searchable fingerprints of approved lines. Each approval freezes its pricing inputs, original evidence, reported confidence and operator adjustments. SQLite supports workstation editing and transfer retries. The existing Supabase connection serves completed-job history. The [build status](BUILD_STATUS.md) tracks milestone verification.

## Make a shop drawing from a phone photo

1. Open **Sketch to drawing**, choose or take a photo, then select **Upload & read sketch**. Include the units, stock, piece count, outside sizes and hole or bend locations. For a trial, use the [slotted mounting plate](fixtures/sketches/slotted-mounting-plate.png).
2. Check the readings beside the photo. A numbered pin takes you to a missing measurement, conflicting callout or uncertain reading. Enter the confirmed value and a short review note. **Save and check** saves progress.
3. Select **Confirm and make files**. Download a full-size DXF for each distinct part, the annotated shop PDF and the CSV cut list. **Create or open quote** uses that released revision to fill a draft. Earlier releases are available under **Saved revisions**.

The shop service accepts single-frame JPG, PNG, WebP and HEIC/HEIF photos up to 20 MiB and 40 megapixels. The DXF carries nominal cut geometry in the drawing units and bend marks on the scribe layer. Set the tool, kerf and cutting sequence in CAM. [Sketch API contract](infra/README.md#phone-sketch-conversion)

## Make a blueprint estimate

1. Open **Blueprint estimates** and select a PDF or native DXF. Customer, job name and notes are optional. Try the [two-part drawing](packages/ai/examples/fixture-plate-set.pdf) or the [drawing with missing specifications](packages/ai/examples/fixture-plate-set-missing.pdf).
2. Select **Read drawing and estimate**. If a reading is uncertain, compare it with the displayed PDF or original DXF. Fill the missing values, record what was checked and choose **Save review and calculate price**.
3. Expand the charges to inspect stock, time, rates and supporting records. Select **Open editable quote draft** to adjust the quote and submit the version for approval. The source estimate remains available from the draft and staff review.

The starter rate card prices quarter-inch A36 plate with illustrative shop settings. Use **Stock, rates and shop settings** to enter stock sizes, kerf, throughput, K-factors and weld schedules. Add a finish or outside charge against the exact requirement. A subsequent job can reuse an earlier rate card. A non-demo card picks up the latest effective supplier and work-center rows matching its stock code, supplier and work-center name. Nick's approved pricing rules live under **Shop settings → Blueprint estimating rules**. [Calculation methods and limits](packages/cad/COSTING.md)

## Verify

Run browser checks against an isolated workspace after building the web app.

```powershell
.\quote.cmd typecheck
.\quote.cmd exec node scripts/verify-drafts.mjs
.\quote.cmd exec node scripts/verify-sketch-cad.mjs
.\quote.cmd exec node scripts/verify-sketch-flow.mjs
.\quote.cmd exec node scripts/verify-quote-desk.mjs
.\quote.cmd exec node scripts/verify-history.mjs
```

For storage and service integration, create the separate test deployment before running the checks.

```powershell
.\infra\setup.ps1 start -TestStack
.\infra\setup.ps1 verify -TestStack
.\quote.cmd exec node scripts/verify-engineering-archive.mjs
.\quote.cmd exec node scripts/verify-engineering-catalog.mjs
.\quote.cmd exec node scripts/verify-engineering-artifacts.mjs --service
```

For Phase 2, run the live PDF/DXF test on synthetic drawings, followed by the browser and draft checks. The first and second commands use the configured vision provider.

```powershell
wsl -d Ubuntu-24.04 -- docker exec lmm-engineering-test-api-1 python -m tests.blueprint_flow
.\quote.cmd exec node scripts/verify-blueprint-workspace.mjs
.\quote.cmd exec node scripts/verify-blueprint-draft.mjs
```

The [CAD compiler guide](packages/cad/README.md) includes the standalone compile command, requirements, independent geometry tests and exact supported profiles. For a hands-on test, use the [dimensioned slotted bracket AST](packages/cad/examples/slotted-bracket.json) or the [phone-sketch fixture](fixtures/sketches/slotted-mounting-plate.png). Nick’s CAM package and postprocessor are still needed to verify machine-specific import behavior.
