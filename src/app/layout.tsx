import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-[#05060a]">{children}</body>
    </html>
  );
}
