import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { rejectCrossOrigin } from "@/lib/requestGuards";
import { isShareMode } from "@/lib/shareMode";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (isShareMode()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const crossOrigin = rejectCrossOrigin(req);
  if (crossOrigin) return crossOrigin;
  const res = NextResponse.json({ success: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
  return res;
}
