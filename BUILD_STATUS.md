# Little Mountain Metalworks

Fabrication quoting and shop drawings for Nick. The Next.js and TypeScript app connects customer requests and drawings to estimates, approvals, customer PDFs and completed-job actuals. Supabase Postgres stores the shop’s learning history. SQLite holds the local editing workspace, immutable sketch releases and pending uploads. The Phase 1 engineering services archive approved versions in PostgreSQL 16 with pgvector and selected source files in versioned MinIO storage.

## Run locally

On this Windows workstation, double-click **Open Quote Desk.cmd**. It opens the desk in the default browser. The shop and practice desks use OpenAI GPT-6.1 Terra for drawing review and estimates based on past jobs. From **Quick guide**, staff can look up how to make a quote, add drawings, get the customer PDF or record finished work.

On a new workstation, set up the Python 3.12 engineering runtime and the Compose stack first. On this machine use `.\scripts\setup-engineering.ps1 -WslDistro Ubuntu-24.04` and `.\infra\setup.ps1 start`. The [engineering setup and verification guide](README.md) covers native Python, service checks, and test isolation.

For development, install dependencies and start the app from PowerShell in this folder.

```powershell
.\quote.cmd install --frozen-lockfile
.\quote.cmd dev
```

Leave that terminal open and open [the app](http://127.0.0.1:3100). For production run `.\quote.cmd build`, then `.\quote.cmd start`. The launcher finds Node.js 24 and pnpm 11. Manual quoting works independently of the drawing reader.

## Completed milestones

### Vercel Services repository configuration · November 21, 2026

The repository has a `web` service for the site and its `/api/*` handlers, and an internal `api` service built from the engineering Dockerfile. The web server uses the Vercel-injected `NFIP_INTERNAL_API_URL` at runtime when available. The workstation keeps its existing Compose URL and server-side bearer credential. The repository configuration is documented in [README.md](README.md).

The configuration passed the published Vercel schema checks and the web app passed TypeScript checking. A local Next.js smoke test used an HTTP stand-in to verify that blueprint and sketch requests follow the injected binding and preserve server authorization. The full `vercel dev --local` run detected both services, then stopped on a Windows symlink permission error. The Linux retry stopped when WSL stopped responding. Hosted quote storage and worker services are outside this configuration milestone.

### Full-width workspace layout and controls · November 21, 2026

The app now fills the browser window with an aligned header and navigation rail. The Quote Desk presents the latest draft and its estimated price alongside the sketch and drawing-review shortcuts. Shared card padding, row alignment, borders, selected tabs, and updated SVG icons carry through quote intake, sketch review, and shop settings.

Verified the production build and the eight main screens at 1440, 768, 390, and 320 pixels in Chrome. Checks covered the full-width layout, dashboard alignment, drawing shortcuts, mobile navigation, and an existing illustrated drawing. The quote-desk regression also passed draft creation and reopening, search, status filtering, and routing revision checks.

### Workspace visual refresh · November 21, 2026

The local desk uses a pale blue workspace, a white labeled navigation rail, and a shared style for cards, forms, actions, and selected tabs. The home page keeps Start a quote and the latest draft up front, adds direct links to both drawing workflows, and groups saved quotes with their search and status filters. The same styles carry through the editors, measurement review, Ask AI, email, finished jobs, settings, and the guide.

Verified the production build and exercised the eight main screens in Chrome on desktop and at 390 px and 320 px. The browser checks covered quote creation and reopening, search and status filters, routing and saved rates, mobile navigation, and drawing intake controls.

### Coordinated sketch review sheets · November 21, 2026

The illustrated drawing keeps the isometric view, mounting detail, notes, and title block together. Supported parallel flat-bar assemblies now show aligned top and side views drawn in proportion to the written stock sizes. The front and edge views share a scale. Anchor-hole spacing and offsets appear on the front view, and preliminary lengths and thicknesses are labeled. Where the sketch leaves spacing, rod locations, or connections open, the review sheet keeps those details visible for confirmation. Older sheets can use **Update drawing** to reuse the saved illustration.

Verified both download formats and reopening in the browser with Nick’s mounting-bracket sketch. The check confirmed the original illustration was reused, the saved revision and file-release state stayed intact, and the revised sheet shows the 32-inch reference length, hole spacing, and ¾-inch top offset. The CAD suite passed 76 tests with one platform-specific skip. The separate browser regression passed live photo reading, correction, release, and linking to a quote.

### Automatic full drawing budgets · November 21, 2026

Opening a draft from a PDF blueprint that needs review now starts the full takeoff. Older drafts with only quick automatic allowances also upgrade on open. The quote displays its pending or retry status during the takeoff. An independent AI pass checks the source for missing work, overlapping costs and inconsistent quantities before the pricing engine saves a new draft version.

Whole-job estimating covers applicable stock, shop operations and site work. Explicit exclusions and shop-only scope still apply. The budget marks quantities as explicit, derived or assumed and keeps unknowns on the review list. The installed and shop-only options use the same stock and fabrication amounts, dated rates and quote margin.

Verified the real A6.7 draft in Chrome from the normal Open quote draft action, including reopening during the background review. The isolated draft saved 54 priced rows. Rebuilt the shop desk’s QT-0013 as version 2 at $37,999.75 installed and $26,562.61 shop-only. Its 59 cost rows reconcile to the rate book, contingency and gross margin. Version 1 retains the $240.05 allowance. The new budget is an editable draft pending confirmation of its assumed quantities, labor and supplier costs.

### Drawing takeoff budgets · November 21, 2026

Draft quotes with a saved drawing can build a shop-only or installed budget. The reader proposes batch quantities and work assumptions with drawing page references. The estimator calculates stock weight, applies trim and effective rates, and shows the direct cost, contingency and selling price before saving. The preview keeps staff-entered rows and replaces eligible automatic allowances only when staff save a new version. Quantity confirmations stay open. Customer review requires a scope and price-basis confirmation, including any parts covered by shared costs.

Shop settings now includes a separate takeoff contingency default. Practice starts at 15% and the shop book starts at 0%. The benchmark CSV already had rates for the compared quote’s stock, labor, hardware and site work. The price difference was driven by scope, material quantities and work hours.

Verified live on A6.7 in the isolated desk. The shop-only run priced 35 rows at $14,114.36 and the installed run priced 41 rows at $24,303.76. Both saved and reopened in Chrome. The runs used independently inferred quantities and are preliminary budgets. The external estimate’s quantities still reproduce $30,949.91 shop-only and $44,078.31 installed on the same rate book. The original $238.13 draft stays available. Pricing, material weight, contingency allocation, previous approval exports and the quote-desk regression suite passed.

### Separate shop and U.S. practice rate books · November 21, 2026

Shop settings offers two independently saved profiles. **My shop rates** is where Nick enters actual costs and job types. **U.S. practice rates** starts with 137 editable entries and 14 templates, including 51 combinations of material grade and stock form. The practice prices use published U.S. wage and supplier references alongside labeled assumptions for overhead, equipment, finish, field work and freight.

Rates record the unit, scope, source, effective date and minimum charge. Hourly rates can combine wages, employer costs, overhead and equipment. Stock can record grade, form, density and nominal thickness. Drawing budgets use the selected book’s dated material prices and designated operation rates, with configurable setup or run allowances. Blank or ambiguous matches remain pricing questions. Nick can set a starting margin and stock trim allowance for each profile.

Templates, drawing budgets and Ask AI read the active profile. Approved quotes keep their saved rates and exports. The detailed engineering calculation still has a separate rate card for machine speeds, stock dimensions and weld schedules. The practice costs need replacement or confirmation against Nick’s supplier quotes, effective shop costs and actual production times before customer use.

Verified on the local desk and isolated Chrome runs. Tests covered searching 316L and powder coating, entering and activating a shop rate, switching back to practice, scheduled rate changes, a real-rate drawing budget with an unpriced operation, a live AI work-plan proposal using the dated rate book, and unchanged customer PDF and staff CSV exports from an earlier approval.

### Sketch saves and guided quote setup · November 20, 2026

Both sketch save buttons submit the edited reading. An ordinary measurement change can be saved without writing a separate note. The new revision reports the remaining checks or opens its released files. A rejected save keeps the edits and displays the reason beside the bottom buttons. Confirming engineering requires a reviewer or an approved reference. An unanswered clarification stays open.

Quote setup now walks through shop scope, quantities and specifications, and work priced in the draft. Each step displays one relevant part or extra at a time. The source review shows one uncertain reading at a time, with a separate path for source checks and detailed calculation. Nick can include undecided extras together. A quantity he verifies carries into the budget even if a different aspect of the part still needs review.

Printed-callout recovery recognizes dimensioned rectangular tube descriptions and wall thickness. Customer order notes can name a uniquely identified part directly, such as “Please quote 8 upper rails.” New PDF readings use these checks during extraction. Earlier editable PDF readings have a **Fill from printed callouts** action. Grade, finish and order counts without supporting evidence remain open.

Verified against the saved A6.7 awning reading and original PDF, with Chrome checks at desktop and phone widths. The isolated sketch release test used live vision, saved partial measurements from both ends of the page, released the corrected shop files and reopened the linked quote after restart. The draft regression covers scope inclusion, provisional and staff-confirmed quantities, benchmark costs and archived approvals. Nick’s job-specific scope, customer quantities and commercial rates still need his input where the source is silent.

### Guided review, assistant chat and progress feedback · November 20, 2026

Sketch measurement review displays one question at a time with the part, source note or reading when available, and the action to take. Staff can jump between checks and marked locations on the photo, skip an unknown, and return to an answer before saving. The quote editor offers search, quantity and missing-cost filters, and six parts per page. Repeated pricing questions are grouped with links to the affected parts. The detailed pricing workspace opens the operations for one part at a time.

Ask AI supports keyboard and voice input, formatted answers, and current/proposed value comparisons. Uploads, readers, saves, pricing calculations, and assistant replies show activity while pending. The interface respects reduced-motion preferences.

Verified the production build, desktop and phone review of the saved mounting-plate sketch and awning estimate, approval and PDF exports, CAD recompilation, and sketch exports. A live assistant reply correctly reported ten plates and separate delivery on the isolated demo. Controlled slow and failed replies verified pending feedback, draft input retention and protection against applying an outdated suggestion. Nick’s first-use walkthrough is still pending.

### Local workspace redesign · November 20, 2026

The quote desk opens with **Start a quote**, the most recently edited draft, and a searchable quote list. Start from a drawing or enter a job by hand. Inside a quote, the next action links to the part that needs attention. Each part shows its quantity status and cost before staff expand its cost rows. The price summary and save status stay easy to find.

**Drawing reviews** reopens saved blueprint readings and revisions. **Sketch to drawing** now opens an illustrated sheet, with separate views for measurements and shop files. Staff can filter checks by part and switch views while editing. **Shop settings** groups pricing, estimating rules, and history and connections.

Verified the production build and isolated workflows for quote creation and reopening, approval and customer PDFs, price revisions, drawing edits and recompilation, sketch downloads, and suggested-rule decisions. Tested desktop and phone layouts. On the local desk, reopened the saved awning estimate at $411.79 and the mounting-plate sketch, checked the quantity shortcut, and switched sketch views with an unsaved note. The sketch upload regression used the fixture reader. A first-use walkthrough with Nick is still pending.

### Local sketch drawing restored · November 20, 2026

Removed the three Vercel test deployments, their share link and environment variable, and the isolated Supabase preview schema and login. The existing Supabase learning archive and local shop database are available as before. The preview’s records were saved in `data/retired-vercel-preview-2026-11-20.sqlite`. The Vercel project and its GitHub connection remain available.

**Make drawing** opens the illustrated review sheet. The technical draft sits under **Technical draft PDF**. Reuploads of the same source and updates to its saved revisions reuse available illustration artwork and redraw the sheet with the current measurements and review notes. Staff can request a fresh illustration explicitly. The renderer can use an unambiguous written flat-bar size when the reader captures it as a note.

Regenerated the latest `IMG_0684.jpeg` revision 2 on the local app. The artwork matched the earlier sheet pixel for pixel. Chrome downloaded and reopened the PDF and PNG, and the PDF contained the isometric, top, side, bar stock, and mounting-plate views. The source comparison ran. The TypeScript check, production build, and 107 Python tests passed, with one platform-specific skip.

### Awning first-look allowance · November 20, 2026

Saved awning draft QT-0008 version 2 at $308.84 in shop costs and a $411.79 demo subtotal before tax using the existing 25% margin. The supplied $437.99 cantilever-bracket example guided the work categories. One editable batch allowance adds drilling, fit-up and tacking, shop welding, cleanup and inspection, and consumables. Reopened the draft to verify its original drawing link, prior lines and 28 open cost notes.

### U.S. benchmark budgets for the first look · November 20, 2026

New prepared blueprint drafts in demo mode open with editable benchmark costs where the saved drawing supports them. Older unpriced drafts can use **Add U.S. benchmark costs**. The estimator charges layout once per batch, prices identifiable cutting, forming, drilling and shop welding per piece, and uses a 12% trim allowance on measurable flat stock. Missing quantities remain working quantities. Supplier quotes, unclear stock lengths, outside finishing and site work appear in the open-cost list. The price card calls the result a demo budget subtotal.

The dated references are the BLS May 2025 median welder wage of $25.84 per hour, its June 2026 private-employer benefit ratio, and published shop rates as a selling-price check. The demo uses $75 per hour for labor with overhead included and $85 per hour for attended machine work. The $2.55/lb A36 benchmark comes from a retail cut plate sample. The available 304 and 6061 rates use separate supplier examples. These rates and the work-time allowances are editable estimates. [BLS wages](https://www.bls.gov/news.release/pdf/ocwage.pdf) · [BLS compensation](https://www.bls.gov/news.release/ecec.nr0.htm) · [Texas Metal Works](https://texasmetalworks.com/services/welding-services/) · [Online Metals A36](https://www.onlinemetals.com/en/buy/carbon-steel/0-25-carbon-steel-plate-a36-hot-rolled/pid/9610?variant=9610_12_48) · [Online Metals 304](https://www.onlinemetals.com/en/buy/stainless-steel/0-12-stainless-sheet-304-annealed-2b/pid/6831) · [NOX Metals 6061](https://noxmetals.co/products/6061-t651-plate-0-25x24x48-inch)

The four-bracket demo reopened at $239.71 shop cost and $319.61 before tax at 25% margin. The current awning drawing opened a separate partial budget with $135.84 in priced costs and a $181.12 subtotal, with open stock and scope costs listed. Chrome checked a fresh prepared draft and applying the benchmarks to an older zero-cost draft. The price verification covered batch setup, per-piece recalculation, approved customer PDF and frozen staff cost exports. This milestone reused saved drawing extractions.

### Simpler drawing review for quoting · November 20, 2026

**Quote setup** groups what the shop will do with the order quantities and specs still needed for pricing. The recommended next step points staff to a decision or source of information without entering values. **Check the drawing** shows uncertain readings, source evidence and possible omissions. **What the AI found** keeps a searchable parts list with links back to the relevant quote input. Staff can open a quote draft from any tab. The drawing stays beside the review on desktop and opens on demand on a phone.

Advanced manufacturing and automatic-pricing checks sit under one disclosure. Finished estimates show a compact price-by-part list with detailed costs and citations available on each line.

Chrome verified the three views, keyboard navigation, mobile preview, links from the inventory to a missing quantity, and the saved awning draft handoff. A separate two-part fixture checked cost and history citations, advanced controls and reopening an editable quote. The production build passed. These checks reused saved drawing readings.

### Quote workflow for the shop preview · November 20, 2026

**Start a quote** keeps the detailed drawing review for PDFs and DXFs. Terra reads the source. Astra separately checks complex PDFs for missing or conflicting items that affect scope and price. The estimate stores the audit status and only fills fields that pass source validation. The budget draft opens at the top of the review and saves current shop-scope and drawing edits first. A part with an open order quantity stays on its own quote line with an editable working quantity. Customer review requires staff to confirm or remove each provisional line. Recovered items held out of the budget remain visible as a scope decision.

On a prepared quote, **Plan costs with AI → Plan the work** uses current rates, templates and eligible historical actuals to propose editable cost rows. Astra reviews units, scope, batch versus per-piece basis and supporting allowances. The desk computes prices on the server. The quote editor keeps unanswered pricing questions near the proposed costs, and the original drawing is still attached. Manual costs and shop templates remain available.

The OpenAI model overrides are `VISION_MODEL` for the first read, `BLUEPRINT_AUDIT_MODEL` for the complex PDF check and `QUOTE_PLAN_REVIEW_MODEL` for the estimate check. The preview remains a local desk. Shop rates and initial quote assumptions need Nick’s confirmation before real customer pricing.

Live Terra and Astra read Nick’s awning and filled three source-backed values in the second pass. Chrome carried the original PDF and current scope into a named budget draft at phone width, saved an order quantity and reopened it. A live plan priced a half-hour batch setup at the dated demo rate and left an unknown galvanizing cost open. The manual quote recalculated from $266.67 to $306.67 after a labor edit. Approval, archived customer and staff exports, and the drawing audit replay passed. The drawing control held an unsupported width change and released the PDF, DXF and BOM after restoring the written width. The Python suite passed 106 tests with one platform-specific skip. [Audit report](.test-results/real-drawing-audit-i6yzm98j/report.json)

### Sketch verification before review and release · November 20, 2026

The concept workflow compares the source photo, written claims, measured geometry, and rendered sheet with a separate vision pass. Findings and calculated opening-to-edge clearances are attached to the revision and printed with the concept PDF. Disputed rod positions are withheld from the schematic views. The isometric remains a review illustration, and its hardware interpretations are called out in the report.

The technical workflow checks the source before publishing PDF, DXF and CSV files. Significant conflicts add review items, with a saved comparison tied to the source and reading. The original engineering and tentative-thickness checks remain in effect across edits. If the automatic comparison is unavailable, the technical revision requires a manual source check.

On Nick’s bracket, the live check found the rod layout disagreement, open bar locations and connections, interpreted hardware, tentative thickness and cropped ¼-inch detail. The plotted ⅞-inch holes have a calculated 5/16-inch opening-to-edge clearance. A separate slotted plate with a deliberate 125 mm reading of 120 mm ink stayed in review until the source dimension was restored. The live release and quote handoff passed. Round-hole and angled-slot polygon clearance checks passed offline. The Python suite passed 106 tests with one platform-specific skip.

### Expanded flat-bar drawing views · November 20, 2026

The parallel-bar assembly sheet now gives the bars dedicated, wide top and side views and a dimensioned stock end view. The top view projects visible rod marks from the source sketch onto their respective bars. The side elevation uses the same marks from one bar. These positions are schematic and the sheet flags final spacing, rod count, and attachments for confirmation. The mounting plate front and tentative edge detail sit together alongside the isometric illustration.

Nick’s saved revision 3 was updated and reopened in Chrome. The sheet shows five visible rod marks per bar, the 3 × 1-inch stock section, the written 32-inch callout, and the mounting plate’s three holes with the ¾-inch offset from the top. The original artwork matched pixel for pixel. The separate live sketch release and quote handoff passed. The Python suite passed 102 tests with one platform-specific skip.

### Top and edge views on the sketch sheet · November 20, 2026

The concept sheet adds a schematic top view when the source shows a pair of parallel flat bars on a rectangular plate. The top view shows the written face width, stock thickness, and any distinct length callout. It leaves unspecified gap and rod positions open. The rectangular plate detail adds an edge view when the sketch gives a thickness, with a dashed profile and a tentative label for a thickness that may change.

**Update drawing** on a previously generated sheet reuses the saved Sunburst artwork. Nick’s revision 3 reopened with the top view, 3-inch bar face width, 1-inch stock thickness, written 32-inch length callout, and tentative ½-inch plate edge. The existing 2–3–3–2 hole chain and ¾-inch top offset were verified on the same sheet. Browser checks covered the update, reopening both downloads, and a separate live DXF/PDF/BOM release and quote handoff. The Python suite passed 102 tests with one platform-specific skip.

### Image-led drawing sheet · November 20, 2026

**Make drawing** on a saved sketch revision now opens a finished review sheet. Sunburst draws the isometric view. The vision reader locates leader targets on that view, and the renderer places the written callouts, measured part detail, general notes and title block. Nick can open the full-size image, download the PDF or PNG, and remake the sheet on the same revision. Earlier illustration-only previews can be remade with the new layout.

The preview uses the saved sketch and is marked **AI concept drawing**. Its measured inset comes from the sketch solver. **Download technical PDF** and the checked DXF release remain available in the sketch workflow. PDF and PNG outputs are recorded together against the exact saved revision. A remake keeps the latest completed sheet available while the new job runs.

The live browser test made the sheet from Nick’s sketch at phone width, downloaded both formats and reloaded the saved result. The app also generated and reopened the sheet on Nick’s saved revision 3. The database confirmed GPT-Image-2.6 Sunburst generated its artwork. It preserved the 10 × 2½-inch plate, three ⅞-inch holes and ¾-inch offset from the top. The drawing kept the tentative plate thickness, open rod quantity and spacing, and engineering note. The live control passed the reviewed DXF, PDF, BOM and quote link flow. The Python suite passed 101 tests with one platform-specific skip.

### Assembly drafting and AI visual previews · November 20, 2026

**Sketch to drawing** takes phone photos and single-page PDF scans. Terra reads the dimensions and other source details. Complex assembly drafts use Astra for the pictorial layout by default. The first PDF sheet now pairs the assembly and its component tags with a dimensioned part view, hole schedule and review items. Additional sheets carry details or overflow notes. The original stays downloadable in the sketch workspace. Released technical files still use the checked geometry. Simple two-part releases can share one dimensioned sheet, and larger sets include a part index.

**AI visual preview** runs Sunburst on request for the saved revision. It uses the saved source and, when issued, the approved part geometry. The preview is stamped **Do not fabricate**. PostgreSQL records generation status and pins the checksum and version of the image stored in MinIO. The image never feeds the solver, cut list, or quote. The private server supports `SKETCH_ASSEMBLY_MODEL` and `SKETCH_VISUAL_MODEL` overrides. Run `.\infra\setup.ps1 start` for migration `0007_sketch_visual_previews`, then rebuild and restart the web desk.

Live Terra, Astra and Sunburst ran against Nick’s mounting plate and bar sketch. The final one-page technical draft reproduced the 10 × 2½-inch plate and the 2–3–3–2 hole chain with the ¾-inch offset from the top. It kept the tentative plate thickness and the unresolved assembly details visible. Sunburst returned a polished reference image with eight rods, while the sketch depicts ten marks and gives no written finished count. Chrome reopened the saved preview after a service restart, downloaded both outputs at phone width, and uploaded a scanned PDF whose original bytes matched. A live control verified the reviewed DXF, PDF, BOM, and linked-quote flow. The Python suite passed 100 tests with one platform-specific skip. Manual draft pricing, reopening and attachment revisions passed the browser regression. Migration 0007 applied on both stacks. The separate Alembic drift check still reports three older tables created by SQL migrations without ORM models.

Fully located transverse positions, rod spacing, joint specifications, and structural sign-off still require job-specific information.

### Assembly overview in sketch drafts · November 20, 2026

Draft PDFs for compound sketches now open with a clean pictorial drawing of the visible assembly. The engineering worker reads member faces, hardware marks, and written notes into a separate illustration cached against the saved photo checksum. The pictorial drawing uses image coordinates and is marked **Not to scale**. Part sheets still solve dimensions from written measurements and show plotted hole offsets. Cropped or under-dimensioned views keep their source and open questions.

Live GPT-6.1 Terra and GPT-6.2 Astra both found the mounting plate, two bars, three anchor positions, and visible threaded rods on Nick’s actual photo. Terra also preserved the plate spacing and the separately written 32-inch bar dimension, so it remains the default. Set `SKETCH_ASSEMBLY_MODEL` to compare a different model on the worker. Sketches still need dimension review before cutting. The first assembly draft may take about a minute, and repeat downloads use the saved illustration.

Chrome regenerated the supplied revision 3 and reopened the cached PDF at phone width. The drawing plots the 10 × 2½-inch plate and three ⅞-inch holes at 2, 5, and 8 inches from the left, ¾ inch below the top. The cropped lower view stays with the source notes. The real-drawing browser replay and released cut-file controls passed. Python reported 98 passed with one platform-specific skip.

### Draft drawing before sketch sign-off · November 20, 2026

Choose **Make draft drawing** at the top of a sketch with open checks. It downloads a marked PDF using the current readings. The draft includes dimensioned profiles and located features, a list of open details, and the source photo. Incomplete or conflicting geometry appears as a reference view. Use **Confirm and make files** to release the checked shop PDF, full-size DXF, and cut list.

Chrome downloaded a draft for Nick’s handwritten mounting plate while the sketch was still in review. The rendered PDF showed the 10 × 2½-inch profile and all three hole centers. The bars and cropped view appeared as reference pages with their missing details listed. A separate Chrome run confirmed a control revision, downloaded all three released formats, and reopened the earlier release. The Python suite reported 97 passed with one platform-specific skip.

### Fill missing blueprint details from the drawing · November 20, 2026

New PDF reviews apply the second read’s source-backed values directly to the estimate. The app validates the original excerpt and its part before filling written quantities, material and finish, stock sizes, and labeled dimensions. Explicit hole counts and diameters, bend counts, and fillet weld sizes can be entered while unspecified dimensions stay open. Competing values and reviewer edits are preserved for review. A count per assembly stays separate from an order quantity.

**Fill from printed callouts** upgrades older saved reviews from the stored original, and **What the AI found** lists the filled values with page links. The live awning advanced to version 3 with the ledger plate’s 3 × 11 × ½-inch stock size and the drip edge’s copper material filled in. Chrome reopened both results and confirmed the original drawing and first extraction were preserved. The ledger plate’s order quantity remains open.

A live OpenAI follow-up on a two-page control filled nine values and feature details, including both order quantities, written widths and grades, and a hole callout. The finish remained open because two finishes were listed. The original-drawing browser replay and cost controls passed. The Python suite reported 95 passed with one platform-specific skip. The new automatic backfill relies on verifiable printed PDF evidence. Completeness across more projects and scan-only files still needs validation.

### Pricing priorities and source checks · November 20, 2026

Blueprint review puts order quantity, material, thickness, and finish under **Start with pricing inputs**. **Detailed drawing checks** holds the remaining geometry and manufacturing questions. In **Check AI readings and omissions**, each check displays the AI’s value, an excerpt or a link to the original, and an edit option. The review distinguishes readings the AI is unsure about, values that need a direct source, and omissions raised on a second read. An uncited part description no longer blocks automatic pricing. Material, quantity, geometry, and manufacturing checks still guard automatic pricing, and budget drafts remain available for separately priced work.

The PDF reader compares more named hardware and purchased components with the saved parts list. **Check printed callouts** upgrades an older review from the original PDF and preserves existing scope decisions and revision history. On Nick’s awning, it recovered six named callouts, including the Maine deck bracket, metal furring strips, and lighting fixture. These enter scope review with order quantities open.

Live GPT-6.1 Terra and GPT-6.2 Astra compared the same saved awning inventory with the original PDF. Terra flagged the second bend and the gutter attachment choice. The deterministic text check recovered the same six callouts for both runs. Terra remains the default. Set `BLUEPRINT_AUDIT_MODEL` on the engineering worker to select a different OpenAI model for the complex-PDF follow-up. Live controls verified a two-page PDF kept a missing grade and order quantity open and a native metric DXF retained its written quantity and geometry. The saved awning and sketch passed the browser replay, and the Python regression suite reported 92 passed with one platform-specific skip. Coverage across a larger set of Nick’s drawings remains to be measured.

### Blueprint review by next action · November 20, 2026

The review now opens with four direct links. **Nick’s scope and pricing** collects what the shop will supply, installation, recovered items to include or exclude, and named parts or field work to price in the prepared draft. **Confirm quantities and specs** groups unanswered details by part and puts order quantities and materials first. **Check what the AI may have missed** holds uncertain readings, possible omissions, and the evidence from the second read. **What the AI found** shows the searchable parts list and links to the source and each open quantity or scope decision.

Chrome replayed Nick’s awning PDF and sketch on desktop and at a 390-pixel viewport. The awning checks verified the C3×6 gutter in separate pricing, the jump to the quantity field, and saved copper scope decisions and installation in the prepared quote. The CAD and pricing controls passed, and the Python suite reported 90 passed with one platform-specific skip. This replay used the saved extraction. Order quantities, scope boundaries, and uncovered work still require a shop or customer decision before pricing.

### Blueprint validation recovery · November 20, 2026

The OpenAI drawing schema now carries supported numeric and array limits. Local validation hides invalid display-only overlay fields, keeps out-of-range physical values open for review, and flags repeated part identifiers. A structurally invalid reply triggers one automatic reread of the original. If both replies fail and the PDF has verifiable printed components, the app opens a partial review with those callouts and keeps pricing gated on confirmation.

Retried the original saved awning upload after its schema error. The same file checksum reached **Needs your review** at version 2, with both copper callouts present. The regression suite passed 90 tests with one platform-specific skip, including automatic reread and printed-callout fallback.

### Source callout reconciliation and review priorities · November 20, 2026

Blueprint review compares recognized printed PDF components with the saved vision inventory. Repeated section callouts are matched to existing parts. Missed components supported by verbatim printed evidence become scope candidates with the page citation and an open order quantity. Complex PDFs also ask the independent vision check for omitted components and visual questions. An older PDF review can run **Check printed callouts** on its saved original.

The review has **From Nick** for shop scope, installation and rates, **Confirm details** for open quantities and measurements, and **AI source check** for recovered callouts and evidence checks. Use **Include in quote scope** or **Outside our scope** on a recovered item and **Save progress**. The saved scope and installation choices carry into the prepared quote. The customer scope is seeded as editable text for approval. The original reading and exclusions remain in the review history.

Nick’s awning now retains the 8-inch copper half-round gutter and 6-inch copper downspout in the saved reader output, both with the page-one callouts. The live upload and the replay of a saved revision recovered both without guessing the count. Chrome exercised inclusion, exclusion, save, reopen, quote handoff and restoration on the saved review. The regression suite passed 85 tests with one platform-specific skip. The printed comparison covers recognized callout patterns and verified second-pass findings. It does not certify total extraction accuracy across arbitrary drawings or scans. [Repeat the audit](tests/real_drawings/README.md)

### One detailed drawing intake and a clearer review · November 20, 2026

With Engineering Records connected, Home **Start a quote** and **Blueprint estimates** send PDFs and DXFs to the same detailed reader. Blueprint estimates also reopens saved reviews and handles drawing revisions and custom rate cards. Photo and manual quote entry remain available.

The reader reconciles plans, sections, notes and part callouts before completing the inventory. A second check reviews complex PDFs and can fill blank printed fields when the exact wording binds the value to one recorded part. Customer quantities explicitly written in notes carry through with their citation and conflicting readings stay open. Unsupported sections retain their readings and route to manual pricing without asking for flat-stock dimensions they do not use.

The review leads with a searchable part list, drawing evidence and a direct link from a missing quantity to its input. Quantity and material checks appear first. Feature editing, geometry and uncertain checks open separately. Confirmed finishes and drawing requirements carry into the quote.

The live audit started Nick’s original awning from Home in Chrome and reached the engineering worker and the same Blueprint Review. It found 18 component entries. Chrome found the C3×6 gutter, saved an example quantity in the incomplete review and reopened its prepared quote. The audit also passed the original handwritten sketch and the CAD, pricing, source storage and history controls. The engineers’ source and customer price references needed for a broader accuracy benchmark are still outstanding. The regression suite passed 82 tests with one platform-specific skip. [Repeat the audit](tests/real_drawings/README.md)

### Faster drawing review and saved progress · November 20, 2026

The desk records source stamps such as “Not for Construction” as context. Staff can review, estimate, create a draft, or compile supported geometry from the same sheet. Missing dimensions, scope, and cost inputs still have their standard checks. Previously saved blueprint readings use the new policy when reopened.

Blueprint Review groups outstanding checks by part. Staff can fill missing settings, check evidence, resolve a question, and use **Save progress** to keep an incomplete review. Final pricing uses the confirmed review. An incomplete review revision does not have published shop files.

Photo review starts with the source photo and both types of markers hidden. **Details to check** lists the questions, and **View on photo** points to the source. Nick can enter measurements exactly as written, including fractions. The live reader gets enlarged views of large photos, and recorded engineering and tentative-thickness notes get explicit checks. The structured AI response validator now uses the local Windows Python environment first and can retry validation through WSL if the local process fails.

Chrome reopened Nick’s awning, saved an incomplete part review, and opened an editable quote with the original PDF. Regular quote intake accepted the same sheet. A fully specified stamped control passed CAD proof and quote approval checks. The handwritten photo read retained its measurements and explicit review checks. Two consecutive live Ask AI requests succeeded. The isolated audit passed across both originals and the released control plate. The Python suite passed 80 tests with one platform-specific skip.

### Live regression with Nick’s two originals · November 20, 2026

Chrome uploaded and reopened the original `2208_AWNING-A6.7.pdf` and `IMG_0684.jpeg` at desktop and phone widths. Both originals round-tripped byte for byte. GPT-6.1 Terra recorded 15 component entries on the awning sheet, including 5/16-inch angles, ¼-inch-wall square tube and the C3×6 gutter channel. Its approved quantities were still unknown. At the time of that audit, the stamp blocked pricing and shop files in Blueprint Review while the regular quote intake could reach **Awaiting review**.

The live photo read matched the 10 × 2½-inch mounting plate, three ⅞-inch holes and the 2–3–3–2-inch spacing chain. **Ask AI** pointed out the tentative ½-inch thickness and asked about the ¾-inch top offset on one attempt. A repeat returned an engineering-runtime error. The app held the sketch for incomplete geometry and missing specifications. It retained “Engineering Req’d” as a note without showing it as a review flag in this run. Neither original produced released shop files or a customer quote.

Separate controls exercised the CAD exports, quote pricing, saved customer PDF, local test email, dated rate history and job retrieval. A complete plate produced an audited DXF, a rendered PDF, a reconciled cut list and a three-piece draft. Changing a practice quote’s labor from 1½ to 2 hours recalculated the price from $266.67 to $306.67. The audit reports 78 Python tests passed and one skipped on Windows. [Repeat the audit](tests/real_drawings/README.md)

### Ask AI · Drawing corrections and work planning

Saved quotes, Blueprint Review and phone sketch reviews have **Ask AI**. Type an instruction or select **Use microphone** to put editable speech-to-text in the instruction box. Use **Check the drawing** or **Check the sketch** to find missing features and written measurements. The assistant compares the original page with the current draft and lists its proposed changes with their sources. Applying a proposal fills the working editor. The normal save action keeps the revision and runs the geometry or pricing checks. A change to the draft, quote revision or selected source makes an earlier suggestion stale.

Drawings with work outside the flat-stock calculator can open a prepared quote with the original attached or linked, known quantities and a checklist for the remaining work. **Ask AI → Plan the work** proposes editable costs using the effective-dated shop rates, templates and eligible examples from the saved history. It can ask for quantities, supplier prices or site details it cannot establish. The Python pricing engine recalculates batch and per-piece costs. Drafts from unissued sheets can be used for internal budgets. Their source hold prevents customer approval and shop release.

Live GPT-6.1 Terra recovered an omitted 120 mm label from a test sketch, placed a requested ½-inch hole that compiled in the drawing proof and prepared a $30 batch setup using a dated demo rate. Chrome recorded a simulated microphone stream and the live transcription API returned editable text. A quote labor correction previewed and saved $306.67 while the preview left the $266.67 draft intact. Chrome opened Nick's held awning PDF in an internal budget draft. Approval checks rejected a priced draft tied to an unissued source. The manual quote, drawing revision, approval archive and 79 Python tests also passed.

Run the browser and live model check with `.\quote.cmd exec node scripts/verify-shop-assistant.mjs` after building the app and loading the drawing audit fixtures on the isolated engineering stack. Pass a WAV file containing “Set fabrication labor to two hours for this batch” to exercise Chrome recording and live transcription with a test microphone. The feature uses the configured vision model and the existing server-side OpenAI key. Voice defaults to `gpt-transcribe` and can be set with `OPENAI_TRANSCRIPTION_MODEL`.

### Drawing review and shared learning · November 20, 2026

Large architectural sheets receive a second vision pass for omitted items and conflicting callouts. The desk keeps the original reading and adds questions with page evidence. A deterministic check compares cited scalar inch and metric measurements with the extracted value, including mixed fractions and dimension chains. Visual or derived geometry still requires an explicit source check. The awning follow-up raised the unspecified protective finish and retained the drawing's issue restriction. The handwritten sketch kept its engineering, thickness and cropped-profile questions.

Blueprint review has form controls to add parts, round holes and slots, bends, welds, profile corners and shop requirements. Edits retain a review reason and the original extraction. Issued sheets with work outside the automatic flat-stock calculator can open a manual quote draft with the source attached. Commercial approval requires entered cost rows and confirmed scope. An unissued source stays in review.

The private Supabase history schema now also receives standalone engineering blueprints, sketch revisions, original bytes, raw readings, corrections, dated engineering catalog entries and rule revisions through the workstation's retry queue. The blueprint estimator reads the same Supabase approved-line history as the template estimator, cites eligible jobs and distinguishes recorded exceptions. Historical amounts provide context. Current approved rules and the frozen rate card govern pricing.

Verification used Nick’s supplied files and separate historical and pricing controls. The live awning review and photo reached the expected holds. Chrome added a missing ½-inch opening, saved it, and recalculated the estimate. An issued reference supported a manually priced draft and frozen approval. All 79 Python regression tests passed under WSL.

LittleMountainQuote matched 76 production records and seven original files or previews byte for byte. The read login was read-only and anonymous access was closed. An isolated hosted test round-tripped the blueprint PDF and raw extraction, then carried actuals into a Celery estimate without altering its rates. Five completed test jobs informed a live 45-to-90-minute setup recommendation. The shop workspace had one approved line and no completed-job actuals. Verification workspaces and their proposals stay separate. [Hosted engineering learning check](scripts/verify-engineering-learning.mjs)

### Real drawing audit · November 20, 2026

The audit runner uploads each supplied original through an isolated Chrome desk, follows FastAPI and Celery status, reopens the review and verifies the versioned original bytes. It checks DXF units, cut loops, overlap and measured dimensions. It renders shop PDFs, checks text bounds and compares BOM quantities and masses. Its report records unsupported inputs and historical quote variance where matched reference prices are available. [Audit setup and reference format](tests/real_drawings/README.md)

Nick's iPhone JPEG exposed an HDR gain-map compatibility issue. The reader now uses the primary photo and retains the original bytes. The solver accepts a written diameter such as `7/8" holes` for an identified group with individually located centers. An explicit count still has to match. The awning sheet surfaced separate stock sections and the need for an issued drawing. Large PDF sheets now include overlapping detail images for the model, and the estimate retains written stock designations, gauges and weld qualifiers. A PDF text mark stating “NOT FOR CONSTRUCTION” blocks pricing and shop-file generation for that source revision.

The two supplied drawings entered review. The awning sheet carried an explicit issue restriction. The sketch specified a 10 × 2½-inch plate with ⅞-inch holes and identified an engineering review, uncertain thickness and incomplete assembly details. The CAD and pricing controls used prepared files and demo rates. They verified an immediate 120-to-125 mm revision, an audited DXF, a rendered shop PDF, a three-piece cut list and linked quote, and a labor change from 1½ to 2 hours that moved a test price from $266.67 to $306.67. PostgreSQL controls reconciled nesting, pierces, kerf, welding consumables and work-center hours, retrieved cited history and applied an approved rule. An unmapped 2205 alloy stayed in review. All 78 Python regression tests passed under the WSL runtime. The folder had no historical quote totals for the two originals.

### Engineering Phase 4 · Drawing and quote review

Open a saved quote and choose **Drawing & quote workspace**. The side-by-side desk shows the drawing, numbered confidence pins, original work-center estimates, Nick’s hours and costs, and the source jobs and rules. Pin edits run the constraint solver and audited DXF/PDF compiler. Unresolved geometry stays in review. PDF and DXF blueprints support page registration. Reviewed blueprint shop files are pinned to exact MinIO object versions.

The Python pricing engine applies per-piece and batch overrides, row minimums, an optional extra material buffer and target gross margin. The buffer starts off. Its editable starting allowance is 10% when enabled. Each revision retains its settings and adjustment reasons. Staff can download the customer’s approved proposal and a separate internal ZIP with the shop traveler and cost CSV.

The engineering archive queues each finalized quote for Celery in the same PostgreSQL transaction. Distillation uses distinct jobs and their latest finalized revisions. Three comparable jobs must agree, with at least 75% agreement among the matching jobs. One-time exceptions and scope changes are excluded. The worker distinguishes changes in hours from independent changes in rate. Nick can inspect the evidence and approve or dismiss a proposed rule in **Shop settings → Nick’s Rules**. Approved quote decisions describe estimating preferences. The existing completed-job workflow supplies measured production times.

Verification used prepared drawings on the isolated engineering stack and passed 75 CAD, extraction and costing tests. Chrome changed a plate from 6 to 7 inches and checked an edited weld in the recompiled shop PDF. The downloaded inch DXF had closed cut contours, zero audit errors and zero fixes. The original ten-part demo priced at $200.00 cost and $266.67 before tax. With the extra 10% stock buffer, it priced at $208.00 and $277.33. The customer PDF and internal bundle for an approved version stayed byte-identical after a revision and desk restart.

PostgreSQL retained a proposed 0.25-hour, $21.25 plasma setup and Nick’s 1.50-hour, $127.50 override with its reason and source. In a separate test, three comparable jobs changed setup from 45 to 90 minutes. Nick approved the resulting suggestion, and the next matching estimate used 90 minutes. Repeat submissions, later versions of the same job, one-time exceptions and dismissal were exercised. Phase 4 verification used saved model readings and made no live vision requests.

The shop service is running migration `0006_reviewed_shop_files`. For acceptance checks, use `.\infra\setup.ps1 verify -TestStack` and `.\quote.cmd exec node scripts/verify-review-workspace.mjs` after building the web app and populating the Phase 2 and 3 test fixtures. Nick’s real jobs, rates and decisions are still needed to evaluate shop accuracy.

### Engineering Phase 3 · Phone sketch to shop files

The shop desk now takes a phone photo through page detection, perspective correction, handwriting review and deterministic CAD release. Each measurement or weld callout retains its source location and feature reference. Nick can edit measurements, place feature references on the photo, resolve numbered warnings and reopen any saved revision. The solver uses written dimensions for scale. Ambiguous geometry, conflicting values and unverified readings below 0.85 hold the whole release for review.

One authenticated `POST /drawings/from-sketch` can return a full-size DXF per part, an ANSI B shop PDF and a CSV cut list. The shop screen asks for confirmation. PostgreSQL records the input, corrections, solution and file checksums. Versioned MinIO retains the original photo, previews and released bytes. **Create or open quote** links to the exact released revision.

Live GPT-6.1 Terra and the production browser build ran against an isolated ledger.

- The slotted-plate DXF measured 120 × 80 mm with a 36 × 10 mm slot centered at (60, 40). The PDF and BOM showed three pieces of 6 mm 304 stainless.
- The incomplete bench plate stayed in review until staff supplied its height and two hole locations. It then opened a four-piece quote. A conflicting edit blocked a new release while the earlier version remained downloadable.
- A skewed weld-and-bend sketch produced four 1/2-inch hole locations, a 90° up bend on the scribe layer and a 1/8-inch arrow-side fillet callout on edge E2. Independent DXF audits reported zero errors and zero fixes.
- Restarting the engineering services preserved the original and all three artifact checksums. Restarting the desk reopened the same linked quote. The CAD and AI suite passed 69 tests.

Use the main **Sketch to drawing** tab or the [local sketch desk](http://127.0.0.1:3100/sketches). The next shop-specific check is import into Nick’s actual CAM with his drawings and tool settings. [Run commands](README.md) · [API and repeatable tests](infra/README.md#phone-sketch-conversion)

### Engineering Phase 2 · Blueprint estimates

The shop desk accepts customer PDFs and native DXFs. A Celery worker reads the exact stored drawing revision into a strict engineering schema. Readings below 0.85, missing dimensions, conflicting inputs and unpriced scope are held for review. The original result, staff corrections and frozen rates accompany the estimate. Each line shows stock allocation, cutting, bending and welding costs as applicable, along with its historical and rule citations. Opening an editable draft preserves the original calculation and links approval to the source revision.

The isolated live GPT-6.1 Terra test read a two-page plate set with missing specifications and a metric DXF. The DXF resolved to a 6 × 4 × 0.25 in plate. After correction, the two-part PDF yielded $304.30 cost and $422.64 before tax under the synthetic customer's approved 28% margin rule. The test recovered the original files, found the historical quote, rejected a stale correction and preserved the initial reading. Desktop Chrome also uploaded and reopened a drawing, inspected citations, and opened the same editable draft twice. CAD, pricing and approval regressions include the original $200.00 cost and $266.67 price.

The browser opened page two of the original PDF from the saved draft, changed a part quantity, recalculated the batch and reopened both the original and corrected quantities. The test API returned an image of the native DXF contours. Real PostgreSQL checks covered five distinct comparables, approval cutoffs, revisions and rule conflicts on migration `0003_blueprint_rag`.

The default rates and weld schedules are illustrative. Nesting uses rectangular blank envelopes with rotation and charges purchased sheets. The default history search uses shop vocabulary vectors in the Phase 1 PostgreSQL database. Model confidence is self-reported. Nick's dated shop rates, confirmed production schedules and labeled historical jobs are needed to measure accuracy. The roadmap's 50-job, under-8% error target remains unverified. [Run and verification commands](README.md)

| Step | Working flow and verification |
| --- | --- |
| 1. Manual quotes | Create, edit, save and reopen drafts. Ten $8 blanks, $90 batch labor and $30 delivery gave $200.00 cost and $266.67 before tax at 25% margin. |
| 2. Drawings | Multiple attachments with selectable revisions and side-by-side preview. After restarting the app and browser, all three tested originals matched byte-for-byte. Notes and revision selection persisted. |
| 3. Drawing review | Live local Qwen reviewed a two-page multipart drawing and a drawing missing material and finish. Staff corrected a conflicting quantity and applied it to the line. Source excerpts, raw responses and corrections survive restart. Late responses and stale revisions were tested separately. |
| 4. Settings and templates | Materials, setup, labor and machine rates have units, coverage and minimums. Templates use reviewed specifications. Chrome verified that editing a setup allowance recalculated $246.67 to $266.67. Changing setup from $60 to $90 per hour preserved the earlier version at $60. |
| 5. Approval and PDF | Nick resolves required details, confirms scope and lead time, approves an exact version and tracks its status. The $266.67 customer PDF excluded internal costs and assumptions and stayed byte-identical after a drawing and pricing revision. All seven states were exercised. |
| 6. Email | Gmail-label sync and local .eml import link messages, replies and revised drawings to the request. In Chrome a duplicate created one request. One approved PDF reached the local test mailbox. A simulated Gmail lost acknowledgment was reconciled after restart without resending. |
| 7. Job history | Manual and CSV actuals attach to an approved version. **Price the work → Check times against past jobs** shows matched work, material, dimensions, quantity and operations. A live local model used 0.5 setup hours and 2 labor hours for 10 completed parts to suggest 0.5 hours per batch and 0.2 per part. In Chrome, edits at current rates produced $599.00 cost and $798.67 selling price for 20 parts. Staff review reopened the original evidence, including the saved actuals edit. Quote-only exceptions and separately approved template changes were verified. |
| 8. Supabase learning history | The normal estimate builder reads approved quotes and actuals from LittleMountainQuote. It shows measured hours and Nick’s recurring pricing preferences with their supporting jobs. In an isolated hosted workspace, five comparable jobs yielded a median of 90 minutes against a 45-minute setup allowance. A sixth exceptional job was excluded. The live local model suggested 90 minutes. Nick controls adoption of the proposed default. |
| 9. Shop interface | The home screen starts or finds a quote. Customer and job name save the first draft. Staff add material or labor, choose per-piece or whole-batch costs, and review a customer copy before approval. Desktop and phone-sized Chrome checks covered search, reopening a draft, a price entered in minutes, drawings, PDF approval, one practice email and finished-job entry. The $200.00 cost and $266.67 selling-price regression passed. |
| 10. OpenAI drawing reader | Live GPT-6.1 Terra read the fictional WB-014 Rev A drawing and request. All nine fields matched with source excerpts, including the order for 10 and separate hole and weld notes. The approved practice PDF totaled $266.67 with $200.00 in shop costs. A second live read flagged missing material and finish. A live estimate cited a fictional completed job to suggest 0.5 setup hours per batch and 0.2 labor hours per piece. |
| 11. Drawing-first quote path | A PDF or photo starts a draft and opens the drawing reader. Customer notes are optional. Highlighted fields prompt for missing order details before pricing. The pricing screen shows the rate per unit, hourly shop cost, allowances, and example rates. Staff go to the next unpriced item or customer review, where they can enter the customer name. In phone-sized Chrome, live Terra filled the practice order quantity from the notes and the built-in fabrication template produced $155.00 cost and a $206.67 approved PDF before tax. A mocked missing-quantity check required a staff answer. Manual pricing, original drawings, and approval history passed regression checks. |
| 12. Sketch to drawing | Staff upload or take a photo, check written dimensions, and confirm a drawing. Verified live Terra with a complete practice sketch and one missing height and hole locations. Confirmation unlocked the PDF, 1:1 DXF, and CSV. Independent readers measured the DXF at 6 × 4 inches with both hole centers and checked the shop PDF. The linked quote used the approved four-piece cut list and computed its drill allowance from two holes. Original photos, exports, and the link survived restart. |

## Engineering roadmap · Phase 1

- The web desk now runs from `apps/web` on Next.js 15. The quote queue, work-center estimate dialog and Fabric drawing inspector are working screens. The inspector shows outside cuts, inside cuts, and bend marks from the Python kernel.
- The Python 3.12 API, Celery worker, PostgreSQL 16 with pgvector, Redis and versioned MinIO run through Compose. Alembic provides all seven requested entity models. Effective-dated catalogs preserve rate revisions. An approval queues its frozen inputs and selected source for transfer. Retry and lost-acknowledgment tests recovered a single Postgres receipt. Two revisions of one attachment were independently retrieved byte for byte after restart.
- Reviewed geometry produces a dimensioned shop PDF, a BOM and a 1:1 DXF with separate cutting and scribing layers. The tests cover exact arc dimensions, containment, clearance, kerf limits, stock planning, deterministic artifacts and independent DXF readback. A live OpenAI sketch read went through the new Pydantic gate, human confirmation, export, quote creation and reopening. The 36-test CAD suite passed.
- Shop settings, effective-dated supplier/work-center records, rectangular sheet yield and setup/run hours feed editable estimate rows. Frozen quote versions retain rates, originating records, calculation inputs, source-linked model suggestions and staff changes. The reference manual case still gives $200.00 cost and $266.67 selling price. A $300 routing revised to $350 kept the earlier $60/h rate and original $300 result. An isolated archive run retained a model proposal with 0.82 reported confidence and a staff override of 0.25 hours.
- Phase 1 is scoped to the trusted shop workstation. The new vector columns and rule schema are foundations for the later retrieval and preference phases. Model scores record what the model reported. Statistical calibration, the 50-job backtest and import into Nick’s actual CAM are outstanding. [Component setup and test commands](README.md)

The representative ten-piece routing exercised cutting, bending, welding, whole-sheet material and a delivery charge. It produced $230.00 estimated cost and $306.67 before tax. Five runs through the running service, including generation of both customer and staff documents, took 0.394–0.524 seconds in the final benchmark. Its first invocation, including loading the test runner and modules under concurrent load, took 1.663 seconds. Service startup and human review are outside the warmed measurement.

The live GPT-6.1 Terra history check retrieved an isolated completed job, cited the supporting record and proposed 0.5 setup hours per batch and 0.2 labor hours per piece. The model-reported confidence and the human adjustments remained separate. The desk also passed restart, drawing revision, selected-source, email fixture, original approved PDF and original internal CSV regression checks.

Chrome verified the engineering catalog against the isolated Postgres service. Two sheets at $2.65 each, 15 minutes of setup and one hour of production at 50% efficiency produced $80.30 cost and $107.07 selling price. New supplier and work-center rates produced $98.00 and $130.67. The earlier version retained its original rates, weight basis, hours and price. Five additional tests cover strict AI output validation, centered measurements, rounding, cost limits and physical unit conversion.

## Sketch to drawing

- Open **Sketch to drawing** in the sidebar. Upload a JPG, PNG, WebP, or HEIC photo up to 20 MB. Try the [slotted mounting plate PNG](fixtures/sketches/slotted-mounting-plate.png), the [dimensioned bench plate](fixtures/sketches/bench-plate-complete.jpg), or the [sketch with missing measurements](fixtures/sketches/bench-plate-missing.jpg). The slotted plate exercises PNG files with embedded image provenance metadata. The original is retained byte for byte.
- Chrome with live Terra verified the original slotted-plate PNG read as a 120 × 80 mm plate with one 36 × 10 mm slot, and exported the shop PDF, DXF, and cut list.
- Check the units, part quantity, material, thickness, outline, and cut features. Supported shapes include flat rectangles with square or equal-radius corners, straight-sided polygons, round holes, and round-ended slots. Enter centers as X from the left and Y up from the bottom. The DXF uses inches or millimeters at full size. Confirmed flat blanks can include scribed bend lines with explicit endpoints. The PDF is dimensioned and fitted to paper.
- After a build, run `.\quote.cmd exec node scripts/verify-sketch-cad.mjs` for export and geometry checks and `.\quote.cmd exec node scripts/verify-sketch-flow.mjs` for a browser flow with a fixture reader. Use `.\quote.cmd exec node --env-file=.env.local scripts/verify-sketch-flow.mjs --live` for live Terra on the two practice photos. The browser checks use an isolated database.
- Keep the sketch workspace and quote navigation together on migration. The sidebar uses `/sketches`. Engineering releases use `/api/sketch-conversions` on the desk and `/drawings/from-sketch` on the service. Earlier local sketches and the isolated practice desk use `/api/sketches`. Preserve the SQLite quote links, PostgreSQL sketch revisions and versioned MinIO objects together.
- Nick’s examples and plasma software name/version are needed to check the actual shop import and decide which other part shapes to support.

<details>
<summary>Slotted mounting plate image prompt</summary>

The built-in ImageGen tool created [slotted-mounting-plate.png](fixtures/sketches/slotted-mounting-plate.png) with this prompt.

> Use case: photorealistic-natural. Create a crisp overhead phone photograph for testing a fabrication app: an authentic blue-ballpoint hand sketch on one flat sheet of plain off-white paper on a muted gray workshop bench. Landscape framing, camera perpendicular, paper fills almost the entire image. Large, legible handwritten block letters and clean dimension values. The sketch depicts only one simple wide rectangular plate with four square outside corners and one horizontally oriented round-ended slot at the middle of the plate. Draw it like a real fabricator's rough top view, one closed rectangle and one capsule inside, proportionally 120 wide by 80 high and rounded slot about one third the plate width. Place the following exact handwritten text on separate lines above the rectangle or below it in a neat notes list. The title is "SLOTTED MOUNTING PLATE". The other lines are "ALL DIMENSIONS IN MM", "120 WIDE x 80 HIGH", "SQUARE CORNERS", "304 STAINLESS - 6 MM THICK", "MAKE 3 PIECES", "HORIZONTAL SLOT 36 x 10 MM OVERALL", "SLOT CENTER 60 MM FROM LEFT", and "SLOT CENTER 40 MM FROM BOTTOM". Include every line once with the exact numerical values shown. Draw a small ink leader from the slot to the space beside it if desired, but add no other labels or numerical values. Natural pen wobble and light paper texture, no tools, hands, logos, watermarks, grid paper, decorative marks, or extraneous objects.

</details>

## What Supabase stores

- **Request evidence** includes original files and customer messages, drawing revisions, confirmed specs, source excerpts, AI output and reviewer corrections.
- **Pricing history** includes dated supplier prices, shop rates, units, inclusions, rules and the inputs frozen with each quote version. A future supplier price takes effect on its effective date.
- **Pricing decisions** retain the first available draft, approved scope, PDF, cost, selling price, margin, edit reasons and whether Nick classified a change as recurring, a one-time exception or a scope change.
- **Completed jobs** retain actual hours and costs by operation, dated edits and exceptional work. Fixed hourly operations with at least five distinct comparable jobs consistently above or below the allowance can produce a proposed default. An explicit approval changes the template.

The private schema is `lmm_learning` in **LittleMountainQuote**. The server uses one scoped login to publish and another to read. The model receives selected evidence and templates through the app. Connection secrets stay in the server’s ignored `.env.local`. Gmail credentials are excluded from the archive.

**Shop settings → Saved job history and connection** shows the queue and last sync. Saved changes sync in the background and before comparisons. Connection failures leave edits queued for retry. Use `.\quote.cmd sync-history` for a manual sync or `.\quote.cmd sync-history --backfill` to replay this workspace. The initial shop backfill verified 37 records and four byte-identical files or previews. Verification workspaces have separate IDs and are excluded from the shop’s comparisons.

## Remaining setup

- **Shop settings.** Replace the clearly labeled demo rates, minimums and template allowances under **Shop settings**.
- **Gmail is deferred for client handoff.** When the client is ready, open **Customer emails → Set up Gmail for a client** for the callback URL, server settings and connection steps. Sample email import works now. [Google authorization guide](https://developers.google.com/workspace/gmail/api/auth/web-server)

## Operating notes

- Trusted local workstation with approvals attributed to Nick. Quotes use USD before tax, whole-number part quantities and New York expiration dates. Each extended row rounds to cents, with its minimum applied once after quantity scaling. Job actuals are totals for the line. An empty hourly cost records hours only.
- SQLite stores originals, versions, approvals, corrections, model results and actuals in `data/quotes.sqlite`. Set `LMM_DATA_DIR` to use another directory. Pre-upgrade quote history starts at the version that existed when migrated. Drawing limits are 20 MiB per file and 12 PDF pages per AI review.
- The workstation selects `VISION_PROVIDER=openai` and `VISION_MODEL=gpt-6.1-terra`. Keep `OPENAI_API_KEY` in the private server environment. Restart both desks after replacing the key or changing providers. Reading a drawing sends the selected drawing pages and customer notes to OpenAI; a past-job estimate sends the selected examples and template. Requests set `store: false`. The locally installed Qwen reader is available through the alternate settings in the example file and `.\quote.cmd vision`. [Server settings](.env.example) · [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra)
- Build, then run `.\quote.cmd exec node scripts/verify-NAME.mjs`, substituting `drafts`, `review`, `estimating`, `approval`, `inbox` or `history`. To exercise the live model run `.\quote.cmd exec node scripts/verify-history.mjs --live`. Tests use isolated databases. Sample messages are in `fixtures/mail/`.
- Run `.\quote.cmd exec node scripts/verify-quote-desk.mjs` to repeat the new-user checks with Chrome or Edge, including phone navigation and the Quick guide.
- Run `.\quote.cmd exec node scripts/verify-drawing-citations.mjs` to repeat the offline checks for requirements on separate drawing pages, conflicting weld sizes and incorrect page references.
- Run `.\quote.cmd exec node --env-file=.env.local scripts/verify-supabase.mjs` to compare the hosted records and file bytes with the workstation. The five-job test is `.\quote.cmd exec node --env-file=.env.local scripts/verify-learning-evidence.mjs --cloud --live`; it creates a separate verification workspace. Use the included migrations and separate server logins for a new client project. [Supabase connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres)
- QuoteDesk informed source-linked extraction and version checks. Anthropic’s quoting workflow informed batch costing and margin presentation. [QuoteDesk](https://github.com/dcgursoy/QuoteDesk) · [Anthropic quote-build](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/claude-for-manufacturing/skills/quote-build/SKILL.md)

Update this file after every future milestone.

<details><summary>Workshop banner asset</summary>

The built-in ImageGen tool generated [workshop-banner.webp](public/workshop-banner.webp) from the following prompt.

> Photorealistic wide editorial photograph for a metal fabrication shop's quote desk banner. Wide landscape 3:1 composition. A welder in a dark protective welding helmet and worn leather gloves working on a heavy steel fixture at a shop bench on the right half of the frame. A vivid localized white weld arc and a few fine amber sparks towards the lower right. Natural muted forest-green, charcoal and bronze palette and warm directional daylight from industrial windows, quiet dark workshop shadows across the left half for text overlay. No lettering, labels, or logos.

</details>
