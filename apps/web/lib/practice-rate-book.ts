import stockData from "./practice-stock.json" with {type:"json"};
import type { RateGroup, ShopRate, EstimateTemplate, TemplateOperation } from "./estimating-types";
import type { RateCategory } from "./types";

export const practiceReferences = stockData.references;
const effectiveOn = stockData.effectiveOn;
const shopBasis = "Representative U.S. practice allowance. Wage references: BLS May 2025. Includes estimated burden and overhead where listed.";
const supplierBasis = "U.S. small-order stock allowance. Online Metals retail listings are a reference point. Confirm current quotes, grade and freight.";
const demoBasis = "Little Mountain test allowance. Replace with a supplier or subcontractor quote for live work.";

function rates(group: RateGroup, category: RateCategory, source: string,
  entries: Array<[id: string, name: string, price: number, unit: string, includes: string, minimum?: number, role?: ShopRate["budgetRole"]]>): ShopRate[] {
  return entries.map(([id,name,value,unit,includes,minimumCost = 0,budgetRole]) =>
    ({id,name,value,unit,includes,minimumCost,budgetRole,group,category,source,effectiveOn,
      ...(["us-shop-weld","us-mig","us-batch-setup","us-plasma","us-saw","us-drill","us-brake"].includes(id)
        ? {hourlyCost:{wage:25.84,burden:11.07,overhead:38.09,equipment:value-75}} : {})}));
}

