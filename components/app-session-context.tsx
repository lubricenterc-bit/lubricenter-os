"use client";

import { createContext, useContext } from "react";
import type { NavigationRole } from "@/lib/navigation";
import type { MyProfile } from "@/lib/profile";

export type AppSession = {
  role: NavigationRole;
  roleLoaded: boolean;
  locationName: string;
  /** Persona que inició sesión; null mientras carga o si la RPC falla. */
  profile: MyProfile | null;
};
const Context = createContext<AppSession>({
  role: "OPERATOR",
  roleLoaded: false,
  locationName: "Cabudare",
  profile: null
});
export const AppSessionProvider = Context.Provider;
export function useAppSession() {
  return useContext(Context);
}
