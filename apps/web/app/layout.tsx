import type { Metadata } from "next";
import "./ui.css";
import "./globals.css";
import "./shop-shell.css";
import "./workflow-design.css";

export const metadata: Metadata = {
  title: "Little Mountain Metalworks | Quoting",
  description: "Internal fabrication estimates and drawing review.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
