# Engineering services

Phase 1 adds a private PostgreSQL 16 ledger, Redis-backed Celery worker, versioned MinIO bucket and FastAPI service. Each Compose deployment owns one shop and one set of volumes. The existing quote desk can publish immutable approved versions into the ledger.

## Start on Windows

With Docker Desktop running, execute these from the repository root in PowerShell.

```powershell
.\infra\setup.ps1 start
.\infra\setup.ps1 status
Invoke-RestMethod http://127.0.0.1:8140/health/ready
```

The script uses the native Docker CLI or Ubuntu-24.04 in WSL. It creates an owner-readable `.env.nfip` once, builds the API and MinIO images, applies Alembic migrations, creates the versioned bucket, then waits for healthy services. Repeating the command reuses credentials and volumes. The first build downloads Go modules and compiles the pinned MinIO source. Docker BuildKit and network access are required. On Linux, PowerShell 7 can run the same setup with the native Docker CLI.

Open [API documentation](http://127.0.0.1:8140/docs) for the schemas. The host port binds to loopback. Postgres, Redis and the MinIO endpoints have no published host ports. The API and worker use restricted object credentials and the API uses a read/append PostgreSQL login. `NFIP_API_TOKEN` authenticates trusted servers. This setup serves a single shop over the local workstation. To serve clients remotely, use a TLS gateway with named staff identities, authorization and perimeter controls.

## Data and versioning

- PostgreSQL keeps immutable quote and line revisions keyed by quote number and revision. Each line includes the original AI proposal when applicable, the approved work, confidence when known, evidence references, and the reason for an override. Manually entered lines retain null AI values. A matching retry returns the same ID. Conflicting writes to an existing revision return HTTP 409.
- Work centers and supplier prices have effective dates, explicit units and coverage. New rates append dated rows. The catalog accepts an as-of date. Quote revision records freeze the inputs from the shop desk.
- Drawings keep the exact S3 object version and SHA-256 digest. Uploading a different file under an existing drawing revision gives HTTP 409. A Celery checksum job reads the stored version and verifies it against the original digest.
- Alembic owns the database schema. Under Compose, `migrate` runs with the database owner and grants the service login only the required table permissions. The models and frozen migration are under `apps/api`.
- Preserve the generated settings, PostgreSQL volume and object volume together when backing up. Redis persists queued tasks. Use `.\infra\setup.ps1 stop` for a non-destructive shutdown. The stack never connects to a hosted database by default.

## Service contract

### Phone sketch conversion

The authenticated `POST /drawings/from-sketch` accepts a photo or single-page PDF scan as multipart field `file` or a raw body with `?filename=plate.png`. An optional `Idempotency-Key` protects retrying an upload. A complete, sufficiently confident drawing returns its immutable release and file links in the same request. A blocked drawing returns `needs_review` with located warnings. Use `review_first=true` to require an operator confirmation on every release. The shop screen sets this option.

```powershell
# Run on the shop workstation with its private engineering settings.
$shop = Get-Content -LiteralPath .env.nfip | ConvertFrom-StringData
curl.exe -sS -H "Authorization: Bearer $($shop.NFIP_API_TOKEN)" -F "file=@fixtures/sketches/slotted-mounting-plate.png" "$($shop.NFIP_API_URL)/drawings/from-sketch"
```

The default wait is 210 seconds. `wait_seconds=0` returns a job receipt immediately. A pending response uses HTTP 202 with a `Location` and `Retry-After`. Poll the location with the same server credential.

| Method and path | Purpose |
| --- | --- |
| `GET /drawings/from-sketch/{id}?version=N` | Read the mapped handwriting, its source anchors, warning pins, solved geometry, history and available file links. Omitting the version selects the latest revision. |
| `GET /drawings/from-sketch/{id}/preview/page` or `/preview/overlay` | View the rectified source or the numbered features. The original bytes are available at the receipt's `source_url`. |
| `POST /drawings/from-sketch/{id}/review` | Submit the displayed `version`, edited `reading`, `review_note`, `confirmed` and the list of individually `verified` confidence keys. Corrections run the solver against the recorded image evidence. A competing edit to the same revision returns HTTP 409. |
| `POST /drawings/from-sketch/{id}/draft` | Build a technical review PDF from the submitted reading and available assembly plan. |
| `POST /drawings/from-sketch/{id}/visual?version=N` | Start or reuse a concept drawing for the saved sketch revision. Add `redo=true` to request a new illustration. |
| `GET /drawings/from-sketch/{id}/visual?version=N` | Poll the drawing job. When ready, open `/visual/image?version=N` or `/visual/pdf?version=N` for the saved sheet. |
| `GET /drawings/from-sketch/{id}/files/{N}/{name}` | Download an issued DXF, PDF or CSV from its exact object version. The receipt includes SHA-256 for each file. |
| `POST /drawings/from-sketch/{id}/retry?version=N` | Retry an interrupted processing attempt using the saved photo and any completed extraction. |

PostgreSQL owns the revision and the published manifest. MinIO stores the original, reading copies and generated artifacts in a private, versioned bucket. Use `.\quote.cmd exec node scripts/verify-photo-release.mjs` after building the web app and starting the isolated test stack to exercise the live provider, browser corrections and quote handoff.

### Engineering records

Use `Authorization: Bearer <server credential>` for all `/v1` calls. Keep the token on the server.

| Method and path | Purpose |
| --- | --- |
| `GET /health/ready` | Verify the expected schema, Redis and the private bucket. |
| `POST /v1/quote-versions` | Append an approved revision with all line-level audit data. First write returns 201, matching retries return 200. |
| `GET /v1/quotes/{quote_number}/versions/{revision}` | Retrieve the frozen revision, including its cost inputs and ordered lines. |
| `POST /v1/drawings` | Upload the original as the raw request body with queries `source_type`, `drawing_key`, `revision`, `filename` and the original Content-Type. Limit is 20 MiB. |
| `GET /v1/drawings/{id}`, `GET /v1/drawings/{id}/source` | Read metadata or download the checksum-verified original version. |
| `POST /v1/drawings/{id}/verify`, `GET /v1/jobs/{job_id}` | Run an independent object checksum through Redis and the worker, then read its result. |
| `GET /v1/catalog?as_of=YYYY-MM-DD` | Load work-center and material prices effective on the requested date, plus currently approved rules. |
| `POST /v1/catalog/work-centers`, `POST /v1/catalog/materials` | Add an effective-dated work-center rate or material price. |
| `POST /v1/cad/compile` | Send a reviewed canonical drawing AST with `X-Geometry-Review: confirmed`. Returns a ZIP containing a DXF per part, shop PDF and BOM. |
| `POST /v1/cad/nest` | Send a dimensioned drawing and a list of matching stock sizes for a deterministic stock plan. |
| `POST /v1/desk/routing`, `POST /v1/desk/sketch` | Use the same Python work-center and sketch functions as the local desktop. The service keeps both kernels loaded, limits concurrent desktop calculations to two, and requires a positive reviewed revision for exports. |
| `POST /v1/blueprints/drawings` | Store raw PDF or DXF bytes with filename, drawing_key and positive revision query parameters. The response identifies the immutable source. |
| `GET /v1/blueprints/drawings/{id}/preview?page=1` | Render the original PDF page or native DXF contours for staff review. The response includes the source page count. |
| `POST /v1/blueprints/jobs` | Supply drawing_id and a unique request_key. Optional notes, customer_name, job_name and a complete settings card are documented in OpenAPI. The worker reads the exact file version and prices supported work. A replay returns the existing job. |
| `GET /v1/blueprints/jobs`, `GET /v1/blueprints/jobs/{id}` | List recent jobs or open the extraction, review flags, corrections, frozen rates, charges and citations. |
| `POST /v1/blueprints/jobs/{id}/review`, `POST /v1/blueprints/jobs/{id}/retry` | Review a complete corrected AST and named uncertain features, or retry a failed attempt. Both commands require the displayed version. |
| `GET /v1/blueprints/settings` | Obtain the example cost card. A job can supply a shop-specific card and records the exact inputs it uses. |
| `GET/POST /v1/catalog/nick-rules`, `GET /v1/catalog/nick-rules/{key}/versions`, `POST /v1/catalog/nick-rules/{key}/retire` | Manage effective-dated rule revisions, approval and retirement with optimistic concurrency. |

The setup script reads the private workstation environment. The worker receives the vision credentials. With OpenAI, the selected drawing pages or rendered DXF and notes are sent for extraction. Complex sketches use GPT-6.2 Astra for the assembly layout, configurable with `SKETCH_ASSEMBLY_MODEL`. The optional presentation image sends the sketch and available approved part geometry to `SKETCH_VISUAL_MODEL` (GPT-Image-2.6 Sunburst by default). If using a local vision server, set `VISION_BASE_URL` to a worker-reachable address. Restart the stack after changing worker credentials or model settings.

Approved lines are indexed locally during archival and migration. The default 1,536-value index uses signed term and word-pair hashing with shop synonyms. SQL selects eligible material families, process sets and per-piece weights between half and twice the target weight. pgvector ranks the latest eligible approved revision of each quote as of the estimate date. At most five distinct quotes are returned. Approved rules can adjust a quantity in a cost row or set a quote-wide margin. The deterministic engine recalculates the resulting dollars. For provider-generated embeddings set `NFIP_EMBEDDING_PROVIDER=openai` in the private stack settings and restart. To index historical lines ahead of time, run `python -m packages.ai.quote_rag index` inside the worker container.

The launcher maintains separate test credentials and volumes. Run the following to verify the real integration against the test stack on loopback port 8141.

```powershell
.\infra\setup.ps1 start -TestStack
.\infra\setup.ps1 verify -TestStack
.\infra\setup.ps1 stop -TestStack
```

The integration test uses the real database, worker, object store and CAD compiler. Re-run it after a stop/start to verify drawings, quote revisions and rates survive. Use `docker compose --env-file .env.nfip run --rm migrate alembic check` to compare the migrated schema to SQLAlchemy. Run migration downgrades only on disposable databases.

The [pgvector project](https://github.com/pgvector/pgvector), [MinIO source](https://github.com/minio/minio/tree/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a), and [SQLAlchemy async documentation](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html) describe the underlying services.

