import WorkspaceShell from "@/components/WorkspaceShell";
import { Icon } from "@/components/Icons";
import "../quote-desk.css";
import "./guide.css";

export const metadata = { title: "Quick guide | Little Mountain Metalworks" };
export default function QuickGuide() {
  return (
    <WorkspaceShell active="help" breadcrumbs={[{ label: "Quick guide" }]}>
      <div className="guide-layout">
        <header className="guide-heading">
          <span className="guide-book">
            <Icon name="book" size={27} />
          </span>
          <div>
            <h1>Quick guide</h1>
            <p>Follow these steps the first time you make a quote.</p>
          </div>
        </header>
        <section className="panel guide-steps" aria-label="Make a quote">
          <ol>
            <li>
              <span>1</span>
              <div>
                <h2>Add a drawing</h2>
                <p>
                  Choose <strong>Start a quote</strong>, pick the PDF or photo,
                  and click <strong>Read drawing &amp; start quote</strong>.
                  Paste the order email in <strong>Customer notes</strong> if
                  you have it. You can add the customer name later.
                </p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <h2>Check the job details</h2>
                <p>
                  In <strong>Quote setup</strong>, decide what your shop will supply and install.
                  Add any missing order quantities and specs. Use <strong>Check the drawing</strong>{" "}
                  to compare uncertain readings with the original. If you’re waiting on an answer,
                  choose <strong>Open quote draft</strong>.
                </p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <h2>Price the job</h2>
                <p>
                  Choose <strong>Plan costs with AI</strong> on a prepared
                  quote, or price the work with a shop template or by hand.
                  Check the amounts and rates, add outside work or delivery,
                  then save the costs.
                </p>
              </div>
            </li>
            <li>
              <span>4</span>
              <div>
                <h2>Check the price and get the PDF</h2>
                <p>
                  Open the quote review. Enter the customer name, confirm the
                  work, lead time and terms, and approve the quote. Then choose{" "}
                  <strong>Open customer PDF</strong> to view, print or share it.
                </p>
              </div>
            </li>
          </ol>
          <div className="guide-start">
            <a className="desk-start" href="/quotes/new">
              <Icon name="plus" />
              Start a quote
            </a>
            <a href="/">
              Find a saved quote <Icon name="arrow" size={16} />
            </a>
          </div>
        </section>
        <section className="guide-questions">
          <h2>Common questions</h2>
          <details>
            <summary>Where should I start with a blueprint?</summary>
            <p>Choose <strong>Start a quote</strong> on the Quote desk to price a job. Open <a href="/blueprints">Drawing reviews</a> to return to a saved blueprint or add a revision. Use <a href="/sketches">Sketch to drawing</a> when you want a drawing sheet or cut files from a hand sketch.</p>
          </details>
          <details>
            <summary>How do I tell the AI what to change?</summary>
            <p>On a saved quote or drawing review, open <strong>Ask AI</strong>. Type “Set labor to two hours” or choose <strong>Use microphone</strong> and say it. Send the instruction, check the suggested changes, choose <strong>Apply suggested changes</strong>, then save the review.</p>
            <p>Type a question and press Enter to send. Shift+Enter starts a new line. Choose <strong>Check the drawing</strong> or <strong>Check the sketch</strong> to look for missed details. In a quote, <strong>Plan the work</strong> suggests costs based on shop rates and supported allowances. Review what it proposes and check the short list of costs that still need an answer.</p>
          </details>
          <details>
            <summary>How do I check a drawing and adjust the price?</summary>
            <p>Open the saved quote and choose <strong>Drawing &amp; quote workspace</strong>.
              Click a numbered measurement to see where it came from. Choose <strong>Edit drawing measurements</strong> to change it.
              Beside the drawing, enter the hours or cost the shop expects and a short reason. Mark a one-time exception if it applies only to this job.</p>
            <p>Choose <strong>Save pricing revision</strong>, then <strong>Review scope and approve</strong>.
              The customer proposal and internal shop traveler are available under <strong>Quote documents</strong>.</p>
          </details>
          <details>
            <summary>How do I turn a hand sketch into a drawing?</summary>
            <p>
              Write the dimensions, units, material, thickness, and quantity on the sketch. Open{" "}
              <a href="/sketches">Sketch to drawing</a> and upload a clear photo. Open <strong>Drawing sheet</strong> to make or download the illustrated PDF.
              In <strong>Review measurements</strong>, check the dimensions against the original and save your corrections.
              Once confirmed, <strong>Shop files</strong> has the shop PDF, full-size DXFs and cut list.
            </p>
          </details>
          <details>
            <summary>What are the numbers on the sketch preview?</summary>
            <p>The handwritten numbers are measurements. Type them exactly as written, such as 2 1/2. Choose <strong>Show check markers on photo</strong> to put a number next to each question, or select <strong>View on photo</strong> to find one spot. The optional AI preview shows what the app read.</p>
          </details>
          <details>
            <summary>Can I upload just a PDF?</summary>
            <p>
              Yes. The app can start a draft and read the drawing. Before making
              a customer PDF, check the order quantity and specs, enter or
              confirm the costs, and fill in the customer, delivery timing, and
              terms. For a job with no drawing, choose{" "}
              <strong>Start without a drawing</strong>.
            </p>
          </details>
          <details>
            <summary>Where do the prices and hours come from?</summary>
            <p>
              Nick enters material prices and the shop’s hourly cost in{" "}
              <strong>Shop settings</strong>. Materials cost the amount used
              times the price per sheet, pound, foot, or other unit. Labor costs
              the time times the shop’s hourly cost for that kind of work.
              Templates and comparable finished jobs suggest time you can edit.
              The app uses the quote’s target margin to calculate the customer
              price.
            </p>
            <p>
              The supplied prices are for practice. Enter the shop’s own rates,
              usual times, and minimums before quoting real jobs.{" "}
              <a href="/settings#shop-prices">Open Shop settings</a>
            </p>
          </details>
          <details>
            <summary>When do I choose a cost for each piece?</summary>
            <p>
              If every part needs an $8 blank, choose the per-piece option and
              enter $8 for one blank. With 10 parts, the shop cost is $80. If
              setup takes 1½ hours for the whole order, choose the whole-batch
              option and enter 1.5 hours. The app counts setup once.
            </p>
          </details>
          <details>
            <summary>How do I come back to a quote?</summary>
            <p>
              Save your changes. Next time, open the <a href="/">Quote desk</a>,
              type the job name or customer in the search box and choose{" "}
              <strong>Open</strong>.
            </p>
          </details>
          <details>
            <summary>Where do I put a drawing or a newer copy?</summary>
            <p>
              Open the customer’s quote and find <strong>Drawings</strong>.
              Choose <strong>Add drawing</strong>. For an updated copy, choose
              the existing drawing when adding the file. You can open older
              copies and choose which one to quote.
            </p>
          </details>
          <details>
            <summary>Does approving a quote email the customer?</summary>
            <p>
              Approval creates the customer PDF. You can download it and share
              it yourself. If the shop has connected its email account, you can
              also send it from <a href="/inbox">Customer emails</a>.
            </p>
          </details>
          <details>
            <summary>Where do I put the hours after the job is done?</summary>
            <p>
              Open <a href="/jobs">Finished jobs</a> and choose the job. Enter
              the hours and costs for the work that was done, then save. Those
              records help price similar jobs later.
            </p>
          </details>
        </section>
      </div>
    </WorkspaceShell>
  );
}
