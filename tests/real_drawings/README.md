# Real drawing audit inputs

Place the original customer PDFs, DXFs and sketch photos here. Keep these files private. The directory ignores inputs in Git, and the runner uses an isolated database and object store. Run only drawings approved for the configured vision provider. Standard local checks use the slotted plate fixture and measured controls in addition to the originals.

From the project root in PowerShell:

~~~powershell
.\infra\setup.ps1 start -TestStack
.\quote.cmd build
.\.venv\Scripts\python.exe tests/run_real_drawing_audit.py
~~~

Install the project's engineering requirements and pytest in the local Python environment. Chrome or Edge must be available. Set CHROME_PATH if installed in a custom location. The live audit uses the worker's existing vision configuration. Results, source checksums, CAD checks, diagnostic logs and screenshots are stored under .test-results/real-drawing-audit-*.

A correctly held drawing passes its release gate and prints the reason. A released test part must pass the DXF, PDF and CSV checks. The automated check reads printed or reviewed nominal engineering dimensions. It does not use preview pixels to establish scale.

For a historical comparison, add a file named exactly like the drawing plus .quote.json. Match part IDs to the extracted estimate and use comparable scope and before-tax prices in USD.

~~~json
{
  "selling_price_usd": "125.00",
  "selling_price_by_part_id": {"FP-101": "100.00", "FP-102": "25.00"}
}
~~~

The report computes (estimate - historical) / historical and records unmatched IDs and line variances above 10%. A held estimate has no computed variance.

Use --reuse-browser with a previous run directory to recheck the stored live extraction and artifacts without repeating vision requests. Keep the isolated database and object-store volumes between runs.

Set `LMM_REAL_ASSISTANT_AUDIT=1` to run live Ask AI checks, verify the sketch checklist and test saving an incomplete awning review. Set `LMM_REAL_INTAKE_GATE_AUDIT=1` to verify that the awning PDF can reach quote review through regular intake. Both checks use the isolated desk. The regular intake check stops at submission for review.

Set `LMM_REAL_HOME_START=1` to upload the PDF through the home-page **Start a quote** path. The case exercises the same engineering queue, inventory and checklist used by Blueprint estimates.

Use `LMM_REAL_SOURCE_SCOPE_AUDIT=1` to check printed callouts from the awning. An older replay runs **Fill from printed callouts**. The browser checks the fields and page links filled from that source and verifies that include and exclude decisions carry into a quote. Add `LMM_REAL_ASSISTANT_AUDIT=1` to exercise the live assistant.

Set `LMM_REAL_ASSEMBLY_AUDIT=1` to download the sketch draft during a replay. The first compound-sketch draft can make a live vision request, and later downloads reuse the saved schematic.
