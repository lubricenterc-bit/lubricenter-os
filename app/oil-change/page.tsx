import { redirect } from "next/navigation";

export default function OilChangeRedirectPage() {
  redirect("/orders/new");
}
