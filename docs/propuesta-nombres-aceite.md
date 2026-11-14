# Propuesta · nombres de aceite para mostrar (Frente G-4)

**Estado:** pendiente de aprobación del dueño (⛔ GATE). Datos de `service_records` de Cabudare al 14 nov 2026.

- **El historial no se reescribe.** `service_records.oil_brand` conserva lo que se escribió. Solo cambia cómo se **muestra** (CRM, historial, recibos) con `oilDisplayName` (`lib/oil-display-name.ts`). Cuando lo apruebes, la misma regla irá en SQL (`lubricenter_private.oil_display_name`) para `crm_render`.
- **Regla:** marca primero, viscosidad como `15W-40`, tipo como `Semisintético` / `Mineral` / `Sintético`. Se quitan cantidades («6 litros de», «(4 1/2)») y empaque («garrafa», «granel», «galón»).
- **Correcciones de marca** (`OIL_BRAND_ALIASES`): Chornus → Chronus · Movil Delmac → Mobil Delvac · Dr Care → Dr. Care.

## Dudas para el dueño
1. **Daver** (2) y **Dauer** (1): ¿son la misma marca? ¿Cuál es la correcta?
2. **Sky** y **Sky Evolub**: ¿se muestran igual («Sky Evolub»)?
3. **Brava 20W-20** e **Inca 20W-40**: parecen errores de 20W-50. Se muestran como se escribieron.
4. **«PRUEBA ACEITE 64»** y **«6 Lit.»** (sin marca): son registros de prueba o incompletos. ¿Se ocultan?
5. **48 servicios sin aceite registrado:** se quedan vacíos.

## Tabla completa
180 escrituras distintas → 87 nombres.

