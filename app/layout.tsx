// app/layout.tsx
import type { Metadata } from "next";
import "./globals.css";
import AuthSyncGuard from "./auth-sync-guard";

export const metadata: Metadata = {
  title: "KOZMOS.",
  description: "A shared social space for presence, not performance.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <AuthSyncGuard />
        {children}
      </body>
    </html>
  );
}
