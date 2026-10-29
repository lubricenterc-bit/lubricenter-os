import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BRAND_ICONS, gotinSvg, type GotinPose } from "../lib/brand-art";

const POSES: GotinPose[] = ["wave", "hold", "can", "clip", "flag", "point", "cheer", "shrug", "idle"];

function balanced(svg: string, tag: string) {
  const open = svg.match(new RegExp(`<${tag}[\\s>]`, "g"))?.length ?? 0;
  const close = svg.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0;
  return open === close;
}

describe("Gotín y las piezas de marca", () => {
  it("dibuja todas las poses como SVG completo", () => {
    for (const pose of POSES) {
      const svg = gotinSvg(pose);
      expect(svg.startsWith('<svg class="gotin pose-' + pose)).toBe(true);
      expect(svg.endsWith("</svg>")).toBe(true);
      expect(balanced(svg, "g")).toBe(true);
      expect(svg).toContain('class="eye');
    }
  });

  it("es decorativo sin etiqueta y accesible con etiqueta escapada", () => {
    expect(gotinSvg("wave", { decorative: true })).toContain('aria-hidden="true"');
    expect(gotinSvg("wave", { decorative: true })).not.toContain("role=");
    const labelled = gotinSvg("cheer", { label: 'Gotín "celebra" <venta> & más' });
    expect(labelled).toContain('role="img"');
    expect(labelled).not.toContain("<venta>");
    expect(labelled).toContain("&quot;celebra&quot;");
  });

  it("todas las piezas son decorativas y usan la línea de marca", () => {
    for (const [name, draw] of Object.entries(BRAND_ICONS)) {
      const svg = draw();
      expect(svg, name).toMatch(/^<svg class="bi /);
      expect(svg, name).toContain('aria-hidden="true"');
      expect(balanced(svg, "g"), name).toBe(true);
    }
  });

  it("las animaciones infinitas solo corren a la vista y respetan el modo tranquilo", () => {
    const motion = readFileSync("app/theme/motion.css", "utf8");
    const rules = motion.split("}").filter(rule => /animation:[^;]*infinite/.test(rule));
    expect(rules.length).toBeGreaterThan(10);
    for (const rule of rules) expect(rule, rule.trim()).toContain(".live");
    expect(motion).toContain("prefers-reduced-motion: reduce");
    expect(motion).toContain(".calm-motion");
  });

  it("los recibos térmicos quedan fuera del tema de pantalla", () => {
    const base = readFileSync("app/theme/base.css", "utf8");
    expect(base).toMatch(/@media screen\s*\{\s*\.os-theme\s*\{/);
    expect(readFileSync("app/layout.tsx", "utf8")).toContain('import "./receipt.css"');
  });
});
