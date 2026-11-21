"use client";
import { useState } from "react";
import { Icon } from "./Icons";
import type { QuoteStatus } from "@/lib/workflow-types";

interface DeskRow {
  id: string;
  name: string;
  customer: string;
  number: string;
  date: string;
  price: number | null;
  status: QuoteStatus;
  version: number;
  example: boolean;
}
const labels: Record<QuoteStatus, string> = {
  draft: "Draft",
  awaiting_review: "Needs approval",
  approved: "Approved",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
};
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const queues = [
  ["all", "All quotes"],
  ["draft", "Drafts"],
  ["awaiting_review", "Needs approval"],
  ["approved", "Approved"],
  ["sent", "Sent"],
] as const;
export default function SavedQuotes({ rows }: { rows: DeskRow[] }) {
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState("all");
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const found = rows.filter((row) => {
    const text = [row.name, row.customer, row.number, row.example ? "example" : ""]
      .join(" ")
      .toLowerCase();
    return (status === "all" || status === row.status) && words.every((word) => text.includes(word));
  });
  return (
    <>
 
    <section className="desk-list" id="saved-quotes" aria-labelledby="saved-heading">
      <div className="desk-list-top">
        <h2 id="saved-heading">
          Saved quotes
        </h2>
        <div className="desk-filters">
          <label className="desk-search">
            <Icon name="search" />
            <span className="visually-hidden">Find a quote by job, customer or quote number</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search quotes"
            />
          </label>
          <label className="desk-select desk-mobile-filter">
            <Icon name="filter" size={17} />
            <span className="visually-hidden">Filter by status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="all">All statuses</option>
              {Object.entries(labels).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
            <Icon name="down" size={12} />
          </label>
        </div>
      </div>
      <div className="desk-queues" role="group" aria-label="Quote work queues">
        {queues.map(([key, label]) => <button type="button" key={key} aria-pressed={status === key}
          onClick={() => setStatus(key)}>{label}
          <span>{key === "all" ? rows.length : rows.filter(row => row.status === key).length}</span>
        </button>)}
        <label className="desk-more-filter">
          <select aria-label="Other quote statuses" value={["accepted","declined","expired"].includes(status) ? status : ""}
            onChange={event => setStatus(event.target.value || "all")}>
            <option value="">More statuses</option>
            <option value="accepted">Accepted</option><option value="declined">Declined</option><option value="expired">Expired</option>
          </select>
        </label>
      </div>
      <span className="visually-hidden" role="status">
        {found.length} {found.length === 1 ? "quote" : "quotes"} shown
      </span>
      {found.length > 0 ? (
        <>
          <div className="desk-table-labels" aria-hidden="true">
            <span>Job / Customer</span>
            <span>Status</span>
            <span>Last saved</span>
            <span>Quote price</span>
            <span />
          </div>
          <ul className="desk-rows">
            {found.map((row) => {
              const path = "/quotes/" + encodeURIComponent(row.id);
              const destination =
                row.status === "draft" ? path : path + "/approval?version=" + row.version;
              return (
                <li key={row.id}>
                  <a
                    className="desk-row"
                    href={destination}
                    aria-label={"Open " + row.name + " for " + row.customer + " · " + labels[row.status]}
                  >
                    <div className="desk-job">
                      <span className="desk-file">
                        <Icon name="quotes" size={23} />
                      </span>
                      <div className="desk-job-name">
                        <strong>{row.name}</strong>
                        <small>
                          {row.customer} <span>·</span> {row.number}
                          {row.example ? " · Example" : ""}
                        </small>
                      </div>
                    </div>
                    <span className={"desk-status state-" + row.status}>
                      <i />
                      {labels[row.status]}
                    </span>
                    <span className="desk-date">
                      <span className="desk-mobile-label">Saved </span>
                      {row.date}
                    </span>
                    <span className={row.price === null ? "desk-amount unpriced" : "desk-amount"}>
                      {row.price === null ? "No price yet" : money.format(row.price)}
                    </span>
                    <span className="desk-open">
                      Open <Icon name="chevron" size={14} />
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <div className="desk-empty">
          <Icon name={rows.length ? "search" : "quotes"} size={25} />
          <h3>{rows.length ? "No quotes match" : "Your first quote starts here"}</h3>
          <p>
            {rows.length
              ? "Try another job name, customer or quote number."
              : "Choose Start a quote above. Once you save it, you can open it here."}
          </p>
          {rows.length > 0 && (
            <button
              className="button secondary"
              onClick={() => {
                setQuery("");
                setStatus("all");
              }}
            >
              Show all quotes
            </button>
          )}
        </div>
      )}
    </section>
    </>
  );
}
