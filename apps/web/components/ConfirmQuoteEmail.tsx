"use client";
import Activity from "@/components/Activity";
import { useState } from "react";

export default function ConfirmQuoteEmail({
  id,
  version,
  number,
  customer,
  sender,
  replyTo,
}: {
  id: string;
  version: number;
  number: string;
  customer: string;
  sender: string;
  replyTo: string;
}) {
  const [recipient, setRecipient] = useState(replyTo);
  const [confirm, setConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  if (!confirm)
    return (
      <form
        className="mail-form"
        onSubmit={(e) => {
          e.preventDefault();
          setConfirm(true);
        }}
      >
        <label>
          Customer’s email address
          <input
            value={recipient}
            type="email"
            required
            placeholder="name@example.com"
            onChange={(e) => setRecipient(e.target.value)}
          />
        </label>
        <button className="button primary" type="submit">
          Review email
        </button>
      </form>
    );
  return (
    <form
      className="mail-form mail-confirm"
      action="/api/inbox"
      method="post"
      onSubmit={() => setSending(true)}
    >
      <input type="hidden" name="action" value="send" />
      <input type="hidden" name="quoteId" value={id} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="channel" value="gmail" />
      <input type="hidden" name="recipient" value={recipient.trim()} />
      <div>
        <strong>Send the approved PDF to {recipient.trim()}?</strong>
        <p>
          {customer} · {number} · Version {version}
        </p>
        <small>From {sender}</small>
      </div>
      <div className="mail-links">
        <button className="button primary" disabled={sending}>
          {sending ? <Activity>Sending quote</Activity> : "Send quote now"}
        </button>
        <button
          type="button"
          disabled={sending}
          className="button secondary"
          onClick={() => setConfirm(false)}
        >
          Change address
        </button>
      </div>
    </form>
  );
}
