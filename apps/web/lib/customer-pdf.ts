import { workspaceRoot } from "./workspace-root";
import PDFDocument from "pdfkit";
import path from "node:path";
import type {CustomerQuote} from "./workflow-types";

const ink = "#193c31", muted = "#53675c", dark = "#26362e";
const money = (value:number) => value.toLocaleString("en-US",{style:"currency",currency:"USD"});

// Accept only the public projection of the approved quote.
export async function renderCustomerPdf(quote:CustomerQuote):Promise<Buffer> {
  const doc = new PDFDocument({size:"LETTER",margins:{top:100,left:48,right:48,bottom:66},bufferPages:true,autoFirstPage:false,
    info:{Title:quote.quoteNumber + " · " + quote.jobName,Author:"Little Mountain Metalworks"}});
  const chunks:Buffer[] = [];
  const result = new Promise<Buffer>((resolve,reject) => {
    doc.on("data",chunk=>chunks.push(chunk)); doc.on("error",reject); doc.on("end",()=>resolve(Buffer.concat(chunks)));
  });
  // The PDF.js package ships embeddable TrueType fonts with its own license.
  const fonts = path.join(workspaceRoot(),"node_modules","pdfjs-dist","standard_fonts");
  doc.registerFont("Body",path.join(fonts,"LiberationSans-Regular.ttf"));
  doc.registerFont("Display",path.join(fonts,"LiberationSans-Bold.ttf"));
  const left=48, width=516, right=564, bottom=726;
  function addPage() {
    doc.addPage({margins:{top:100,left,right:48,bottom:66}});
    doc.save().rect(0,0,612,73).fill(ink);
    doc.lineWidth(1.8).strokeColor("#c3dcaa").moveTo(48,45).lineTo(60,23).lineTo(67,34)
      .lineTo(73,26).lineTo(85,45).closePath().stroke().restore();
    doc.font("Display").fontSize(19).fillColor("#ffffff").text("Little Mountain Metalworks",98,24,{lineBreak:false});
    doc.font("Body").fontSize(9).fillColor("#e4efe2").text("CUSTOMER QUOTE",421,30,{align:"right",width:143,lineBreak:false});
    doc.x=left;doc.y=98;
  }
  function space(points:number) { if(doc.y+points>bottom) addPage(); }
  function section(title:string,body:string) {
    space(52);
    doc.font("Display").fontSize(14).fillColor(ink).text(title,left,doc.y,{width});
    doc.moveDown(.15).font("Body").fontSize(10).fillColor(dark).text(body,left,doc.y,{width,lineGap:2});
    doc.moveDown(.85);
  }
  // PDFKit may add a continuation page when a single description or scope is very long.
  // Its text flows inside the same top/bottom margins. Footer and continuation branding
  // are stamped below after all page breaks have been resolved.
  addPage();
  doc.font("Body").fontSize(10).fillColor(muted).text(quote.quoteNumber+"  /  Version "+quote.version,left,doc.y,{width});
  doc.moveDown(.15).font("Display").fontSize(28).fillColor(ink).text(quote.jobName,left,doc.y,{width});
  doc.moveDown(.35).font("Body").fontSize(11).fillColor(dark).text("Prepared for "+quote.customer,left,doc.y,{width});
  doc.moveDown(.35).fontSize(9).fillColor(muted).text("Issued "+quote.issuedOn+"     •     Valid through "+quote.expiresOn,left,doc.y,{width});
  doc.moveDown(1.25);
  section("Scope of work",quote.scope);
  space(64);
  function tableHead() {
    const y=doc.y;
    doc.rect(left,y,width,23).fill("#e8efe6");
    doc.font("Display").fontSize(10).fillColor(ink)
      .text("Description",left+8,y+5,{width:316,lineBreak:false})
      .text("Qty",401,y+5,{width:43,align:"right",lineBreak:false})
      .text("Line price",455,y+5,{width:101,align:"right",lineBreak:false});
    doc.x=left;doc.y=y+23;
  }
  tableHead();
  for(const line of quote.lines){
    doc.font("Body").fontSize(10);
    const height=doc.heightOfString(line.description,{width:337,lineGap:2})+18;
    if(doc.y+Math.min(height,130)>bottom){addPage();tableHead();}
    const y=doc.y+8;
    doc.font("Body").fontSize(10).fillColor(dark)
      .text(String(line.quantity),392,y,{width:52,align:"right",lineBreak:false})
      .text(money(line.sellingPrice),448,y,{width:108,align:"right",lineBreak:false})
      .text(line.description,left+8,y,{width:337,lineGap:2});
    const end=doc.y+8;
    doc.moveTo(left,end).lineTo(right,end).lineWidth(.5).strokeColor("#d6ded5").stroke();doc.x=left;doc.y=end;
  }
  space(65);
  const y=doc.y+6;
  doc.rect(left,y,width,40).fill("#dce9d7").font("Display").fontSize(15).fillColor(ink)
    .text("Total before tax",left+10,y+10,{width:220,lineBreak:false})
    .text(money(quote.sellingPrice),287,y+8,{width:265,align:"right",lineBreak:false});
  doc.x=left;doc.y=y+55;
  section("Lead time",quote.leadTime);
  section("Terms",quote.terms);
  const {count}=doc.bufferedPageRange();
  for(let i=0;i<count;i++){
    doc.switchToPage(i);
    if(i>0){
      doc.rect(0,0,612,73).fill(ink).font("Display").fontSize(17).fillColor("#ffffff")
        .text("Little Mountain Metalworks",left,24,{lineBreak:false});
    }
    doc.page.margins.bottom=0;
    doc.moveTo(left,744).lineTo(right,744).strokeColor("#bdcbbb").lineWidth(.5).stroke();
    doc.font("Body").fontSize(8).fillColor(muted).text(quote.quoteNumber+"  /  Version "+quote.version,left,751,{lineBreak:false})
      .text("Page "+(i+1)+" of "+count,412,751,{width:152,align:"right",lineBreak:false});
  }
  doc.end();
  return result;
}
