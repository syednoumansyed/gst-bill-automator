import { afterEach, describe, expect, it, vi } from "vitest";
import { guardGenerateRequest } from "@/lib/requestGuards";

function req(headers: Record<string, string>, cookie?: string) {
  const h = new Headers(headers);
  return { headers: h, cookies: { get: (name: string) => (cookie && name ? { value: cookie } : undefined) } };
}

describe("guardGenerateRequest", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("allows same-origin requests to localhost", () => {
    expect(guardGenerateRequest(req({ host: "localhost:3002", origin: "http://localhost:3002" }))).toBeNull();
  });

  it("refuses a remote or DNS-rebinding host when no ADMIN_PASSWORD is set", async () => {
    const res = guardGenerateRequest(req({ host: "evil.example" }));
    expect(res?.status).toBe(403);
  });

  it("refuses cross-origin posts", () => {
    expect(guardGenerateRequest(req({ host: "localhost:3002", origin: "https://evil.example" }))?.status).toBe(403);
  });

  it("requires a session when ADMIN_PASSWORD is set", () => {
    vi.stubEnv("ADMIN_PASSWORD", "correct horse battery staple");
    expect(guardGenerateRequest(req({ host: "gst.example.com" }))?.status).toBe(401);
  });

  it("lets anyone generate in share mode", () => {
    vi.stubEnv("SHARE_MODE", "1");
    expect(guardGenerateRequest(req({ host: "share.example.vercel.app" }))).toBeNull();
  });
});
