# Drawing estimate calculations

The worker calls `calculate_cost(ast, settings)` after drawing review. Use `demo_settings()` to load the labeled [example rate card](demo_cost_settings.json). Supply a dated shop rate card when Nick has confirmed the shop’s prices. One invocation uses one explicit stock selection per material family, grade and thickness. The result includes that rate card, physical quantities, the basis of each charge and work-center rates.

## Stock and cutting

All engineering dimensions arrive in inches. The engine reconstructs the reviewed flat profile in the Phase 1 CAD kernel. It validates the external outline and every through-cut opening before costing. Stock layout uses rectangular blank envelopes, configured edge and part clearances, optional 90-degree rotation, and the compiler’s kerf width. Mixed runs use the coordinate nester up to 1,000 pieces per material group. Larger identical runs use the batch row planner. A larger mixed group needs smaller lots or a separately reviewed nest.

Net yield is finished net area divided by purchased sheet area. Scrap percentage includes holes, kerf, clearances, and unused sheet area. Full-sheet pricing assigns each cent of purchased material once across parts of the same stock by occupied blank area, with stable input order for rounding ties. The rate card prices the entire sheet at its supplier rate per pound. Remnant credits require a separately confirmed purchasing policy.

Cut length comes from the same kerf-offset lines and arcs as the DXF. Pierces count one per external contour and one per cut opening for each piece. Machine time includes path length divided by speed and the configured dwell per pierce. The programmed speed is the rate card’s estimate across the selected stock. Lead-ins, rapids and loading allowances can be reflected in the work-center efficiency factor or entered as separate allowances. Drilled holes need a shop operation estimate before this engine can price their routing.

## Forming

For bend-through angle θ in radians, inside radius R, thickness T and measured K-factor K, the neutral-axis bend allowance is θ(R + KT). The outside setback is (R + T)tan(θ/2). Bend deduction equals twice that setback minus the allowance. A reviewed flat outline is used as supplied. For an unpierced rectangle explicitly dimensioned as outside flange sums, the engine subtracts the summed deductions along the indicated development axis. More complex developed shapes require a confirmed flat profile. Every unit receives its bend cycle time. The first part of the batch using a material, angle and tool carries the setup charge. If no die ID is specified, the grouping uses the inside radius with the material and angle. Nick can provide measured tooling-specific parameters through the rate card. See [SOLIDWORKS K-factor](https://help.solidworks.com/2013/english/SolidWorks/sldworks/c_K_Factor.htm) and [SOLIDWORKS bend deductions](https://help.solidworks.com/2021/english/solidworks/sldworks/c_Bend_Allowance_and_Bend_Deduction.htm).

## Welding

The weld position is the drawing’s AWS positional designation. Each configured process and material family requires a shop-supplied deposition rate and position factor. No AWS performance rate is assumed. The example GMAW card uses illustrative values. Nick can enter separate GMAW, GTAW, FCAW and SMAW schedules.

An equal-leg fillet with leg z has area z²/2. For other seam profiles, the joint detail must supply a deposited cross-sectional area. Volume is welded length multiplied by that area, and deposited pounds are volume multiplied by filler density. Reinforcement, unequal legs, groove preparation and measured pass buildup can be reflected in the confirmed cross-sectional area. The calculation uses total deposited metal along the seam. [TWI weld volume and weight calculations](https://www.twi-global.com/technical-knowledge/job-knowledge/calculating-weld-volume-and-weight-095).

The engine counts seam repeats, welded sides and piece quantity. An intermittent callout needs stitch length and center-to-center pitch. If its span exactly contains a sequence of full stitches, the count is 1 + (span − stitch length)/pitch. Otherwise the reviewer must specify the stitch count. An explicit count must fit the span.

Purchased filler pounds are deposited pounds divided by deposition efficiency. Arc hours equal deposited pounds divided by the position-adjusted deposition rate. Loaded work-center run hours equal arc hours divided by the arc-on fraction and center efficiency. Gas volume in standard cubic feet equals configured scfh multiplied by arc hours plus start/stop flow hours. The estimate assumes a single arc start per stitch or continuous seam. The rate card specifies equivalent pre/post-flow time per start; multi-pass overhead needs a measured allowance. SMAW has zero external gas. The engine uses configured gas flow for gas-shielded FCAW and accepts zero flow for its self-shielded variant.

## Commercial calculation and review

Setup is billed once per stock for cutting, per stock/angle/tool for bending and per stock/process for welding. The first applicable part on the drawing carries the batch charge. Statement lines for run time and consumables contain the physical quantity for the full batch. Scope allowances support both per-piece and batch pricing. Each nonempty finish or additional requirement needs an allowance citing that exact requirement, including any charge Nick explicitly marks as included at zero dollars. If any part fails validation, the worker receives review issues and no totals.

Extended cost rows round half-up to cents. Gross margin is applied to the sum of rounded row costs. Selling price before tax equals cost / (1 − gross margin fraction). The Phase 1 pricing engine allocates that total to the individual lines. Historical adjustments keep the original physical inputs and can be repriced with `reprice_result(result)`. All amounts are USD. Position, cut speed, sheet use and cycle assumptions remain visible for review against actual production.
