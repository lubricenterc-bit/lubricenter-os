"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(pathname === "/login" || pathname === "/accept-invite");
  const publicDesignLab = pathname === "/design-lab" && process.env.NEXT_PUBLIC_DESIGN_LAB_PUBLIC === "1";

  useEffect(() => {
    if (pathname === "/login" || publicDesignLab) {
      setReady(true);
      return;
    }
    let mounted = true;
    setReady(false);
    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return;
      if (!data.session) { router.replace(`/login?next=${encodeURIComponent(pathname)}`); return; }
      const { data: permitted, error } = await supabase.rpc("staff_auth_allowed");
      if (!mounted) return;
      if (error || !permitted) {
        await supabase.auth.signOut();
        router.replace("/login?error=unauthorized");
        return;
      }
      setReady(true);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session && pathname !== "/login") router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    });
    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, [pathname, publicDesignLab, router]);

  if (!ready) return <div className="container"><div className="card">Cargando Lubricenter OS…</div></div>;
  return <>{children}</>;
}

