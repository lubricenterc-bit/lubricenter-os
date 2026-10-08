import { renderBrandPng } from "@/lib/brand-image";
export const size = { width: 64, height: 64 };
export const contentType = "image/png";
export default async function Icon() { return renderBrandPng(64); }
