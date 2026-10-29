import { redirect } from "next/navigation";

// La lista de precios separada se retiró: los artículos, nombres y precios se administran en Inventario.
export default function ManageCatalog() {
  redirect("/inventory");
}
