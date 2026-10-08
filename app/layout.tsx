import type { Metadata } from "next";
import "./globals.css";
import "./nav.css";
import "./shell-v2.css";
import "./home-v2.css";
import "./catalog/catalog.css";
import "./receipt.css";
import { AuthGuard } from "@/components/auth-guard";
import { AppShell } from "@/components/app-shell";
import { PwaRegister } from "@/components/pwa-register";

export const metadata: Metadata = {
  title: "Lubricenter OS",
  description: "Operación, caja y nómina de Lubricenter",
  manifest: "/manifest.webmanifest",
  applicationName: "Lubricenter OS",
  icons: {
    icon: [
      { url: "/icon", type: "image/png", sizes: "64x64" },
      { url: "/lubricenter-brand.svg", type: "image/svg+xml" }
    ],
    apple: [{ url: "/apple-icon", sizes: "180x180", type: "image/png" }]
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Lubricenter OS"
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>
        <PwaRegister />
        <AuthGuard>
          <AppShell>{children}</AppShell>
        </AuthGuard>
      </body>
    </html>
  );
}

