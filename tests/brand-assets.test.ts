import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderBrandPng } from "../lib/brand-image";

describe("Identidad oficial Lubricenter", () => {
  it("conserva la gota naranja y las LC internas sobre transparencia", () => {
    const svg = readFileSync("public/lubricenter-brand.svg", "utf8");
    expect(svg).toContain("viewBox=");
    expect(svg).toContain("#fd5408");
    expect(svg).toContain("#fdfdfd");
    expect(svg).toContain("#201e1e");
    expect(svg).not.toMatch(/<rect\b/i);
    expect(svg).not.toMatch(/<image\b/i);
  });

  it("configura el fondo exacto #222222 para los iconos instalables", () => {
    const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));
    expect(manifest.background_color).toBe("#222222");
    expect(manifest.theme_color).toBe("#222222");
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: "/pwa/icon-192.png", sizes: "192x192", purpose: "any" }),
      expect.objectContaining({ src: "/pwa/icon-512.png", sizes: "512x512", purpose: "any" }),
      expect.objectContaining({ src: "/pwa/icon-maskable-512.png", sizes: "512x512", purpose: "maskable" }),
    ]));
  });

  it("genera un PNG de marca válido y no devuelve el cuadrado blanco", async () => {
    const result = await renderBrandPng(64);
    expect(result.headers.get("content-type")).toContain("image/png");
    const bytes = new Uint8Array(await result.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual([137,80,78,71,13,10,26,10]);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("genera el PNG instalable de 192px con fondo gris oscuro", async () => {
    const result = await renderBrandPng(192, "#222222");
    const bytes = new Uint8Array(await result.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual([137,80,78,71,13,10,26,10]);
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