| Se mostrará | Servicios | Cómo está escrito hoy (veces) |
|---|---|---|
| Valvoline 15W-40 Semisintético | 98 | Valvoline 15W40 semi (38) · Valvoline 15w40 Semi (23) · Valvoline 15W40 semi garrafa (7) · VALVOLINE 15W40 SEMI SINTETICO (6) · Valvoline 15w40 Semisintetico (3) · Valvoline 15w40 Semi-Sintetico (2) · Valvoline 15w-40 Semisintetico (2) · Valvoline 15W40 semi Garrafa (2) · 6 litros de Valvoline 15W40 semi (1) · 15W 40 VALVOLINE  SEMI SINTETICO (1) · Valvoline 15w40 Semi-sintetico (1) · 4 Valvoline 15w40 Semi-Sintetico (1) · Valvoline 15WE40 semi (1) · VALVOLINE 15-40 SEMESINTETICO (1) · Valvoline 15w40 Semi Sintetico (1) · Valvoline 15w40 SemiSintetico (1) · 5 Lit. (4 1/2) de Valvoline 15W40 semi (1) · 6 lit. Valvoline 15W40 semi (1) · Valvoline 15w-40 Semi-Sintetico (1) · VALVOLINE 15W-40 SEMISINTETICO (1) · (4 1/2) Valvoline 15W40 semi (1) · 15w40 Valvoline Semi (1) · 4 litros de Valvoline 15W40 semi (1) |
| Brava 15W-40 Semisintético | 41 | Brava 15W40 semi (18) · Brava 15w40 Semi (14) · Brava 15w40 Semi-sintetico (3) · BrAVA 15w40 semi (1) · 4 Lit. Brava 15W40 semi (1) · Brava 15w40 Semisintetico (1) · 5 Lit. (4 1/2) Brava 15W40 semi (1) · Brava 15w40 Semi-Sintetico (1) · Brava 15w40 Semi sintetico (1) |
| Brava 20W-50 Mineral | 29 | Brava 20W50 mineral (13) · Brava 20w50 Mineral (11) · Brava 20W50 minera (2) · BRAVA 20W50 MINERAL (1) · 4 lit. Brava 20W50 mineral (1) · Brava 20w50 mineral (1) |
| Inca 15W-40 Semisintético | 23 | Inca 15W40 semi (13) · Inca 15w40 Semi (4) · INCA 15W-40 SEMI (1) · Inca 15W40 SEMI (1) · INCA 15w40 SEMI-SINTETICO (1) · Inca 15w-40 Semi-Sintetico (1) · Inca 15w-40 Semi-sintetico (1) · 4 Ltr. Inca 15W40 semi (1) |
| Lirax 20W-50 Mineral | 23 | Lirax 20W50 mineral (9) · Lirax 20W50 mineral granel (7) · Lirax 20w50 Mineral (4) · Lirax 20w50 Mineral a Granel (1) · Lirax 20W50 mineral Granel (1) · LIRAX 20W50 MINERAL GRANEL (1) |
| Brava 20W-50 Semisintético | 18 | Brava 20W50 semi (10) · Brava 20w50 Semi (5) · Brava 20w50 Semisintetico (2) · Brava 20w50 Semi-sintetico (1) |
| Valvoline 20W-50 Semisintético | 15 | Valvoline 20w50 Semi (7) · Valvoline 20W50 semi (4) · Valvoline 20W50 semisintetico (1) · Valvoline 20w50 Semi-sintetico (1) · VALVOLINE 20W50 SEMISINTETICO (1) · Valvoline 20w50 Semi-Sintetico (1) |
| Valvoline | 14 | Valvoline (14) |
| Lirax 15W-40 Semisintético | 12 | Lirax 15W40 semi (8) · Lirax 15w40 Semi (2) · Lirax 15w40 Semisintetico (1) · Lirax 15w40 Semi-Sintetico (1) |
| Inca 20W-50 Mineral | 11 | Inca 20W50 mineral (6) · Inca 20w50 Mineral (3) · 4 lit. Inca 20W50 mineral (1) · INCA 20w50 MINERAL (1) |
| Inca | 10 | Inca (10) |
| Chronus 20W-50 Semisintético | 9 | Chronus 20W50 semi (8) · CHRONUS 20W50 SEMI SYNTETICO (1) |
| Fanfaro 10W-40 Sintético | 9 | Fanfaro 10w40 Full (6) · Fanfaro 10w40 Full Sintetico (3) |
| Chronus 15W-40 Semisintético | 9 | Chronus 15W40 semi (6) · Chronus 15w40 Semi (3) |
| Valvoline 20W-50 Mineral | 9 | Valvoline 20W50 mineral (3) · Valvoline 20w50 Mineral (3) · Valvoline 20w50 mineral (1) · Valvoline 20W50 mineral garrafa (1) · VALVOLINE 20W50 MINERAL (1) |
| Inca 20W-50 Semisintético | 8 | Inca 20w50 Semi (6) · Inca 20W50 semi (2) |
| Brava | 7 | Brava (7) |
| Brava 15W-40 Mineral | 7 | Brava 15W40 mineral (4) · Brava 15w40 Mineral (3) |
| Valvoline 10W-30 Semisintético | 7 | Valvoline 10W30 semisintetico (1) · Valvoline 10W30 Semi sintetico (1) · 10 30 VALVOLINE SEMI SINTETICO (1) · Valvoline 10w30 Semi (1) · Valvoline 10w30 semi-sintetico (1) · Valvoline 10w30 Semi-Sintetico (1) · Valvoline 10w30 semi (1) |
| Sky 15W-40 Semisintético | 6 | Sky 15w40 Semi (6) |
| Valvoline 15W-40 | 6 | Valvoline 15W40 garrafa (2) · Valvoline 15w40 (2) · 15w40 Valvoline (2) |
| Lirax 15W-40 Mineral | 4 | Lirax 15W40 mineral (4) |
| Motul 20W-50 Mineral | 4 | Motul 20w50 Mineral (4) |
| Valvoline 15W-40 Mineral | 4 | Valvoline 15w40 Mineral (4) |
| Chronus 20W-50 Mineral | 4 | Chronus 20W50 mineral (2) · chronus 20w50 mineral (1) · Chornus 20w50 Mineral (1) |
| 15W-40 | 4 | 15W40 (2) · 15W-40 (1) · 15w-40 (1) |
| Lirax 20W-50 Semisintético | 4 | Lirax 20W50 semi (2) · Lirax 20w50 Semi-Sintetico (1) · Lirax 20w50 Semi sintetico (1) |
| Fanfaro | 3 | Fanfaro (3) |
| Fanfaro 15W-40 Semisintético | 3 | FANFARO 15W40 SEMI-SINTETICO (3) |
| Brava 10W-30 Semisintético | 3 | Brava 10W30 semi (2) · Brava 10w30 Semi (1) |
| Mobil Delvac 15W-40 Semisintético | 3 | Mobil Delvac 15w40 Semi Sintetico (1) · MOBIL DELVAC 15W40 SEMI (1) · Mobil Delvac 15w40 Semisintetico (1) |
| Dr. Care 20W-50 Mineral | 3 | Dr Care 20W50 mineral (1) · Dr Care 20w50 Mineral (1) · Dr Care 20w-50 Mineral (1) |
| Sky 20W-50 Semisintético | 2 | Sky 20w50 Semi (2) |
| Mobil Delvac Diesel/Gasolina 15W-40 Semisintético | 2 | MOBIL DELVAC 15W40 SEMISINTETICO DIESEL/GASOLINA (2) |
| Shell | 2 | Shell (2) |
| Gulf 20W-50 Mineral | 2 | Gulf 20W50 mineral (2) |
| Motul 15W-40 Semisintético | 2 | Motul 15w40 Semi (2) |
| Lubrikon | 2 | Lubrikon (2) |
| Inca 15W-40 Mineral | 2 | Inca 15w40 Mineral (2) |
| Sky | 2 | Sky (2) |
| Voltex | 2 | Voltex (1) · VOLTEX (1) |
| Fanfaro 5W-30 Sintético | 2 | Fanfaro 5w30 Full (1) · FANFARO 5W-30 FULL SINTETICO (1) |
| Sky Evolub 15W-40 | 2 | Sky Evolub 15w40 (1) · Sky 15w40 Evolub (1) |
| Sky Evolub 15W-40 Semisintético | 2 | SKY EVOLUB 15W-40 SEMISINTETICO (1) · Sky Evolub 15w40 SemiSintetico (1) |
| Motul 4100 15W-40 Semisintético | 1 | MOTUL 4100 15w40 SEMISINTETICO (1) |
| 15W-40 Semisintético | 1 | 15w-40 Semi (1) |
| 10W-30 Semisintético | 1 | 10w30 Semi (1) |
| Chronus 20W-50 | 1 | 20w50 Chronus (1) |
| Inca 5W-30 Sintético | 1 | Inca 5W30 Sintetico (1) |
| Shell HX7 10W-40 Semisintético | 1 | Shell 10W-40 Semisintetico HX7 (1) |
| Daver 15W-40 Semisintético | 1 | Daver 15W40 semi (1) |
| Chronus 12W-40 Semisintético | 1 | 12w40 Chronus Semi (1) |
| Lubrikon SAE 50 | 1 | Sae 50 Lubrikon (1) |
| Royal 15W-40 Semisintético | 1 | Royal 15W40 semi (1) |
| Mobil 15W-40 Semisintético | 1 | Mobil 15w40 Semi-sintetico (1) |
| Shell HX7 10W-40 | 1 | Shell 10w40 HX7 (1) |
| Mobil Delvac Diesel 15W-40 | 1 | Movil Delmac 15W40 Diesel (1) |
| Prueba Aceite 64 | 1 | PRUEBA ACEITE 64 (1) |
| Sky Evolub 20W-50 Semisintético | 1 | SKY EVOLUB 20W-50 SEMISINTETICO (1) |
| Brava 20W-50 | 1 | brava 20 50 (1) |
| Motorcraft 10W-30 Semisintético | 1 | MotorCraft 10w30 Semi (1) |
| Fanfaro 20W-50 Semisintético | 1 | GALON 20W50 SEMISINTETICO FANFARO (1) |
| Toyota 0W-20 Sintético | 1 | TOYOTA 0W-20 SINTETICO (1) |
| Daver 20W-50 Semisintético | 1 | Daver 20W50 semi (1) |
| Inca 20W-40 Semisintético | 1 | Inca 20W40 semi (1) |
| Mobil | 1 | Mobil (1) |
| Brava 20W-20 Semisintético | 1 | Brava 20W20 semi (1) |
| Valvoline 5W-20 Sintético | 1 | Valvoline 5W20 Full Sintetico (1) |
| Inca 15W-40 | 1 | Inca 15W40 (1) |
| K9 15W-40 Semisintético | 1 | K9 15W-40 SEMISINTETICO (1) |
| Fanfaro 20W-50 Mineral | 1 | Fanfaro 20w50 Mineral (1) |
| Shell 15W-40 Mineral | 1 | Shell 15w40 Mineral (1) |
| Sky Evolub 20W-50 Mineral | 1 | 6 litros de Sky Evolub 20W50 mineral (1) |
| Voltex 15W-40 Semisintético | 1 | VOLTEX 15W40 SEMISINTETICO LITRO (1) |
| Shell Helix HX7 10W-40 Semisintético | 1 | SHELL HELIX 10W40 SEMISINTETICO HX7 (1) |
| Lirax 15W-40 | 1 | Lirax 15W40 (1) |
| Goodyear 10W-30 Sintético | 1 | GOODYEAR 10W30 FULL SINTETICO (1) |
| Valvoline 20W-50 | 1 | Valvoline 20W50 (1) |
| Sky Evolub 20W-50 | 1 | Sky 20w50 Evolub (1) |
| Dr. Care 20W-50 | 1 | Dr Care 20W50 garrafa (1) |
| Dauer 15W-40 Mineral | 1 | Dauer 15w40 mineral (1) |
| Bandol 20W-50 Mineral | 1 | BANDOL 20W-50 MINERAL (1) |
| Motorcraft | 1 | Motorcraft (1) |
| Motul 4100 15W-40 | 1 | Motul 15w40 4100 (1) |
| Mobil Delvac 15W-40 | 1 | Mobil Delvac 15w40 (1) |
| (vacío) | 1 | 6 Lit. (1) |
| Venoco 5W-40 Sintético | 1 | Venoco 5W40 full sintético (1) |
