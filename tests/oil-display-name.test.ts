import { describe, expect, it } from "vitest";
import { oilDisplayName } from "../lib/oil-display-name";

describe("nombre de aceite para mostrar", () => {
  it.each([
    ["Valvoline 15W40 semi", "Valvoline 15W-40 Semisintético"],
    ["VALVOLINE 15W-40 SEMISINTETICO", "Valvoline 15W-40 Semisintético"],
    ["5 Lit. (4 1/2) de Valvoline 15W40 semi", "Valvoline 15W-40 Semisintético"],
    ["VALVOLINE 15-40 SEMESINTETICO", "Valvoline 15W-40 Semisintético"],
    ["6 litros de Sky Evolub 20W50 mineral", "Sky Evolub 20W-50 Mineral"],
    ["Lirax 20w50 Mineral a Granel", "Lirax 20W-50 Mineral"],
    ["15w40 Valvoline", "Valvoline 15W-40"],
    ["Fanfaro 10w40 Full", "Fanfaro 10W-40 Sintético"],
    ["Chornus 20w50 Mineral", "Chronus 20W-50 Mineral"],
    ["Movil Delmac 15W40 Diesel", "Mobil Delvac Diesel 15W-40"],
    ["Shell 10W-40 Semisintetico HX7", "Shell HX7 10W-40 Semisintético"],
    ["Sae 50 Lubrikon", "Lubrikon SAE 50"],
    ["Valvoline", "Valvoline"],
    ["", ""],
    [null, ""],
  ])("%s → %s", (raw, expected) => {
    expect(oilDisplayName(raw)).toBe(expected);
  });
});
