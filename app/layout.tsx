// app/layout.tsx
import type { Metadata } from "next";
import type { Viewport } from "next";
import "./globals.css";
import AuthSyncGuard from "./auth-sync-guard";

export const metadata: Metadata = {
  title: "KOZMOS.",
  description: "A shared social space for presence, not performance.",
};

export const viewport: Viewport = {
  themeColor: "#0b0b0b",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      style={{
        background: "#0b0b0b",
        colorScheme: "dark",
      }}
    >
      <body
        style={{
          margin: 0,
          background: "#0b0b0b",
          color: "#eaeaea",
        }}
      >
        <AuthSyncGuard />
        {children}
      </body>
    </html>
  );
}
