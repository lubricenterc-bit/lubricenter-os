import type { NextConfig } from "next";

// Lubricenter OS es una herramienta interna con datos financieros: no debe
// indexarse ni incrustarse en otros sitios. Los estáticos con hash
// (/_next/static) ya salen con caché inmutable de Next; aquí se cubren los
// archivos de /public y el service worker.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // El service worker debe revisarse siempre: si se cachea, un despliegue tarda horas en llegar.
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] },
      // Logos e iconos de /public no llevan hash: un día de caché y revalidación en segundo plano.
      {
        source: "/:file(icon-192.png|icon-512.png|lubricenter-logo.png|lubricenter-brand.svg|lubricenter-lc-isotipo.png|manifest.webmanifest)",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
      },
      { source: "/brand/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }] },
    ];
  },
};

export default nextConfig;
