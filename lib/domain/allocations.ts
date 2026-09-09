import type {
  ElectroautoAllocationInput,
  ElectroautoAllocationResult,
  WorkshopAllocationInput,
  WorkshopAllocationResult,
} from "./types";

const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function workshopAllocation(input: WorkshopAllocationInput): WorkshopAllocationResult {
  const cheoPercent = input.cheoPercent ?? 40;
  const alexisBonusPercent = input.alexisBonusPercent ?? 5;
  const cheoRef = money(input.cheoOverrideRef ?? (input.baseRef * cheoPercent) / 100);
  const alexisBonusRef = input.alexisBonusEnabled
    ? money((input.baseRef * alexisBonusPercent) / 100)
    : 0;
  const lubricenterRef = money(input.customerRef - cheoRef - alexisBonusRef);

  if (input.baseRef < 0 || input.customerRef < 0) throw new Error("Los montos no pueden ser negativos");
  if (cheoRef < 0 || alexisBonusRef < 0) throw new Error("Las participaciones no pueden ser negativas");
  if (lubricenterRef < 0) {
    throw new Error(
      "El precio al cliente no cubre las participaciones protegidas. Reduce explícitamente la parte de Cheo o elimina el bono de Alexis.",
    );
  }

  return { customerRef: money(input.customerRef), cheoRef, alexisBonusRef, lubricenterRef };
}

export function electroautoAllocation(
  input: ElectroautoAllocationInput,
): ElectroautoAllocationResult {
  const alexisPercent = input.alexisPercent ?? 40;
  const alexisRef = money(input.alexisOverrideRef ?? (input.baseRef * alexisPercent) / 100);
  const lubricenterRef = money(input.customerRef - alexisRef);

  if (input.baseRef < 0 || input.customerRef < 0) throw new Error("Los montos no pueden ser negativos");
  if (alexisRef < 0) throw new Error("La participación de Alexis no puede ser negativa");
  if (lubricenterRef < 0) {
    throw new Error(
      "El precio al cliente no cubre la participación protegida de Alexis. Ajusta explícitamente su parte.",
    );
  }

  return { customerRef: money(input.customerRef), alexisRef, lubricenterRef };
}
