import type { ReceiptData } from "../lib/receipt";

const header = { branch: "Cabudare", address: null, whatsapp: null, instagram: null, rif: null, legend: "Nota de entrega · Documento no fiscal", total_style: "BLOCK" as const };

export const oilChange: ReceiptData = {
  header,
  order: { number: "OS-000378", status: "CLOSED", at: "2026-11-04T13:17:33.081Z", attendant: "Edgar" },
  customer: { name: "Felipe Díaz", phone_tail: "5769" },
  vehicle: { label: "Chery X1", plate: "AD922MD", odometer: 158283 },
  lines: [
    { name: "BRAVA 15W40 MINERAL", qty: 5, unit_label: "L", unit_price_ref: 9, total_ref: 45, kind: "PRODUCT", courtesy: false },
    { name: "Filtro de aceite A1 AL-3614", qty: 1, unit_label: null, unit_price_ref: 5, total_ref: 5, kind: "PRODUCT", courtesy: false },
    { name: "Cambio de aceite", qty: 1, unit_label: "Mano de obra", unit_price_ref: 0, total_ref: 0, kind: "SERVICE", courtesy: true },
  ],
  adjustments: { discount_ref: 0, rounding_ref: 0 },
  totals: { ref: 50, ves: 44660.89, bcv_rate: 893.2173 },
  payments: [{ label: "Pago móvil · Banco de Venezuela", ref_tail: "1328", currency: "VES", amount: 44660.89 }],
  change: [],
  cashea: null,
  credit: null,
  next_service: { odometer: 163283, date: "2027-02-04", oil: "Brava 15w40", filter: "AL-3614" },
};

export const casheaSale: ReceiptData = {
  ...oilChange,
  order: { number: "OS-000354", status: "CLOSED", at: "2026-11-03T19:05:00.000Z", attendant: "Ender" },
  customer: { name: "Dioni Quiñones", phone_tail: "4567" },
  vehicle: { label: "Toyota 4Runner", plate: "AB123CD", odometer: null },
  lines: [
    { name: "Pastillas de freno delanteras", qty: 1, unit_label: null, unit_price_ref: 38, total_ref: 38, kind: "PRODUCT", courtesy: false },
    // Mano de obra con el recargo de Cashea ya sumado (no sale como línea aparte).
    { name: "Cambio de pastillas", qty: 1, unit_label: null, unit_price_ref: 102, total_ref: 102, kind: "SERVICE", courtesy: false },
  ],
  totals: { ref: 140, ves: 124496.4, bcv_rate: 889.26 },
  payments: [{ label: "Pago móvil · BNC", ref_tail: "9708", currency: "VES", amount: 49798.56 }],
  cashea: { initial_percent: 40, initial_ref: 56, installments: [
    { no: 1, due: "2026-11-17", amount_ref: 28, status: "PENDING" },
    { no: 2, due: "2026-12-01", amount_ref: 28, status: "PENDING" },
    { no: 3, due: "2026-12-15", amount_ref: 28, status: "PENDING" },
  ] },
  next_service: null,
};

export const cashWithChange: ReceiptData = {
  ...oilChange,
  header: { ...header, total_style: "BORDER", whatsapp: "0414 123 4567", instagram: "lubricenter" },
  order: { number: "OS-000390", status: "CLOSED", at: "2026-11-04T15:40:00.000Z", attendant: null },
  customer: null,
  vehicle: null,
  lines: [
    { name: "Fanfaro 5w40 Full Sintético", qty: 2, unit_label: "L", unit_price_ref: 12.5, total_ref: 25, kind: "PRODUCT", courtesy: false },
    { name: "Limpiador de inyectores", qty: 1, unit_label: null, unit_price_ref: 8.4, total_ref: 8.4, kind: "PRODUCT", courtesy: false },
  ],
  totals: { ref: 33.4, ves: 29701.28, bcv_rate: 889.26 },
  payments: [{ label: "Efectivo USD", ref_tail: null, currency: "USD", amount: 33.4 }],
  change: [{ received: 40, currency: "USD", returned_usd: 6.6, pending_usd: 0 }],
  next_service: null,
};
