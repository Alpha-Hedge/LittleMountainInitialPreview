import type { ReactNode } from "react";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import ConfirmQuoteEmail from "@/components/ConfirmQuoteEmail";
import { mailDb, testRecipient } from "@/lib/email/store";
import { gmailSettings } from "@/lib/email/gmail";
import { listQuotes } from "@/lib/quotes";
import { getWorkflowStatus, listApprovedVersions } from "@/lib/workflow";
import "../workspace-pages.css";
import "./inbox.css";

export const dynamic = "force-dynamic";
function MailForm({
  action,
  id,
  version,
  children,
  upload = false,
}: {
  action: string;
  id?: string;
  version?: number;
  children: ReactNode;
  upload?: boolean;
}) {
  return (
    <form
      action="/api/inbox"
      method="post"
      encType={upload ? "multipart/form-data" : undefined}
      className="mail-form"
    >
      <input type="hidden" name="action" value={action} />
      <input type="hidden" name="quoteId" value={id ?? ""} />
      <input type="hidden" name="version" value={version ?? ""} />
      {children}
    </form>
  );
}
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{title}</h2>
      </div>
      <div className="mail-panel">{children}</div>
    </section>
  );
}
function Button({ children, primary = false }: { children: ReactNode; primary?: boolean }) {
  return (
    <button className={"button " + (primary ? "primary" : "secondary")} type="submit">
      {children}
    </button>
  );
}

