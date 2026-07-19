import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lakeside Dental — Scheduling",
  description: "Chat-based appointment scheduling for Lakeside Dental Clinic",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
