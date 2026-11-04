import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("campos numéricos", () => {
  it("no queda ningún input nativo type=number en app/ ni components/", () => {
    const offenders = [...tsxFiles("app"), ...tsxFiles("components")].flatMap(file => {
      const source = readFileSync(file, "utf8");
      return /type=(?:"number"|\{\s*["']number["']\s*\})/.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")) ? [file] : [];
    });
    expect(offenders).toEqual([]);
  });

  it("NumberField usa texto con teclado decimal y paso entero", () => {
    const field = readFileSync("components/number-field.tsx", "utf8");
    expect(field).toContain('type="text"');
    expect(field).toContain('inputMode={p.inputMode ?? "decimal"}');
    expect(field).not.toMatch(/onWheel/);
    expect(field).toContain("stepValue(current, direction, big, min, max)");
  });
});
