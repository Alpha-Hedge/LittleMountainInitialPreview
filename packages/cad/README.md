# Fabrication geometry and export

Run the example from the repository root in the project Python 3.12 environment. Choose a new output directory for each release.

```sh
python -m packages.cad.dxf_compiler packages/cad/examples/slotted-bracket.json output/bracket-rev-a
python -m pytest packages/cad/tests
```

The example is a 120 × 80 mm, 6 mm thick stainless blank with a filleted perimeter, a round hole, a slot, one bend line and a dimension with explicit bilateral tolerances. It produces one DXF per part, one ANSI B shop drawing and a CSV bill of materials. The PDF and BOM give nominal part sizes. The DXF uses full-size drawing coordinates.

## Input and release contract

Use `Drawing.model_json_schema()` from `packages.cad.schema` for the version 1 JSON Schema. `compile_drawing(drawing)` in `dxf_compiler.py` returns `Artifacts(dxfs, pdf, csv, part_pages)` after all parts validate. Page numbers are one-based, and extended schedules continue on additional sheets. Every part has a unique ID, quantity, material, thickness and profile. All geometry uses the drawing's declared inch or millimeter unit. Part coordinates are Cartesian, with angles measured counterclockwise from +X. The inputs describe a flat blank. The part's thickness and the bend overlay alone do not specify a developed blank for an already folded design.

The outside profile can be a rectangle with explicit corner radius or an ordered, straight-sided polygon. Interior cuts can be dimensioned circles or round-ended slots. The compiler checks containment and tangencies using analytic distances, checks polygon crossings and material topology with Shapely, and checks written dimension values against their referenced coordinates. Every opening must lie strictly inside the outer loop, separated from the surrounding cuts. A bend line needs distinct endpoints across solid stock. Unknown units, missing release measurements, unsupported geometry and conflicting nominal dimensions fail validation. The kernel never estimates geometry from image proportions.

The CAD layers are `0_CUT_OUTER`, `1_CUT_INNER`, `2_SCRIBE_ETCH` and `3_REF_ONLY`. The first two carry closed LWPOLYLINEs. Round corners, holes and slots use circular arc bulges. Only explicit scribe lines go on the third layer. The reference layer is defined and kept free of toolpaths, dimensions and labels. The DXF includes `$INSUNITS` (1 inch, 4 mm). Every DXF is serialized, read back and audited. Its entity types, closure, units, layer assignments and exact vertices or bend coordinates are checked against the solved model before release. [ezdxf polyline reference](https://ezdxf.readthedocs.io/en/stable/dxfentities/lwpolyline.html)

The default DXF is nominal for compensation by CAM. An explicitly supplied positive `kerf_width` requests a pre-offset tool centerline for CAM with controller compensation disabled. The compiler offsets outside profiles outward and openings inward by half the width. Polygon expansion preserves analytic corner arcs and is checked against an independent Shapely offset. Collapsed openings and self-crossing or erased features block release. Use the PDF title block and BOM kerf column to identify a compensated package.

Each DXF also records `TOOLPATH_MODE`, `KERF_WIDTH` and `DIMENSION_UNIT` in its metadata. The standard header field `$USERR1` carries the kerf width. Repeated builds from the same inputs and pinned software produce byte-identical DXF, PDF and CSV files. DXF revision GUIDs derive from the input content and the internal file timestamps use a fixed build epoch. The app's release record supplies the actual approval date and time.

For concave polygons, the compiler conservatively checks exact distances between nonadjacent source edges and rejects insufficient clearance or an offset that consumes a short edge. A cutter has a finite radius at any sharp internal corner. The approved setup should address required relief and machine capability. Rectangles and cutouts use analytic clearance checks, including circles tangent between display sampling points.

The BOM includes exact nominal part area and cut length from line and circular-arc integration, kerf-adjusted toolpath length, piercing and bend counts, blank extents and units. The optional `density_kg_m3` enables per-piece and batch net mass. Missing density leaves mass blank. The area and mass exclude cutouts. All customer text fields in the CSV are protected against spreadsheet formula evaluation.

## Sheet stock planning

`plan_stock(NestRequest)` from `packages.cad.nesting` accepts the drawing plus one stock definition per material and thickness. Stock carries width, height, margin, spacing and explicit permission to rotate 90 degrees. Coordinates describe lower-left corners of bounding blanks. A single part family uses repeated rows with optional quarter-turned rows. Mixed sizes use a deterministic best-fit rectangular split. Returned sheets list placed blanks and their rotation alongside net-part yield, bounding-blank yield and unused bounding-blank area. Holes and concavities are excluded from net metal use. The planner does not place neighboring blanks inside those voids or assign salvage value.

Stock margin denotes stock outside the cut envelope. Spacing denotes web between cut envelopes. When a kerf is supplied, the model reserves one additional full kerf at the stock edge and two between nominal profiles to accommodate two separate cuts. Multiple material grades and thicknesses are segregated. A coordinate plan accepts up to 1,000 pieces. `plan_rectangular_batch(stock_width, stock_height, blank_width, blank_height, margin, gap, allow_rotation, quantity)` uses the same repeated-row layout and reports an auditable full-sheet capacity, sheet count and batch utilization for up to one billion identical blanks. Margin and gap in this batch function are the final clearances. The reported capacity is a feasible plan. Optimal true-shape nesting, lead-ins, cutting order and postprocessed machine code require a CAM process.

## Reading copies and web integration

The shop photo pipeline runs `rectify_sketch`, `parse_sketch`, `solve_sketch` and `compile_solved_sketch` in the engineering worker. OpenCV detects a page boundary when one is visible, corrects perspective and residual skew, and groups candidate exterior loops, openings and aligned dashes. The registration includes the raw-pixel-to-page homography and the image sizes. Annotation anchors use a 0–1000 page grid, with Y increasing downward. [OpenCV geometric transforms](https://docs.opencv.org/4.x/da/d54/group__imgproc__transform.html)

The vision reader binds literal inscriptions and source locations to parts, edges, openings or bend endpoints. Python converts fractions and units, solves dimension equations and checks the remaining degrees of freedom. Ink establishes connectivity, handedness and near-right angles within five degrees. Only written or staff-confirmed measurements supply physical lengths. Open or ambiguous profiles, inconsistent equations, unlocated centers and unresolved marks produce numbered review pins. The CAD datum has positive Y up.

Supported blanks include rectangles with square or consistently radiused corners, straight-sided polygons, circular through-holes, straight slots and dimensioned bend lines. Weld notes appear on the shop sheet with their feature references. General curved contours, complex internal profiles and formed views without a dimensioned flat blank require further drafting. A single failure holds the release for the whole drawing.

`reading_copy(photo_bytes, page_corners=None)` in `preprocessing.py` creates a high-contrast PNG for reading. Supplying four operator-selected page corners in clockwise order, starting at the top left, applies an OpenCV perspective transform. Coordinates refer to the EXIF-oriented photo in pixels. The result is a separate reading copy. Written nominal dimensions drive all fabrication coordinates.

`python -m packages.cad.bridge` reads one UTF-8 JSON request on stdin. Supply `draft` in the web sketch format and an optional positive integer `revision`. A successful `format: "bundle"` returns base64 `pdf`, `csv` and `dxfs`, plus `partPages`. Single-artifact formats `pdf`, `dxf` and `csv` return base64 `content`. DXF requires a zero-based `part`. The `validate` and `preview` modes use the same geometry checks. Preview returns the bounding box, contour vertices with outgoing DXF bulges, and bend lines for every part. Invalid inputs exit with status 2 and a concise diagnostic on stderr. Web release authorization and the immutable approval record are owned by the caller.
