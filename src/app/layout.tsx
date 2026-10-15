import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NODE_CSS, THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://threadline-graph.vercel.app"),
  title: "Threadline: a company brain that shows its work",
  description:
    "Ask about people, code, issues and releases across the FalkorDB organisation. An agent walks a FalkorDB graph to answer, and every hop is replayed in 3D with the exact Cypher it ran.",
};

export const viewport: Viewport = { themeColor: "#05060a" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <style dangerouslySetInnerHTML={{ __html: NODE_CSS }} />
      </head>
      <body className="min-h-full bg-canvas">{children}</body>
    </html>
  );
}
