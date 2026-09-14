import { describe, expect, it } from "vitest";
import { matchesSearch } from "./search";

describe("búsqueda de mostrador", () => {
  it("encuentra aceite con palabras en diferente orden y viscosidad separada", () => {
    expect(matchesSearch("Valvoline mineral 15W-40", "15w 40 valvoline")).toBe(true);
    expect(matchesSearch("Aceite sintético", "sintetico aceite")).toBe(true);
  });
  it("exige todas las palabras para no mezclar viscosidades", () => {
    expect(matchesSearch("Valvoline 10W-30", "valvoline 15w 40")).toBe(false);
  });
});

