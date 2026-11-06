import { redirect } from "next/navigation";

// El viejo directorio de herramientas repetía el menú; la Ayuda dice dónde está cada función y cómo se usa.
export default function MorePage() {
  redirect("/ayuda");
}
