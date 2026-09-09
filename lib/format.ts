export const fmtRef = (value: number | string | null | undefined) =>
  `$${Number(value ?? 0).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const fmtVes = (value: number | string | null | undefined) =>
  `Bs. ${Number(value ?? 0).toLocaleString("es-VE", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export const fmtDate = (value: string | Date) =>
  new Intl.DateTimeFormat("es-VE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
