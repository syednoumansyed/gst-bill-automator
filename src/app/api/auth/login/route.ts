import { NextRequest, NextResponse } from "next/server";
import { checkPassword, createSessionToken, isAuthEnabled, SESSION_COOKIE } from "@/lib/auth";
import { isJsonRequest, rejectCrossOrigin } from "@/lib/requestGuards";
import { isShareMode } from "@/lib/shareMode";

export const dynamic = "force-dynamic";

const FAILED_LOGIN_DELAY_MS = 1000;
// One owner, so one global budget: at most 5 wrong passwords per minute, counted before the compare runs
const MAX_FAILURES_PER_WINDOW = 5;
const FAILURE_WINDOW_MS = 60_000;
let recentFailures: number[] = [];

// Exchange ADMIN_PASSWORD for an httpOnly, SameSite=Strict session cookie
export async function POST(req: NextRequest) {
  if (isShareMode()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const crossOrigin = rejectCrossOrigin(req);
  if (crossOrigin) return crossOrigin;
  if (!isJsonRequest(req.headers)) {
    return NextResponse.json({ error: "Send the password as application/json." }, { status: 415 });
  }
  if (!isAuthEnabled()) {
    return NextResponse.json({ error: "No ADMIN_PASSWORD is set, so there is nothing to sign in to." }, { status: 400 });
  }

  const now = Date.now();
  recentFailures = recentFailures.filter((t) => now - t < FAILURE_WINDOW_MS);
  if (recentFailures.length >= MAX_FAILURES_PER_WINDOW) {
    return NextResponse.json({ error: "Too many wrong passwords. Wait a minute and try again." }, { status: 429 });
  }
  // Reserve the attempt now so parallel guesses can't all pass the check above
  recentFailures.push(now);

  let password: unknown;
  try {
    password = ((await req.json()) as { password?: unknown })?.password;
  } catch {
    password = undefined;
  }
  if (checkPassword(password)) {
    recentFailures.splice(recentFailures.indexOf(now), 1);
  } else {
    // Slow down guessing; the compare itself is constant-time
    await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
    return NextResponse.json({ error: "Wrong password." }, { status: 401 });
  }

  const session = createSessionToken();
  const res = NextResponse.json({ success: true });
  res.cookies.set(SESSION_COOKIE, session.value, {
    httpOnly: true,
    sameSite: "strict",
    secure: isHttps(req),
    path: "/",
    maxAge: session.maxAgeSeconds,
  });
  return res;
}

function isHttps(req: NextRequest): boolean {
  return req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https";
}
