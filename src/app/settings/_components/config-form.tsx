"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowLeft, Check, CheckCircle2, LogOut, Plus, Save, Trash2 } from "lucide-react";
import type { AppConfig, BankAccount } from "@/lib/config";
import { ConfigErrors, currentFinancialYear, STATE_NAMES, validateConfigInput } from "@/lib/configSchema";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/** GET /api/config: the config plus env status. Never contains a token. */
type ConfigResponse = AppConfig & {
  integrations: { airtable: boolean; blob: boolean; airtableBaseFromEnv: boolean; airtableTableFromEnv: boolean };
  status: { configExists: boolean; readOnly: boolean; authEnabled: boolean; legacySecretsIgnored: boolean; missing: string[] };
};

const BUSINESS_KEYS = [
  "legalName", "tradeName", "gstin", "pan", "address", "city", "district", "state", "pincode", "country",
  "designation", "phone", "email", "defaultSacCode", "defaultPlaceOfSupply", "defaultGstNote", "defaultServiceDescription",
] as const;
const CLIENT_KEYS = ["clientName", "clientAddress", "country", "registrationNumber", "vatId", "group"] as const;
const LUT_KEYS = ["financialYear", "filedDate", "filedAt", "arn", "rule", "formNumber", "applicableFor"] as const;

type BusinessKey = (typeof BUSINESS_KEYS)[number];
type ClientKey = (typeof CLIENT_KEYS)[number];
type LutRow = Record<(typeof LUT_KEYS)[number], string>;

/** Editable, all-string form state; posted as-is and validated by the shared schema. */
type FormConfig = {
  businessProfile: Record<BusinessKey, string>;
  luts: LutRow[];
  bankAccounts: BankAccount[];
  clientProfile: Record<ClientKey, string>;
  airtableIntegration: { baseId: string; tableName: string };
};

const pick = <K extends string>(keys: readonly K[], source: object | undefined): Record<K, string> =>
  Object.fromEntries(keys.map((k) => [k, String((source as Record<string, unknown> | undefined)?.[k] ?? "")])) as Record<K, string>;

const newLut = (): LutRow => ({
  financialYear: currentFinancialYear(), filedDate: "", filedAt: "", arn: "",
  rule: "96A", formNumber: "FORM GST RFD-11", applicableFor: "Export of services without payment of integrated tax",
});

