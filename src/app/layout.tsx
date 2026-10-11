import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "X Outreach Manager", description: "Consent-aware DM campaign manager", robots: { index: false, follow: false } };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" className="dark"><body className="min-h-screen font-sans">{children}</body></html>;
}
