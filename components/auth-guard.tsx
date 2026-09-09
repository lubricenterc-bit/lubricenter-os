"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(pathname === "/login");

  useEffect(() => {
    if (pathname === "/login") {
      setReady(true);
      return;
    }
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      if (!data.session) router.replace("/login");
      else setReady(true);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session && pathname !== "/login") router.replace("/login");
    });
    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, [pathname, router]);

  if (!ready) return <div className="container"><div className="card">Cargando Lubricenter OS…</div></div>;
  return <>{children}</>;
}
