import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

function isMobileRequest(req: NextRequest) {
  const chMobile = req.headers.get("sec-ch-ua-mobile");
  if (chMobile === "?1") return true;

  const ua = req.headers.get("user-agent") || "";
  return /(android|iphone|ipad|ipod|iemobile|windows phone|mobile|blackberry|opera mini)/i.test(
    ua
  );
}

export function proxy(req: NextRequest) {
  if (!isMobileRequest(req)) {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/api/build")) {
    return NextResponse.json(
      { error: "desktop only: build api is blocked on mobile devices" },
      { status: 403 }
    );
  }

  if (pathname === "/build" || pathname.startsWith("/build/")) {
    const url = req.nextUrl.clone();
    url.pathname = "/main";
    url.searchParams.set("build", "desktop-only");
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/build/:path*", "/api/build/:path*"],
};
