"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Gotin } from "@/components/gotin";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(pathname === "/login");
  const publicDesignLab = pathname === "/design-lab" && process.env.NEXT_PUBLIC_DESIGN_LAB_PUBLIC === "1";

  useEffect(() => {
    if (pathname === "/login" || publicDesignLab) {
      setReady(true);
      return;
    }
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      if (!data.session) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      else setReady(true);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session && pathname !== "/login") router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    });
    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, [pathname, publicDesignLab, router]);

  // Pantalla de arranque de marca mientras se confirma la sesión (aparece solo si tarda).
  if (!ready) return <div className="os-theme os-boot live" role="status" aria-live="polite">
    <span className="sr-only">Cargando Lubricenter OS…</span>
    <div className="os-boot-art" aria-hidden="true"><Gotin pose="wave" /></div>
    <span className="os-wordmark os-boot-mark" aria-hidden="true" />
    <span className="os-boot-bar" aria-hidden="true"><i /></span>
  </div>;
  return <>{children}</>;
}

