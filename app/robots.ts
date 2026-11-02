import type { MetadataRoute } from "next";

// Sistema interno: ningún buscador ni rastreador debe indexarlo.
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", disallow: "/" }] };
}
