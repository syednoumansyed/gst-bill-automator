"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm({ returnTo }: { returnTo: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) {
      router.replace(returnTo);
      router.refresh();
      return;
    }
    const data = res ? await res.json().catch(() => ({})) : {};
    setError(data?.error || "Sign-in failed.");
    setPassword("");
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="password" className="font-semibold">Admin password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          className="base-ui-card shadow-none hover:translate-y-0 active:translate-y-0 active:translate-x-0"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p role="alert" className="text-xs font-semibold text-red-700">{error}</p>}
      </div>
      <Button type="submit" disabled={busy || !password} className="base-ui-card w-full">
        {busy ? "Signing in..." : "Sign in"}
      </Button>
    </form>
  );
}
