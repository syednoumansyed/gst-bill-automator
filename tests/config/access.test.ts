import { afterEach, describe, expect, it } from "vitest";
import { checkPassword, createSessionToken, isAuthEnabled, SESSION_COOKIE, verifySessionToken } from "../../src/lib/auth";
import { configAccess, crossOriginProblem, guardConfigRequest, isJsonRequest, isLocalHost } from "../../src/lib/requestGuards";

const saved = { password: process.env.ADMIN_PASSWORD, share: process.env.SHARE_MODE };
afterEach(() => {
  if (saved.password === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = saved.password;
  if (saved.share === undefined) delete process.env.SHARE_MODE;
  else process.env.SHARE_MODE = saved.share;
});

const headers = (values: Record<string, string>) => new Headers(values);
const request = (values: Record<string, string>, cookie?: string) => ({
  headers: headers(values),
  cookies: { get: (name: string) => (name === SESSION_COOKIE && cookie ? { value: cookie } : undefined) },
});

describe("isLocalHost", () => {
  it("accepts loopback hosts with optional port", () => {
    for (const host of ["localhost", "localhost:3014", "127.0.0.1", "127.0.0.1:8080", "[::1]", "[::1]:3000", "LOCALHOST:1"]) {
      expect(isLocalHost(host), host).toBe(true);
    }
  });

  it("rejects everything else, including DNS-rebinding style names", () => {
    for (const host of ["evil.example", "localhost.evil.example", "127.0.0.1.nip.io", "192.168.1.5:3000", "0.0.0.0", "", "localhost:abc"]) {
      expect(isLocalHost(host), host).toBe(false);
    }
    expect(isLocalHost(null)).toBe(false);
  });
});

describe("crossOriginProblem", () => {
  it("allows same-origin and originless (non-browser) requests", () => {
    expect(crossOriginProblem(headers({ host: "localhost:3014", origin: "http://localhost:3014" }))).toBeNull();
    expect(crossOriginProblem(headers({ host: "localhost:3014" }))).toBeNull();
    expect(crossOriginProblem(headers({ host: "localhost:3014", "sec-fetch-site": "same-origin" }))).toBeNull();
  });

  it("refuses other origins, opaque origins and cross-site fetches", () => {
    expect(crossOriginProblem(headers({ host: "localhost:3014", origin: "http://evil.example" }))).toMatch(/Cross-origin/);
    expect(crossOriginProblem(headers({ host: "localhost:3014", origin: "http://localhost:3015" }))).toMatch(/Cross-origin/);
    expect(crossOriginProblem(headers({ host: "localhost:3014", origin: "null" }))).toMatch(/Cross-origin/);
    expect(crossOriginProblem(headers({ host: "localhost:3014", "sec-fetch-site": "cross-site" }))).toMatch(/Cross-origin/);
  });

  it("only treats application/json as JSON", () => {
    expect(isJsonRequest(headers({ "content-type": "application/json; charset=utf-8" }))).toBe(true);
    expect(isJsonRequest(headers({ "content-type": "text/plain" }))).toBe(false);
  });
});

describe("config access", () => {
  it("without ADMIN_PASSWORD allows only localhost", () => {
    delete process.env.ADMIN_PASSWORD;
    expect(isAuthEnabled()).toBe(false);
    expect(configAccess("localhost:3014", undefined)).toEqual({ ok: true });
    expect(configAccess("evil.example", undefined)).toMatchObject({ ok: false, status: 403, reason: "host" });
  });

  it("with ADMIN_PASSWORD needs a valid session from any host", () => {
    process.env.ADMIN_PASSWORD = "correct horse";
    expect(configAccess("localhost", undefined)).toMatchObject({ ok: false, status: 401, reason: "login" });
    const { value } = createSessionToken();
    expect(configAccess("gst.example", value)).toEqual({ ok: true });
  });

  it("guards /api/config: share mode 404, cross-origin 403, JSON only, then access", () => {
    delete process.env.ADMIN_PASSWORD;
    const local = { host: "localhost:3014", origin: "http://localhost:3014", "content-type": "application/json" };
    expect(guardConfigRequest(request(local), { write: true })).toBeNull();
    expect(guardConfigRequest(request({ ...local, origin: "http://evil.example" }), { write: true })?.status).toBe(403);
    expect(guardConfigRequest(request({ ...local, "content-type": "text/plain" }), { write: true })?.status).toBe(415);
    expect(guardConfigRequest(request({ host: "evil.example" }), { write: false })?.status).toBe(403);
    process.env.SHARE_MODE = "1";
    expect(guardConfigRequest(request(local), { write: false })?.status).toBe(404);
  });
});

describe("sessions", () => {
  it("checks the password and signs expiring, tamper-proof tokens", () => {
    process.env.ADMIN_PASSWORD = "correct horse";
    expect(checkPassword("correct horse")).toBe(true);
    expect(checkPassword("wrong")).toBe(false);
    expect(checkPassword(undefined)).toBe(false);

    const now = Date.now();
    const { value, maxAgeSeconds } = createSessionToken(now);
    expect(verifySessionToken(value, now)).toBe(true);
    expect(verifySessionToken(value, now + maxAgeSeconds * 1000 + 1)).toBe(false);

    const [v, exp, sig] = value.split(".");
    expect(verifySessionToken(`${v}.${Number(exp) + 1000}.${sig}`, now)).toBe(false);
    expect(verifySessionToken(`${v}.${exp}.${sig.slice(0, -1)}A`, now)).toBe(false);

    // Changing the password signs everyone out
    process.env.ADMIN_PASSWORD = "new password";
    expect(verifySessionToken(value, now)).toBe(false);
  });

  it("never accepts tokens when no password is set", () => {
    process.env.ADMIN_PASSWORD = "x";
    const { value } = createSessionToken();
    delete process.env.ADMIN_PASSWORD;
    expect(verifySessionToken(value)).toBe(false);
    expect(checkPassword("")).toBe(false);
  });
});
