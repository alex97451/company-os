import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Internal operations",
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  themeColor: "#090c12",
};

export default function OpsLayout({ children }: { children: ReactNode }) {
  return children;
}
