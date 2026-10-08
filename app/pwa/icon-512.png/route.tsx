import { renderBrandPng } from "@/lib/brand-image";
export async function GET() { return renderBrandPng(512, "#222222"); }
