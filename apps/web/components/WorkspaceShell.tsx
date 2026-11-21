import type { ReactNode } from "react";
import { Icon, MountainMark } from "./Icons";
import ShopMenu from "./ShopMenu";

export interface ShellProps {
  children: ReactNode;
  active?: "quotes" | "blueprints" | "drawings" | "sketches" | "inbox" | "jobs" | "settings" | "help";
  breadcrumbs?: { label: string; href?: string }[];
  drawingsHref?: string;
}

const groups = [
  [
    { key: "quotes", label: "Quote desk", href: "/", icon: "quotes" },
    { key: "sketches", label: "Sketch to drawing", href: "/sketches", icon: "sketch" },
  ],
  [
    { key: "blueprints", label: "Drawing reviews", href: "/blueprints", icon: "blueprint" },
    { key: "inbox", label: "Customer emails", href: "/inbox", icon: "inbox" },
    { key: "jobs", label: "Finished jobs", href: "/jobs", icon: "jobs" },
  ],
  [
    { key: "settings", label: "Shop settings", href: "/settings", icon: "settings" },
    { key: "help", label: "Quick guide", href: "/help", icon: "book" },
  ],
] as const;

function Brand() {
  return <a className="shop-brand" href="/" aria-label="Little Mountain Metalworks home">
    <span className="shop-brand-mark"><MountainMark /></span>
    <span><strong>Little Mountain</strong><small>Metalworks</small></span>
  </a>;
}

export function WorkspaceShell({ children, active = "quotes", breadcrumbs = [] }: ShellProps) {
  const section = active === "drawings" ? "quotes" : active;
  const links = groups.map((group, index) => <div className="shop-nav-group" key={index}>
    {group.map(item => <a key={item.key} href={item.href} className="shop-nav-link"
      aria-current={section === item.key ? "page" : undefined}>
      <span className="shop-nav-icon"><Icon name={item.icon} size={18} /></span>{item.label}
    </a>)}
  </div>);
  const crumbs = breadcrumbs.filter(c => !["Home", "Workspace"].includes(c.label));
  const current = groups.flat().find(item => item.key === section);
  return <div className="workspace shop-app">
    <a className="shop-skip" href="#shop-content">Skip to page</a>
    <aside className="shop-sidebar"><Brand /><nav aria-label="Main navigation">{links}</nav></aside>
    <div className="shop-mobile-bar"><Brand /><ShopMenu>{links}</ShopMenu></div>
    <div className="shop-main">
      <header className="shop-topbar">
        <div className="shop-topbar-inner">
          <nav className="shop-breadcrumbs" aria-label="Breadcrumb">
            <a href="/" aria-label="Home"><Icon name="home" size={15}/><span>Workspace</span></a>
            {(crumbs.length ? crumbs : [{ label: current?.label ?? "Quote desk" }]).map((c,i) => <span key={i}>
              <Icon name="chevron" size={11}/>{c.href ? <a href={c.href}>{c.label}</a> :
                <span aria-current="page">{c.label}</span>}
            </span>)}
          </nav>
        </div>
      </header>
      <main className="work-surface shop-content" id="shop-content">{children}</main>
    </div>
  </div>;
}
export default WorkspaceShell;
