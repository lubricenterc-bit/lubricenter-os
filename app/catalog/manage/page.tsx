import { redirect } from "next/navigation";

// El catálogo y el inventario son una sola fuente: todo se edita en Inventario.
export default function Page() {
  redirect("/inventory");
}
