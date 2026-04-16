import type { Metadata } from "next";
import type { CSSProperties } from "react";
import "./globals.css";
import { colors } from "@/lib/constants";

export const metadata: Metadata = {
  title: "floatty explorer + AI",
  description: "AI-powered knowledge graph explorer for floatty outliner",
};

const colorVars = Object.fromEntries(
  Object.entries(colors).map(([key, value]) => [`--color-${key}`, value])
) as CSSProperties;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full" style={colorVars}>
      <body className="h-full">{children}</body>
    </html>
  );
}
