"use client";

import { useEffect, useMemo } from "react";
import { usePathname } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

const INACTIVITY_LIMIT_MS = 60 * 60 * 1000; // 1 hour
const ACTIVITY_STORAGE_KEY = "kozmos:last_activity_at";
const ACTIVITY_WRITE_THROTTLE_MS = 15 * 1000;

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
    let disposed = false;
    let signingOut = false;
    let lastWriteAt = 0;

    const redirectIfProtected = () => {
      if (isProtectedPath(window.location.pathname)) {
        window.location.replace("/");
      }
    };

    const parseLastActivity = () => {
      const raw = localStorage.getItem(ACTIVITY_STORAGE_KEY);
      if (!raw) return null;
      const value = Number(raw);
      if (!Number.isFinite(value)) return null;
      return value;
    };

    const markActivity = (force = false) => {
      const now = Date.now();
      if (!force && now - lastWriteAt < ACTIVITY_WRITE_THROTTLE_MS) {
        return;
      }
      localStorage.setItem(ACTIVITY_STORAGE_KEY, String(now));
      lastWriteAt = now;
    };

    const ensureSessionAndInactivity = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (disposed) return;

      if (!session) {
        redirectIfProtected();
        return;
      }

      const lastActivity = parseLastActivity();
      if (!lastActivity) {
        markActivity(true);
        return;
      }

      const inactiveMs = Date.now() - lastActivity;
      if (inactiveMs < INACTIVITY_LIMIT_MS || signingOut) {
        return;
      }

      signingOut = true;
      await supabase.auth.signOut();
      signingOut = false;
      redirectIfProtected();
    };

    void ensureSessionAndInactivity();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || !session) {
        redirectIfProtected();
        return;
      }

      if (event === "SIGNED_IN" || event === "USER_UPDATED") {
        markActivity(true);
      }
    });

    const onActivity = () => {
      markActivity();
    };

    const onFocus = () => {
      void ensureSessionAndInactivity();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void ensureSessionAndInactivity();
      }
    };

    const periodicCheck = window.setInterval(() => {
      void ensureSessionAndInactivity();
    }, 30 * 1000);

    window.addEventListener("pointerdown", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity);
    window.addEventListener("wheel", onActivity, { passive: true });
    window.addEventListener("touchstart", onActivity, { passive: true });
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      window.clearInterval(periodicCheck);
      subscription.unsubscribe();
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("wheel", onActivity);
      window.removeEventListener("touchstart", onActivity);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [protectedPath, pathname]);

  return null;
}
