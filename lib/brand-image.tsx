import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

/**
 * All PNG variants share the same vector artwork, traced from the approved
 * official orange-drop LC isotipo. The PNG is rendered transparently for
 * the application, or on #222222 for home-screen installation.
 */
let cachedSvg: string | undefined;

async function logoDataUri() {
  if (!cachedSvg) {
    cachedSvg = await readFile(join(process.cwd(), "public", "lubricenter-brand.svg"), "utf8");
  }
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(cachedSvg);
}

export async function renderBrandPng(
  size: number,
  background?: "#222222",
  purpose: "any" | "maskable" = "any"
) {
  const iconSize = Math.round(size * (background ? purpose === "maskable" ? 0.67 : 0.79 : 0.96));
  const svg = await logoDataUri();

  return new ImageResponse(
    <div style={{
      display: "flex",
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: background || "transparent",
    }}>
      {/* The SVG only contains the logo. No white square and no baked-in background. */}
      <img src={svg} alt="Lubricenter LC" width={iconSize} height={iconSize} />
    </div>,
    { width: size, height: size }
  );
}
