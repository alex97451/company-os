import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Company OS — Direction locale",
    template: "%s · Company OS",
  },
  description: "Cockpit local multi-entreprises pour piloter des équipes d’agents isolées.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#090c12",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="fr" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
