"use client";

export function ReceiptPrintButton() {
  function print() {
    const receipt = document.querySelector<HTMLElement>(".receipt-paper");
    // Use the rendered roll length rather than an A4 sheet or a clipped fixed height.
    const heightMm = Math.max(80, Math.ceil((receipt?.scrollHeight ?? 600) * 25.4 / 96) + 6);
    const style = document.createElement("style");
    style.textContent = `@media print { @page { size: 58mm ${heightMm}mm; margin: 0; } }`;
    document.head.appendChild(style);
    const cleanup = () => { style.remove(); window.removeEventListener("afterprint", cleanup); };
    window.addEventListener("afterprint", cleanup);
    window.print();
  }
  return <button className="btn btn-primary" onClick={print}>Imprimir 58 mm</button>;
}

