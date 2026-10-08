import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";
import { ImageResponse } from "next/og";

/**
 * The app and installed phone icons share the same approved LC drop artwork.
 * PNGs are transparent in app and #222222 on the phone home screen.
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
  const logo = createElement("img", {
    src: svg,
    alt: "Lubricenter LC",
    width: iconSize,
    height: iconSize
  });
  const composition = createElement("div", {
    style: {
      display: "flex",
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: background || "transparent",
    }
  }, logo);
  return new ImageResponse(composition, { width: size, height: size });
}
