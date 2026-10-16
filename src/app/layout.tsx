import type { Metadata, Viewport } from "next";
import { brand } from "@/config/brand";
import { StatsBanner } from "@/components/stats-banner";
import { ThemeScript } from "@/components/ui/ThemeScript";
import "./globals.css";

// The stats banner shows live database counts, so no page is statically cached.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: brand.fullName, template: `%s · ${brand.portalName}` },
  description: "Submit academic concerns, welfare complaints and suggestions to the DLI Student Union, and follow their progress.",
  robots: { index: false, follow: false },
  referrer: "same-origin",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#3F0014",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // data-theme is set before first paint by ThemeScript, so React must not warn about it.
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        <ThemeScript />
        <a
          href="#main"
          className="absolute -top-16 left-2 z-30 rounded-md bg-brand-600 px-3 py-2 text-on-brand no-underline focus:top-2"
        >
          Skip to content
        </a>
        <StatsBanner />
        {children}
      </body>
    </html>
  );
}