export default async function Inbox({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const db = mailDb(),
    account = gmailSettings(),
    quotes = listQuotes();
  const quote =
    typeof query.quoteId === "string" ? quotes.find((q) => q.id === query.quoteId) : undefined;
  const id = quote?.id ?? "";
  const threads = db
    .prepare(
      `WITH recent AS (
    SELECT *,row_number() OVER (PARTITION BY quote_id ORDER BY sent_at DESC,rowid DESC) AS position,
    count(*) OVER (PARTITION BY quote_id) AS total FROM mail_messages)
    SELECT quote_id,sender,sender_name,subject,sent_at,total FROM recent WHERE position=1 ORDER BY sent_at DESC`,
    )
    .all();
  const messages = quote
    ? db
        .prepare(
          "SELECT id,rfc_id,thread_id,sender,sender_name,reply_to,subject,substr(body,1,3000) AS body,sent_at FROM mail_messages WHERE quote_id=? ORDER BY sent_at DESC,rowid DESC",
        )
        .all(id)
    : [];
  const versions = id ? listApprovedVersions(id) : [];
  const version = versions.includes(Number(query.version)) ? Number(query.version) : versions[0];
  const eligible = Boolean(
    version && quote?.version === version && getWorkflowStatus(id, version) === "approved",
  );
  const deliveries = quote
    ? db
        .prepare(
          "SELECT channel,recipient,sender,status,receipt,version,detail FROM mail_outbox WHERE quote_id=? ORDER BY updated DESC",
        )
        .all(id)
    : [];
  const draft = quote
    ? db.prepare("SELECT body FROM mail_clarifications WHERE quote_id=?").get(id)
    : null;
  const notice =
    typeof query.error === "string" ? query.error : typeof query.notice === "string" ? query.notice : "";
  const focusSend = !!quote && !!query.version;
  const formOpen = (
    <form action="/inbox" className="mail-form">
      <label>
        Job
        <select required name="quoteId" defaultValue={id || ""}>
          <option value="" disabled>
            Choose a job
          </option>
          {quotes.map((q) => (
            <option key={q.id} value={q.id}>
              {q.jobName} · {q.customer} · {q.number}
            </option>
          ))}
        </select>
      </label>
      <Button>Open job messages</Button>
    </form>
  );
  const upload = (
    <MailForm action="upload" upload>
      <label>
        Choose a saved email (.eml)
        <input type="file" name="file" accept=".eml,message/rfc822" required />
      </label>
      <Button primary>Add email</Button>
    </MailForm>
  );
  const importTools = (
    <details className="panel mail-fold">
      <summary>Add an email file</summary>
      <div className="mail-panel">
        <p>
          In Gmail, open the message and choose <b>More → Download message</b>. Add that file here to
          keep the message and its drawings with the job.
        </p>
        {upload}
        <details>
          <summary>Try a sample email</summary>
          <div className="mail-samples">
            <MailForm action="sample">
              <Button>Add sample request</Button>
            </MailForm>
            <MailForm action="revision">
              <Button>Add sample drawing change</Button>
            </MailForm>
          </div>
        </details>
      </div>
    </details>
  );
  const setup = (
    <details id="setup" className="panel mail-fold">
      <summary>Set up Gmail for a client</summary>
      <div className="mail-panel">
        <p>
          Optional shop setup. The rest of the quote can be completed before connecting an email account.
        </p>
        {account.sender && (
          <p>
            Connected to <b>{account.sender}</b>
          </p>
        )}
        {account.configured && (
          <a className="button secondary" href="/api/inbox/gmail/connect">
            {account.sender ? "Reconnect Gmail" : "Connect Gmail"}
          </a>
        )}
        {account.sender && (
          <MailForm action="selectLabel">
            <label>
              Gmail label for quotes
              <input name="label" defaultValue={account.label} required placeholder="Quoting" />
            </label>
            <Button>Save label</Button>
          </MailForm>
        )}
        <ol>
          <li>
            Enable the Gmail API in the client’s Google Cloud project and create a Web application OAuth
            client. Follow Google’s consent setup for the sender.
          </li>
          <li>
            Register <code>{account.redirectUri}</code> as the redirect address.
          </li>
          <li>
            Set <code>LMM_GMAIL_CLIENT_ID</code> and <code>LMM_GMAIL_CLIENT_SECRET</code> in the server’s{" "}
            <code>.env.local</code> and restart.
          </li>
          <li>
            Connect the sender here. Choose an existing Gmail label and apply it to quoting messages and
            replies.
          </li>
        </ol>
      </div>
    </details>
  );
  const delivery = quote && (
    <Panel title="Share the approved quote">
      {version ? (
        <>
          <p>
            <strong>
              {quote.customer} · {quote.number} · Version {version}
            </strong>
          </p>
          <div className="mail-links">
            <a
              className={"button " + (account.sender ? "secondary" : "primary")}
              href={"/api/quotes/" + id + "/approval/pdf?version=" + version}
              target="_blank"
              rel="noreferrer"
            >
              Open customer PDF
            </a>
            <a href={"/quotes/" + id + "/approval?version=" + version}>See approved quote</a>
          </div>
          {eligible &&
            account.sender &&
            !deliveries.some((d) => d.version === version && d.channel === "gmail") && (
              <ConfirmQuoteEmail
                id={id}
                version={version}
                number={quote.number}
                customer={quote.customer}
                sender={account.sender}
                replyTo={String(messages[0]?.reply_to ?? "")}
              />
            )}
          {eligible && !account.sender && (
            <p>
              Download the customer PDF to attach it to your own email. Gmail can be connected later.
            </p>
          )}
          {eligible && !deliveries.some((d) => d.version === version && d.channel === "test") && (
            <details>
              <summary>Try a practice send</summary>
              <div className="mail-inner">
                <p>Only the practice mailbox receives this copy.</p>
                <MailForm action="send" id={id} version={version}>
                  <input type="hidden" name="channel" value="test" />
                  <Button>Send to practice mailbox</Button>
                </MailForm>
                <small>{testRecipient}</small>
              </div>
            </details>
          )}
          {versions.length > 1 && (
            <details>
              <summary>Open an earlier approved copy</summary>
              <form action="/inbox" className="mail-form">
                <input type="hidden" name="quoteId" value={id} />
                <label>
                  Saved copy
                  <select name="version" defaultValue={version}>
                    {versions.map((v) => (
                      <option value={v} key={v}>
                        Version {v}
                      </option>
                    ))}
                  </select>
                </label>
                <Button>Open copy</Button>
              </form>
            </details>
          )}
        </>
      ) : (
        <>
          <p>Nick needs to approve this quote before there is a customer PDF to share.</p>
          <a className="button secondary" href={"/quotes/" + id + "/approval"}>
            Prepare customer quote
          </a>
        </>
      )}
      {deliveries.map((d) => (
        <div className="mail-delivery" key={String(d.version) + String(d.channel)}>
          <b>
            {d.channel === "test" ? "Practice mailbox" : "Customer email"} · Version {Number(d.version)}
          </b>
          <p>
            {d.status === "sent"
              ? d.channel === "test"
                ? "Practice copy saved"
                : "Accepted by Gmail"
              : "Waiting for delivery confirmation"}{" "}
            · {String(d.recipient)}
          </p>
          {d.receipt ? (
            <details>
              <summary>Delivery details</summary>
              <div className="mail-inner">
                <span>From {String(d.sender)}</span>
                <small>Receipt {String(d.receipt)}</small>
                {d.channel === "test" && (
                  <a href={"/api/inbox/files/" + d.receipt + "?kind=capture"}>Download practice email</a>
                )}
              </div>
            </details>
          ) : (
            <>
              <p>{String(d.detail || "Check whether the original message went through.")}</p>
              <div className="mail-links">
                {["check", "send"].map((action) => (
                  <MailForm action={action} id={id} version={Number(d.version)} key={action}>
                    <input type="hidden" name="channel" value={String(d.channel)} />
                    <input type="hidden" name="recipient" value={String(d.recipient)} />
                    <Button>{action === "check" ? "Check delivery" : "Retry the same email"}</Button>
                  </MailForm>
                ))}
              </div>
            </>
          )}
        </div>
      ))}
    </Panel>
  );
  return (
    <WorkspaceShell
      active="inbox"
      breadcrumbs={[
        { label: "Home", href: "/" },
        { label: "Customer emails", href: quote ? "/inbox" : undefined },
        ...(quote ? [{ label: quote.number }] : []),
      ]}
    >
      <div className="mail-work">
        <header className="page-heading shelf-heading">
          <div>
            <h1>{focusSend ? "Share customer quote" : quote ? quote.jobName : "Customer emails"}</h1>
            <p>
              {quote
                ? quote.customer + " · " + quote.number
                : "Open a customer’s message or add a request from your email."}
            </p>
          </div>
          {quote && (
            <a className="button secondary" href={"/quotes/" + id}>
              Back to quote
            </a>
          )}
        </header>
        {notice && (
          <p
            className={"mail-notice" + (query.error ? " mail-error" : "")}
            role={query.error ? "alert" : "status"}
          >
            {notice.slice(0, 500)}
          </p>
        )}
        {!quote ? (
          <div className="mail-layout">
            <div className="mail-column">
              <Panel title="Messages by job">
                {account.sender && account.label && (
                  <MailForm action="sync">
                    <Button primary>Get new emails</Button>
                  </MailForm>
                )}
                {threads.length ? (
                  threads.map((m) => (
                    <a
                      className="mail-thread"
                      href={"/inbox?quoteId=" + m.quote_id}
                      key={String(m.quote_id)}
                    >
                      <div>
                        <strong>{String(m.subject)}</strong>
                        <small>
                          {String(m.sender_name || m.sender)} · {String(m.sent_at).slice(0, 10)} ·{" "}
                          {String(m.total)} {Number(m.total) === 1 ? "message" : "messages"}
                        </small>
                      </div>
                      <b>Open →</b>
                    </a>
                  ))
                ) : (
                  <div className="mail-empty">
                    <h3>No customer emails yet</h3>
                    <p>
                      Add a saved email below, or start a quote with just the customer’s name and job.
                    </p>
                    <a className="button secondary" href="/quotes/new">
                      Start a quote
                    </a>
                  </div>
                )}
              </Panel>
              {importTools}
            </div>
            <aside className="mail-column">
              <details className="panel mail-fold">
                <summary>Find emails for a quote</summary>
                <div className="mail-panel">{formOpen}</div>
              </details>
              {setup}
            </aside>
          </div>
        ) : (
          <div className="mail-layout">
            <div className="mail-column">
              {focusSend && delivery}
              <Panel title="Customer messages">
                {messages.length === 0 && <p>No email has been added for this job.</p>}
                {messages.map((m, index) => (
                  <details
                    className="mail-message"
                    key={String(m.id)}
                    open={(index === 0 && !focusSend) || undefined}
                  >
                    <summary>{String(m.subject)}</summary>
                    <p>
                      {String(m.sender_name || m.sender)} · {String(m.sent_at).slice(0, 10)}
                    </p>
                    <p className="mail-body">{String(m.body)}</p>
                    <div className="mail-links">
                      {db
                        .prepare("SELECT id,name,drawing_revision FROM mail_files WHERE message_id=?")
                        .all(m.id)
                        .map((f) => (
                          <span key={String(f.id)}>
                            <a href={"/api/inbox/files/" + f.id}>{String(f.name)}</a>
                            {f.drawing_revision && (
                              <>
                                {" "}
                                ·{" "}
                                <a href={"/quotes/" + id + "/review/" + f.drawing_revision}>
                                  Check drawing
                                </a>
                              </>
                            )}
                          </span>
                        ))}
                    </div>
                    <details>
                      <summary>Original email and message details</summary>
                      <div className="mail-inner">
                        <a href={"/api/inbox/files/" + m.id + "?kind=message"}>
                          Download original email
                        </a>
                        <small>
                          {String(m.sender)} · {String(m.rfc_id)} {String(m.thread_id ?? "")}
                        </small>
                      </div>
                    </details>
                  </details>
                ))}
                <details open={draft && !focusSend ? true : undefined}>
                  <summary>Ask the customer a question</summary>
                  <div className="mail-inner">
                    {draft ? (
                      <MailForm action="saveDraft" id={id}>
                        <label>
                          Reply draft for {String(messages[0]?.reply_to ?? quote.customer)}
                          <textarea
                            required
                            name="body"
                            rows={5}
                            maxLength={50000}
                            defaultValue={String(draft.body)}
                          />
                        </label>
                        <Button>Save reply draft</Button>
                      </MailForm>
                    ) : (
                      <>
                        <p>
                          Start a reply with the details you still need. You can edit it before copying
                          it into your email.
                        </p>
                        <MailForm action="draft" id={id}>
                          <Button>Write a reply draft</Button>
                        </MailForm>
                      </>
                    )}
                  </div>
                </details>
              </Panel>
              {!focusSend && delivery}
            </div>
            <aside className="mail-column">
              <a className="button secondary" href="/inbox">
                All customer emails
              </a>
              {importTools}
              {setup}
            </aside>
          </div>
        )}
      </div>
    </WorkspaceShell>
  );
}