export const practiceRates: ShopRate[] = [
  ...stockData.stock.map(([grade,family,form,density,value]): ShopRate => {
    const id = [grade,form].join("-").toLowerCase().replaceAll(/[^a-z0-9]+/g,"-");
    return {id:"us-"+id,name:grade+" "+family+" · "+form,category:"material", group:"Stock",
      grade:String(grade),family:String(family),form:form as ShopRate["form"],density:Number(density),value:Number(value),
      unit:"lb",minimumCost:0,source:supplierBasis,effectiveOn,includes:"Raw stock by purchased weight. Freight, cutting, MTR and sales tax separate."};
  }),
  ...rates("Stock","material",demoBasis,[
    ["us-grating","Welded steel bar grating",13.5,"sq ft","Grating panel material only."],
    ["us-expanded","Flattened expanded steel",8,"sq ft","Expanded mesh panel material only."],
    ["us-perf","Perforated 304 stainless sheet",24,"sq ft","Sample perforated sheet, standard open area."],
  ]),
  ...rates("Labor","labor",shopBasis,[
    ["us-shop-weld","Shop welding and fit-up",75,"hour","Operator, payroll burden and shop overhead. Filler and gas separate.",0,"weld"],
    ["us-mig","MIG welding",75,"hour","Operator, machine and overhead. Wire and gas separate."],
    ["us-tig-steel","TIG welding · steel and stainless",95,"hour","Operator, machine and overhead. Purge gas and filler separate."],
    ["us-tig-al","TIG welding · aluminum",100,"hour","Operator, AC machine and overhead. Gas and filler separate."],
    ["us-flux","Flux-cored welding",86,"hour","Operator and machine. Wire and shielding separate."],
    ["us-stick","Stick welding",82,"hour","Operator, power source and shop overhead. Electrodes separate."],
    ["us-fit","Fit-up and assembly",75,"hour","Bench labor, layout, tacking and clamping."],
    ["us-grind","Grinding and deburring",64,"hour","Hands-on labor. Abrasives separate."],
    ["us-polish","Cosmetic blending and polishing",84,"hour","Bench labor for visible finish. Specialty abrasives separate."],
    ["us-design","Drawing, CAD and programming",100,"hour","Design detailing and programming. Outside engineering separate.",50],
    ["us-qa","Shop inspection and documentation",72,"hour","Dimensional check and inspection record. Outside NDT separate."],
    ["us-receive","Receiving and inventory handling",56,"hour","Unload, count, tag and stage material."],
  ]),
  ...rates("Labor","setup",shopBasis,[
    ["us-batch-setup","Shared job layout and setup",75,"hour","Planning, staging and simple fixture setup, once per batch.",0,"setup"],
    ["us-fixture","Complex fixture setup",90,"hour","Jig layout and alignment. Fixture material separate.",45],
  ]),
  ...rates("Machines","machine",shopBasis,[
    ["us-plasma","Plasma or blank cutting",85,"hour","Machine, operator, power and ordinary wear. Special consumables separate.",0,"blank"],
    ["us-saw","Band saw",85,"hour","Machine, operator and standard blade wear.",0,"saw"],
    ["us-drill","Drilling and tapping",85,"hour","Operator and standard drill or tap tooling.",0,"drill"],
    ["us-brake","Press brake",85,"hour","Machine, operator and standard tooling. Special dies separate.",0,"form"],
    ["us-laser","Fiber laser",155,"hour","Machine, operator and typical power. Assist gas separate.",55],
    ["us-waterjet","Waterjet",175,"hour","Machine, operator and typical abrasive.",65],
    ["us-roll","Plate or section rolling",135,"hour","Machine and operator. Tooling and special fixtures separate.",65],
    ["us-mill","CNC milling",120,"hour","Machine and operator. Programming and special tooling separate.",60],
    ["us-lathe","Manual or CNC lathe",110,"hour","Machine and operator. Special tooling separate.",55],
    ["us-shear","Sheet shearing",72,"hour","Machine and operator, standard setup."],
    ["us-punch","Punching and ironworker",95,"hour","Machine, operator and standard dies."],
  ]),
  ...rates("Consumables","material",demoBasis,[
    ["us-weld-joint","Routine weld consumables",3,"joint","Wire and shielding gas allowance. Use itemized consumables for atypical joints.",0,"consumables"],
    ["us-er70","ER70S-6 mild steel wire",4.25,"lb","MIG wire only."],
    ["us-er308","ER308L stainless filler",14,"lb","Stainless filler only."],
    ["us-er316","ER316L stainless filler",19,"lb","Stainless filler only."],
    ["us-er4043","ER4043 aluminum filler",10.5,"lb","Aluminum filler only."],
    ["us-er5356","ER5356 aluminum filler",13.2,"lb","Aluminum filler only."],
    ["us-e7018","E7018 electrodes",5.7,"lb","Stick electrodes only."],
    ["us-e71","E71T-1 flux-cored wire",6.25,"lb","Flux-cored wire only."],
    ["us-argon","Argon",0.42,"scf","Shielding or purge gas usage. Cylinder lease separate."],
    ["us-mixgas","Argon / CO₂ mix",0.34,"scf","MIG shielding gas. Cylinder lease separate."],
    ["us-oxygen","Oxygen",0.23,"scf","Shop cutting gas usage."],
    ["us-nitrogen","Nitrogen",0.30,"scf","Cutting assist gas usage."],
    ["us-disc","Flap disc",6.50,"piece","Standard abrasive disc."],
    ["us-tip","Plasma tip and electrode set",18,"set","Replacement torch parts."],
    ["us-nozzle","MIG contact tip and nozzle",9,"set","Torch wear parts."],
  ]),
  ...rates("Hardware","material",demoBasis,[
    ["us-bolt","Steel bolt, nut and washer set",2.75,"set","Sample shop fastener set. Confirm size, grade and finish."],
    ["us-ssbolt","Stainless fastener set",5,"set","Sample 300-series stainless fastener set."],
    ["us-anchor","Mechanical concrete anchor",11,"piece","Hardware allowance. Specify listed anchor and dimensions."],
    ["us-chem","Adhesive anchor kit",26,"anchor","Rod and adhesive allowance. Installation separate."],
    ["us-rod","Threaded rod",3.75,"ft","Sample carbon steel all-thread stock."],
    ["us-cap","Tube cap or plug",2.5,"piece","Purchased end cap."],
    ["us-insert","Rivet nut or threaded insert",1.4,"piece","Standard purchased insert."],
    ["us-hinge","Weld-on hinge",18,"piece","Purchased hinge only."],
  ]),
  ...rates("Finishing","outside",demoBasis,[
    ["us-blast","Abrasive blast prep",5,"sq ft","Outside blast service. Confirm cleanliness and profile.",90],
    ["us-primer","Shop primer",3.70,"sq ft","Labor and coating for ordinary primer. Blast prep separate.",40],
    ["us-paint","Industrial paint system",7.75,"sq ft","Routine liquid finish allowance. Confirm coating spec.",110],
    ["us-powder","Powder coating",6.5,"sq ft","Single standard color. Confirm prep and masking.",125],
    ["us-hdg","Hot-dip galvanizing",1.3,"lb","Outside galvanizing allowance. Freight and special handling separate.",175],
    ["us-zinc","Zinc plating",3.75,"piece","Sample batch price. Confirm zinc and passivation requirements.",150],
    ["us-anodize","Clear anodizing",8,"sq ft","Outside anodizing allowance. Confirm alloy and masking.",125],
    ["us-passivate","Stainless passivation",5.25,"sq ft","Outside cleaning and passivation per treated surface area.",125],
    ["us-electropolish","Electropolish stainless",9.5,"sq ft","Outside finish. Confirm surface and acceptance criteria.",200],
  ]),
  ...rates("Outside services","outside",demoBasis,[
    ["us-mtr","Mill test report and traceability",30,"lot","Supplier certificate and batch trace paperwork."],
    ["us-ndt-pt","Dye penetrant inspection",110,"hour","Third-party inspector allowance. Mobilization separate.",220],
    ["us-ndt-mt","Magnetic particle inspection",135,"hour","Third-party service and standard report.",270],
    ["us-ndt-ut","Ultrasonic inspection",170,"hour","Third-party service and standard report.",340],
    ["us-ndt-rt","Radiographic inspection",480,"visit","Third-party mobilization allowance. Extent and films priced by vendor."],
    ["us-pe","Outside engineering",175,"hour","Engineering design or review allowance. Confirm scope and proposal.",350],
    ["us-heat","Stress relief / heat treatment",1.85,"lb","Outside processing allowance. Testing and freight separate.",300],
    ["us-outcut","Subcontract cutting",125,"hour","Outside cutting allowance. Material and freight separate.",100],
  ]),
  ...rates("Field work","labor",shopBasis,[
    ["us-field-measure","Field measure and layout",95,"hour","One technician on site. Travel separate."],
    ["us-field-weld","Field welding labor",125,"hour","One welder and mobile rig. Consumables, helper and lift separate."],
    ["us-field-helper","Installation helper",68,"hour","One person, employer burden and overhead."],
    ["us-field-install","Field installer",108,"hour","One installer, employer burden and hand tools. Equipment separate."],
  ]),
  ...rates("Field work","outside",demoBasis,[
    ["us-mob","Site mobilization",165,"visit","Load-out, basic site prep and demobilization. Mileage separate."],
    ["us-lift","Scissor lift",260,"day","Equipment only. Delivery, pickup and fees separate."],
    ["us-crane","Crane with operator",240,"hour","Vendor crane and operator allowance. Mobilization separate.",960],
    ["us-permit","Permit and site fees",150,"job","Placeholder allowance. Verify actual fees and scope."],
  ]),
  ...rates("Freight and handling","outside",demoBasis,[
    ["us-local","Local delivery",95,"trip","One local trip. Offload and special handling separate."],
    ["us-mile","Truck mileage",1.65,"mile","Vehicle allowance. Driver time billed separately if needed."],
    ["us-ltl","Common-carrier freight",225,"shipment","Sample domestic LTL allowance. Confirm distance, class and weight."],
    ["us-pallet","Pallet and wrap",42,"pallet","Packing supplies and routine handling."],
    ["us-crate","Custom export crate",240,"crate","Sample fitted crate allowance. Confirm certification requirements."],
    ["us-shop-min","Small job intake and handling",60,"job","Optional batch charge for intake and handling. Apply only when required."],
  ]),
];