const newBankAccount = (isPrimary: boolean): BankAccount => ({
  id: `acc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, label: isPrimary ? "Primary Account" : "New Bank Account",
  bankName: "", accountNumber: "", ifsc: "", branch: "", isPrimary,
});

function toFormConfig(data: ConfigResponse, mode: "setup" | "settings"): FormConfig {
  const form: FormConfig = {
    businessProfile: pick(BUSINESS_KEYS, data.businessProfile),
    luts: (data.luts || []).map((l) => pick(LUT_KEYS, l)),
    bankAccounts: data.bankAccounts || [],
    clientProfile: pick(CLIENT_KEYS, data.clientProfile),
    airtableIntegration: {
      baseId: data.airtableIntegration?.baseId || "",
      tableName: data.airtableIntegration?.tableName || "GST Invoices",
    },
  };
  // A fresh install starts with one row of each and no owner-specific wording
  if (form.luts.length === 0) form.luts = [newLut()];
  if (form.bankAccounts.length === 0) form.bankAccounts = [newBankAccount(true)];
  if (mode === "setup" && !data.status.configExists) {
    form.businessProfile.defaultServiceDescription = "";
    form.businessProfile.defaultPlaceOfSupply = "";
  }
  return form;
}

const inputClass = "base-ui-card shadow-none hover:translate-y-0 active:translate-y-0 active:translate-x-0";

export function ConfigForm({ mode }: { mode: "setup" | "settings" }) {
  const router = useRouter();
  const [form, setForm] = useState<FormConfig | null>(null);
  const [meta, setMeta] = useState<Pick<ConfigResponse, "integrations" | "status"> | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<ConfigErrors>({});
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  useEffect(() => {
    fetch("/api/config", { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json();
        if (r.status === 401) {
          router.replace(`/login?next=/${mode}`);
          return;
        }
        if (!r.ok || data?.error) throw new Error(data?.error || "Failed to load settings.");
        setMeta({ integrations: data.integrations, status: data.status });
        setForm(toFormConfig(data, mode));
      })
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "Failed to load settings."));
  }, [mode, router]);

  // Same schema as the server; errors show after the first save attempt and update as you type
  const clientErrors = useMemo<ConfigErrors>(() => {
    if (!form || !attempted) return {};
    const result = validateConfigInput(form);
    return result.ok ? {} : result.errors;
  }, [form, attempted]);
  const errors = { ...serverErrors, ...clientErrors };
  const errorCount = Object.keys(errors).length;

  if (loadError) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-6">
        <div className="max-w-md rounded-lg border-2 border-red-800 bg-red-100 px-6 py-5 text-sm font-medium text-red-900">{loadError}</div>
      </div>
    );
  }
  if (!form || !meta) {
    return <div className="min-h-screen bg-background flex items-center justify-center font-medium">Loading settings...</div>;
  }

  const readOnly = meta.status.readOnly;
  const isSetup = mode === "setup";

  const update = (next: FormConfig) => {
    setForm(next);
    setServerErrors({});
  };
  const setBusiness = (key: BusinessKey, value: string) =>
    update({ ...form, businessProfile: { ...form.businessProfile, [key]: value } });
  const setClient = (key: ClientKey, value: string) =>
    update({ ...form, clientProfile: { ...form.clientProfile, [key]: value } });
  const setLut = (index: number, key: keyof LutRow, value: string) =>
    update({ ...form, luts: form.luts.map((l, i) => (i === index ? { ...l, [key]: value } : l)) });
  const setBank = (id: string, key: keyof BankAccount, value: string | boolean) => {
    // Exactly one primary: choosing one clears the rest
    const accounts = form.bankAccounts.map((a) =>
      key === "isPrimary" ? { ...a, isPrimary: a.id === id } : a.id === id ? { ...a, [key]: value } : a,
    );
    update({ ...form, bankAccounts: accounts });
  };
  const removeBank = (id: string) => {
    const accounts = form.bankAccounts.filter((a) => a.id !== id);
    if (accounts.length > 0 && !accounts.some((a) => a.isPrimary)) accounts[0] = { ...accounts[0], isPrimary: true };
    update({ ...form, bankAccounts: accounts });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    setMessage(null);
    const result = validateConfigInput(form);
    if (!result.ok) {
      setMessage({ text: "Some fields need fixing. They're marked in red.", type: "error" });
      focusField(Object.keys(result.errors)[0]);
      return;
    }

    setSaving(true);
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    }).catch(() => null);
    setSaving(false);
    const data = res ? await res.json().catch(() => ({})) : {};

    if (res?.ok) {
      if (isSetup) {
        router.push("/");
        return;
      }
      setMessage({ text: "Settings saved.", type: "success" });
      setTimeout(() => setMessage(null), 3000);
    } else if (res?.status === 401) {
      router.replace(`/login?next=/${mode}`);
    } else {
      if (data?.fieldErrors) {
        setServerErrors(data.fieldErrors);
        focusField(Object.keys(data.fieldErrors)[0]);
      }
      setMessage({ text: data?.error || "Failed to save settings.", type: "error" });
    }
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  };

  const field = (
    path: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    opts: { hint?: string; placeholder?: string; type?: string; required?: boolean; wide?: boolean; textarea?: boolean; upper?: boolean } = {},
  ) => (
    <div key={path} className={`space-y-2 ${opts.wide ? "md:col-span-2" : ""}`}>
      <Label htmlFor={path} className="font-semibold">
        {label}
        {opts.required && <span className="text-red-600"> *</span>}
      </Label>
      {opts.textarea ? (
        <Textarea
          id={path}
          rows={2}
          className={`${inputClass} resize-none ${errors[path] ? "!border-red-600" : ""}`}
          value={value}
          placeholder={opts.placeholder}
          disabled={readOnly}
          aria-invalid={!!errors[path]}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          id={path}
          type={opts.type || "text"}
          className={`${inputClass} ${opts.upper ? "uppercase" : ""} ${errors[path] ? "!border-red-600" : ""}`}
          value={value}
          placeholder={opts.placeholder}
          disabled={readOnly}
          aria-invalid={!!errors[path]}
          onChange={(e) => onChange(opts.upper ? e.target.value.toUpperCase() : e.target.value)}
        />
      )}
      {errors[path] ? (
        <p className="text-xs font-semibold text-red-700">{errors[path]}</p>
      ) : opts.hint ? (
        <p className="text-xs text-muted-foreground">{opts.hint}</p>
      ) : null}
    </div>
  );
  const bp = form.businessProfile;
  const biz = (key: BusinessKey, label: string, opts?: Parameters<typeof field>[4]) =>
    field(`businessProfile.${key}`, label, bp[key], (v) => setBusiness(key, v), opts);
  const stateOptions = STATE_NAMES.includes(bp.state) || !bp.state ? STATE_NAMES : [bp.state, ...STATE_NAMES];

  return (
    <div className="min-h-screen bg-[#FAF8F3] py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight">{isSetup ? "Set up your business" : "Configuration"}</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {isSetup
                ? "Five short sections. Fields marked * are required before you can generate an invoice."
                : "Edit anything, then save. The same checks run as during setup."}
            </p>
          </div>
          <div className="flex gap-3">
            {meta.status.authEnabled && (
              <Button type="button" variant="outline" className="base-ui-card" onClick={logout}>
                <LogOut className="mr-2 h-4 w-4" /> Sign out
              </Button>
            )}
            <Button variant="outline" asChild className="base-ui-card">
              <Link href="/">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Generator
              </Link>
            </Button>
          </div>
        </div>

        {readOnly && (
          <Notice tone="warning">
            This deployment reads its settings from the <code>BUSINESS_CONFIG_JSON</code> environment variable, so they can&apos;t be saved here.
          </Notice>
        )}

        <form onSubmit={handleSave} className="space-y-8" noValidate>
          {/* ─── 1. Business identity ─── */}
          <Section step={isSetup ? 1 : undefined} title="Business identity" description="Your GST-registered business. Printed in the invoice header.">
            {biz("legalName", "Legal name", { required: true, hint: "As on your GST registration." })}
            {biz("tradeName", "Trade name", { hint: "Optional. Shown above the legal name." })}
            {biz("gstin", "GSTIN", { required: true, upper: true, placeholder: "29ABCDE1234F1ZW", hint: "15 characters: state code, PAN, entity number, Z, check character." })}
            {biz("pan", "PAN", { required: true, upper: true, placeholder: "ABCDE1234F" })}
            {biz("address", "Address", { required: true, wide: true, textarea: true })}
            {biz("city", "City")}
            {biz("district", "District")}
            <div className="space-y-2">
              <Label htmlFor="businessProfile.state" className="font-semibold">State<span className="text-red-600"> *</span></Label>
              <select
                id="businessProfile.state"
                className={`flex h-9 w-full rounded-md border bg-white px-3 text-sm ${inputClass} ${errors["businessProfile.state"] ? "!border-red-600" : ""}`}
                value={bp.state}
                disabled={readOnly}
                onChange={(e) => setBusiness("state", e.target.value)}
              >
                <option value="">Choose your state</option>
                {stateOptions.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              {errors["businessProfile.state"] && <p className="text-xs font-semibold text-red-700">{errors["businessProfile.state"]}</p>}
            </div>
            {biz("pincode", "Pincode", { required: true, placeholder: "560001" })}
            {biz("country", "Country")}
            {biz("designation", "Signatory designation", { placeholder: "Proprietor" })}
            {biz("phone", "Phone")}
            {biz("email", "Email", { type: "email" })}
          </Section>

          {/* ─── 2. LUT per financial year ─── */}
          <Section
            step={isSetup ? 2 : undefined}
            title="Letter of Undertaking (LUT)"
            description="File one LUT (FORM GST RFD-11) per financial year (April to March). Each invoice uses the LUT for its own year."
            action={
              <Button type="button" variant="outline" className="base-ui-card" disabled={readOnly}
                onClick={() => update({ ...form, luts: [...form.luts, { ...newLut(), financialYear: "" }] })}>
                <Plus className="h-4 w-4 mr-2" /> Add year
              </Button>
            }
          >
            <div className="md:col-span-2 space-y-6">
              {errors["luts"] && <p className="text-xs font-semibold text-red-700">{errors["luts"]}</p>}
              {form.luts.map((lut, i) => (
                <div key={i} className="relative border-2 border-border rounded-lg p-6 bg-slate-50/50">
                  {form.luts.length > 1 && (
                    <Button type="button" variant="outline" size="sm" disabled={readOnly} aria-label="Remove this LUT"
                      onClick={() => update({ ...form, luts: form.luts.filter((_, j) => j !== i) })}
                      className="absolute top-4 right-4 text-xs h-7 text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200">
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {field(`luts.${i}.financialYear`, "Financial year", lut.financialYear, (v) => setLut(i, "financialYear", v), { required: true, placeholder: "2026-27" })}
                    {field(`luts.${i}.filedDate`, "Filed on", lut.filedDate, (v) => setLut(i, "filedDate", v), { required: true, type: "date" })}
                    {field(`luts.${i}.arn`, "ARN", lut.arn, (v) => setLut(i, "arn", v), { upper: true, placeholder: "AD290426000123X", hint: "Optional. Printed on the invoice when set." })}
                    {field(`luts.${i}.filedAt`, "Filed at", lut.filedAt, (v) => setLut(i, "filedAt", v), { placeholder: "GST portal" })}
                    {field(`luts.${i}.rule`, "Rule", lut.rule, (v) => setLut(i, "rule", v))}
                    {field(`luts.${i}.formNumber`, "Form", lut.formNumber, (v) => setLut(i, "formNumber", v))}
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* ─── 3. Bank accounts ─── */}
          <Section
            step={isSetup ? 3 : undefined}
            title="Bank accounts"
            description="The primary account is printed in the invoice footer."
            action={
              <Button type="button" onClick={() => update({ ...form, bankAccounts: [...form.bankAccounts, newBankAccount(form.bankAccounts.length === 0)] })}
                variant="outline" className="base-ui-card" disabled={readOnly}>
                <Plus className="h-4 w-4 mr-2" /> Add account
              </Button>
            }
          >
            <div className="md:col-span-2 space-y-6">
              {errors["bankAccounts"] && <p className="text-xs font-semibold text-red-700">{errors["bankAccounts"]}</p>}
              {form.bankAccounts.map((account, i) => (
                <div key={account.id} className="relative border-2 border-border rounded-lg p-6 bg-slate-50/50">
                  <div className="absolute top-4 right-4 flex items-center gap-2">
                    {account.isPrimary ? (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-100 text-green-800 text-xs font-bold border-2 border-green-800">
                        <Check className="h-3 w-3" /> Primary
                      </span>
                    ) : (
                      <>
                        <Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={() => setBank(account.id, "isPrimary", true)} className="text-xs h-7 base-ui-card">
                          Set as Primary
                        </Button>
                        <Button type="button" variant="outline" size="sm" disabled={readOnly} aria-label="Remove this account" onClick={() => removeBank(account.id)}
                          className="text-xs h-7 text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200">
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </>
                    )}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
                    {field(`bankAccounts.${i}.label`, "Account label", account.label, (v) => setBank(account.id, "label", v), { placeholder: "e.g. HDFC Current" })}
                    {field(`bankAccounts.${i}.bankName`, "Bank name", account.bankName, (v) => setBank(account.id, "bankName", v), { required: true })}
                    {field(`bankAccounts.${i}.accountNumber`, "Account number", account.accountNumber, (v) => setBank(account.id, "accountNumber", v), { required: true })}
                    {field(`bankAccounts.${i}.ifsc`, "IFSC", account.ifsc, (v) => setBank(account.id, "ifsc", v), { required: true, upper: true, placeholder: "HDFC0001234" })}
                    {field(`bankAccounts.${i}.branch`, "Branch", account.branch, (v) => setBank(account.id, "branch", v))}
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* ─── 4. Default client ─── */}
          <Section step={isSetup ? 4 : undefined} title="Default client" description="Used when the Deel invoice doesn't show the client. Values read from Deel always win.">
            {field("clientProfile.clientName", "Client name", form.clientProfile.clientName, (v) => setClient("clientName", v), { required: true })}
            {field("clientProfile.country", "Country", form.clientProfile.country, (v) => setClient("country", v))}
            {field("clientProfile.vatId", "VAT ID", form.clientProfile.vatId, (v) => setClient("vatId", v))}
            {field("clientProfile.registrationNumber", "Registration number", form.clientProfile.registrationNumber, (v) => setClient("registrationNumber", v))}
            {field("clientProfile.clientAddress", "Client address", form.clientProfile.clientAddress, (v) => setClient("clientAddress", v), { wide: true, textarea: true })}
          </Section>

          {/* ─── 5. Invoice defaults ─── */}
          <Section step={isSetup ? 5 : undefined} title="Invoice defaults" description="Applied to every invoice. You can still override them for a single run.">
            {biz("defaultSacCode", "SAC code", { required: true, placeholder: "998392" })}
            {biz("defaultPlaceOfSupply", "Place of supply", { required: true, placeholder: "Outside India (client's country)" })}
            {biz("defaultServiceDescription", "Service description", { required: true, wide: true, placeholder: "e.g. Software Development Services", hint: "Replaces Deel's \"Fixed rate\" line; the service period is added after it." })}
            {biz("defaultGstNote", "Export statement", { required: true, wide: true, textarea: true })}
          </Section>

          {/* ─── Integrations: status only, secrets live in env ─── */}
          {!isSetup && (
            <Section title="Integrations (Airtable)" description="Optional. Logs every invoice to an Airtable base. Tokens are read from the environment only and never shown here.">
              <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-4">
                <EnvStatus label="Airtable token" envVar="AIRTABLE_API_KEY" configured={meta.integrations.airtable} />
                <EnvStatus label="Blob storage token" envVar="BLOB_READ_WRITE_TOKEN" configured={meta.integrations.blob} />
              </div>
              {meta.status.legacySecretsIgnored && (
                <div className="md:col-span-2">
                  <Notice tone="warning">
                    business.json still contains an Airtable or Blob token. It&apos;s ignored now: set <code>AIRTABLE_API_KEY</code> and{" "}
                    <code>BLOB_READ_WRITE_TOKEN</code> in the environment instead. Saving these settings removes the token from the file.
                  </Notice>
                </div>
              )}
              {field("airtableIntegration.baseId", "Base ID", form.airtableIntegration.baseId,
                (v) => update({ ...form, airtableIntegration: { ...form.airtableIntegration, baseId: v } }),
                { placeholder: "appXXXXXXXXXXXXXX", hint: meta.integrations.airtableBaseFromEnv ? "AIRTABLE_BASE_ID is set and takes precedence." : undefined })}
              {field("airtableIntegration.tableName", "Table name", form.airtableIntegration.tableName,
                (v) => update({ ...form, airtableIntegration: { ...form.airtableIntegration, tableName: v } }),
                { placeholder: "GST Invoices", hint: meta.integrations.airtableTableFromEnv ? "AIRTABLE_TABLE_NAME is set and takes precedence." : undefined })}
            </Section>
          )}

          <div className="flex flex-wrap items-center justify-end gap-6 pb-20">
            {message && (
              <div role="status" className={`flex items-center px-4 py-2 rounded-md font-bold text-sm ${message.type === "success" ? "bg-green-100 text-green-800 border-2 border-green-800" : "bg-red-100 text-red-800 border-2 border-red-800"}`}>
                {message.type === "success" ? <CheckCircle2 className="w-4 h-4 mr-2" /> : <AlertCircle className="w-4 h-4 mr-2" />}
                {message.text}
                {message.type === "error" && errorCount > 0 && ` (${errorCount})`}
              </div>
            )}
            <Button type="submit" disabled={saving || readOnly} className="base-ui-card px-8 py-6 text-base">
              <Save className="mr-2 h-5 w-5" />
              {saving ? "Saving..." : isSetup ? "Save and start" : "Save Configuration"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function focusField(path: string | undefined) {
  if (!path) return;
  // Array-level errors ("bankAccounts") have no input; fall back to the first field in that list
  const el = document.getElementById(path) || document.querySelector<HTMLElement>(`[id^="${CSS.escape(path)}."]`);
  el?.scrollIntoView({ behavior: "smooth", block: "center" });
  el?.focus({ preventScroll: true });
}

function Section({ step, title, description, action, children }: {
  step?: number; title: string; description: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden base-ui-card bg-white hover:translate-x-0 hover:translate-y-0">
      <CardHeader className="bg-primary/5 border-b-2 border-border pb-6 flex flex-row items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          {step !== undefined && (
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-black bg-[#FFE36F] text-sm font-black">{step}</span>
          )}
          <div>
            <CardTitle className="text-xl">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
        {action}
      </CardHeader>
      <CardContent className="pt-6 grid grid-cols-1 md:grid-cols-2 gap-6">{children}</CardContent>
    </Card>
  );
}

function EnvStatus({ label, envVar, configured }: { label: string; envVar: string; configured: boolean }) {
  return (
    <div className={`rounded-lg border-2 px-4 py-3 text-sm ${configured ? "border-green-800 bg-green-50" : "border-border bg-slate-50"}`}>
      <p className="font-semibold">{label}</p>
      <p className="text-muted-foreground">
        {configured ? "Configured via environment" : "Not set"} (<code>{envVar}</code>)
      </p>
    </div>
  );
}

function Notice({ tone, children }: { tone: "warning"; children: React.ReactNode }) {
  return (
    <div className={`rounded-lg border-2 px-4 py-3 text-sm font-medium ${tone === "warning" ? "border-amber-900 bg-amber-100 text-amber-950" : ""}`}>
      {children}
    </div>
  );
}
