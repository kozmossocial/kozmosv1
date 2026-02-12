"use client";

import { useEffect, useMemo } from "react";
import { usePathname } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

function isProtectedPath(pathname: string) {
  return (
    pathname === "/main" ||
    pathname.startsWith("/main/") ||
    pathname === "/my-home" ||
    pathname === "/build" ||
    pathname.startsWith("/build/") ||
    pathname === "/account"
  );
}

export default function AuthSyncGuard() {
  const pathname = usePathname();
  const protectedPath = useMemo(() => isProtectedPath(pathname), [pathname]);

  useEffect(() => {
    if (!protectedPath) return;

    const redirectHome = () => {
      window.location.replace("/");
    };

    const ensureSession = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        redirectHome();
      }
    };

    void ensureSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || !session) {
        redirectHome();
      }
    });

    const onFocus = () => {
      void ensureSession();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void ensureSession();
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      subscription.unsubscribe();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [protectedPath]);

  return null;
}