function job(id: string, name: string, assumption: string, steps: Array<[label:string,rateId:string,amount:number,basis:TemplateOperation["basis"],driver?:TemplateOperation["driver"]]>): EstimateTemplate {
  return {id,name,workType:name,assumption,operations:steps.map(([label,rateId,amount,basis,driver="fixed"],i) =>
    ({id:id+"-"+(i+1),label,rateId,amount,basis,driver,assumption:"Editable practice allowance. Check the measurement and shop time."}))};
}
const setup: [string,string,number,"batch"] = ["Layout and setup","us-batch-setup",.5,"batch"];
export const practiceTemplates = [
  job("us-a36-cut","A36 plate · cut and deburr","Use purchased pounds per piece from verified blank dimensions.",[setup,["A36 plate stock","us-a36-sheet-plate",1,"per_unit"],["Plasma cut","us-plasma",.12,"per_unit"],["Deburr","us-grind",.08,"per_unit"]]),
  job("us-tube-frame","Steel tube frame","Confirm supplier weight, lengths and number of joints.",[setup,["A500 Grade B tubing","us-a500-gr-b-tube-pipe",1,"per_unit"],["Saw cut","us-saw",.1,"per_unit"],["Fit up and weld","us-shop-weld",.5,"per_unit"],["Routine filler and gas","us-weld-joint",4,"per_unit"]]),
  job("us-formed","Formed cold-rolled sheet","Confirm the developed blank and press brake tooling.",[setup,["A1008 sheet","us-a1008-sheet-plate",1,"per_unit"],["Blank cut","us-plasma",.12,"per_unit"],["Press brake","us-brake",.16,"per_unit"]]),
  job("us-holes","Drill and tap pattern","Three minutes per written hole. Update for threads or special tooling.",[setup,["Drill and tap","us-drill",.05,"per_unit","holes"]]),
  job("us-ss-weld","304 stainless TIG assembly","Confirm grade, finish and purge need.",[setup,["304 sheet","us-304-sheet-plate",1,"per_unit"],["TIG weld","us-tig-steel",.45,"per_unit"],["Stainless filler","us-er308",.15,"per_unit"],["Argon","us-argon",12,"per_unit"]]),
  job("us-aluminum","5052 aluminum enclosure","Confirm alloy and trim. Use confirmed outside enclosure dimensions.",[setup,["5052 sheet","us-5052-h32-sheet-plate",1,"per_unit"],["Brake forming","us-brake",.24,"per_unit"],["TIG weld","us-tig-al",.45,"per_unit"],["Aluminum filler","us-er5356",.15,"per_unit"]]),
  job("us-rail","Railing · shop fabrication","Enter stock weight or add stock prices. Site work and finish are separate allowances.",[setup,["Saw","us-saw",.18,"per_unit"],["Fit and weld","us-shop-weld",.85,"per_unit"],["Finish grind","us-grind",.35,"per_unit"]]),
  job("us-field","Field measure and installation","Confirm crew, access and equipment. Rates are per person or equipment as indicated.",[["Site measure","us-field-measure",1,"batch"],["Mobilize","us-mob",1,"batch"],["Installer","us-field-install",3,"batch"],["Helper","us-field-helper",3,"batch"]]),
  job("us-powder-kit","Powder coating batch","Update square feet to the finish vendor’s measured surface area.",[["Powder coating","us-powder",1,"batch"],["Delivery","us-local",1,"batch"]]),
  job("us-galv-kit","Galvanized assembly batch","Update pounds to the vendor’s billable weight.",[["Hot-dip galvanizing","us-hdg",1,"batch"],["Pallet and wrap","us-pallet",1,"batch"],["Delivery","us-local",1,"batch"]]),
  job("us-qa-kit","Traceable and inspected assembly","Confirm the specific testing method and inspection extent.",[["Mill test reports","us-mtr",1,"batch"],["Dimensional inspection","us-qa",1,"batch"],["Outside dye penetrant test","us-ndt-pt",2,"batch"]]),
  job("us-ship-kit","Pack and deliver","Use the selected carrier's current freight and packaging allowance.",[["Pallet and wrap","us-pallet",1,"batch"],["LTL shipment","us-ltl",1,"batch"]]),
];
