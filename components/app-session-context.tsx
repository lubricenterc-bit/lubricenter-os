"use client";

import { createContext, useContext } from "react";
import type { NavigationRole } from "@/lib/navigation";

export type AppSession = {
  role: NavigationRole;
  roleLoaded: boolean;
  locationName: string;
};
const Context = createContext<AppSession>({
  role: "OPERATOR",
  roleLoaded: false,
  locationName: "Cabudare"
});
export const AppSessionProvider = Context.Provider;
export function useAppSession() {
  return useContext(Context);
}
