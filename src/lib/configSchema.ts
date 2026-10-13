import { z } from "zod";

/**
 * One validation schema for the business config, shared by /setup, /settings and POST /api/config.
 * Client-safe: no Node imports. Secrets (Airtable/Blob tokens) are not part of it; they come from env.
 */

// GST state codes (first two GSTIN digits). Andhra Pradesh kept 28 after 37 was added; 25 is pre-merger Daman and Diu.
export const GST_STATES: { code: string; name: string }[] = [
  { code: "01", name: "Jammu and Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "25", name: "Daman and Diu" },
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu" },
  { code: "27", name: "Maharashtra" },
  { code: "28", name: "Andhra Pradesh" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman and Nicobar Islands" },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh" },
  { code: "97", name: "Other Territory" },
  { code: "99", name: "Centre Jurisdiction" },
];

const STATE_ALIASES: Record<string, string> = {
  newdelhi: "delhi", nctofdelhi: "delhi", orissa: "odisha", pondicherry: "puducherry",
  uttaranchal: "uttarakhand",
};
const normaliseState = (name: string) => {
  const key = name.toLowerCase().replace(/&/g, "and").replace(/[^a-z]/g, "");
  return STATE_ALIASES[key] || key;
};

/** State names that match a GSTIN state code (Andhra Pradesh has two codes). */
export function stateNamesForCode(code: string): string[] {
  return GST_STATES.filter((s) => s.code === code).map((s) => s.name);
}

/** Unique state names for a picker, in code order. */
export const STATE_NAMES = [...new Set(GST_STATES.map((s) => s.name))];

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** GSTN's mod-36 check character over the first 14 characters. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const PINCODE_PATTERN = /^[1-9][0-9]{5}$/;
export const FY_PATTERN = /^(\d{4})-(\d{2})$/;

/** Problem with a GSTIN on its own (format, state code, checksum), or null when it's valid. */
export function gstinProblem(gstin: string): string | null {
  if (gstin.length !== 15) return `GSTIN must be 15 characters (it has ${gstin.length}).`;
  if (!GSTIN_PATTERN.test(gstin)) {
    return "GSTIN format is 2-digit state code + 10-character PAN + entity number + Z + check character, e.g. 29ABCDE1234F1ZW.";
  }
  if (!GST_STATES.some((s) => s.code === gstin.slice(0, 2))) {
    return `GSTIN starts with ${gstin.slice(0, 2)}, which isn't a GST state code.`;
  }
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14]) {
    return "The last character of the GSTIN doesn't match its checksum. Check for a typo.";
  }
  return null;
}

/** "2026-27" when the second year follows the first. */
export function isFinancialYear(value: string): boolean {
  const m = FY_PATTERN.exec(value);
  return !!m && (Number(m[1]) + 1) % 100 === Number(m[2]);
}

const upper = () => z.string().trim().toUpperCase();
const optionalText = () => z.string().trim().optional().default("");
const required = (label: string) => z.string({ error: `${label} is required.` }).trim().min(1, `${label} is required.`);
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export const lutSchema = z.object({
  financialYear: z.string().trim().refine(isFinancialYear, "Financial year must look like 2026-27."),
  filedDate: z.string().trim()
    .regex(isoDate, "Enter the date the LUT was filed (YYYY-MM-DD).")
    .refine((d) => !Number.isNaN(Date.parse(d)), "That filing date isn't a real date."),
  filedAt: optionalText(),
  arn: upper().optional().default("")
    .refine((v) => v === "" || /^[A-Z0-9]{15}$/.test(v), "ARN is the 15-character acknowledgement number, e.g. AD290426000123X."),
  rule: z.string().trim().optional().default("96A").transform((v) => v || "96A"),
  formNumber: z.string().trim().optional().default("FORM GST RFD-11").transform((v) => v || "FORM GST RFD-11"),
  applicableFor: z.string().trim().optional().default("Export of services without payment of integrated tax"),
});

export const bankAccountSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().optional().default(""),
  bankName: required("Bank name"),
  accountNumber: z.string().trim().regex(/^\d{9,18}$/, "Account number must be 9 to 18 digits, no spaces."),
  ifsc: upper().regex(IFSC_PATTERN, "IFSC is 11 characters: 4 letters, 0, then 6 letters or digits (e.g. HDFC0001234)."),
  branch: optionalText(),
  isPrimary: z.boolean(),
});

export const businessSchema = z.object({
  legalName: required("Legal name"),
  tradeName: optionalText(),
  gstin: upper().superRefine((v, ctx) => {
    const problem = gstinProblem(v);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  }),
  pan: upper().regex(PAN_PATTERN, "PAN is 10 characters: 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F)."),
  address: required("Address"),
  city: optionalText(),
  district: optionalText(),
  state: required("State"),
  pincode: z.string().trim().regex(PINCODE_PATTERN, "Pincode is 6 digits and doesn't start with 0."),
  country: z.string().trim().optional().default("India").transform((v) => v || "India"),
  designation: optionalText(),
  phone: optionalText(),
  email: z.string().trim().optional().default("")
    .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Enter a valid email address or leave it blank."),
  defaultSacCode: z.string().trim().regex(/^\d{6}$/, "SAC code is 6 digits (e.g. 998392)."),
  defaultPlaceOfSupply: required("Place of supply"),
  defaultGstNote: required("Export statement"),
  defaultServiceDescription: required("Service description"),
}).superRefine((bp, ctx) => {
  // The GSTIN embeds the PAN (characters 3-12) and the state code (characters 1-2)
  if (bp.gstin.slice(2, 12) !== bp.pan) {
    ctx.addIssue({ code: "custom", path: ["pan"], message: `Characters 3 to 12 of the GSTIN (${bp.gstin.slice(2, 12)}) must match the PAN.` });
  }
  const code = bp.gstin.slice(0, 2);
  const known = GST_STATES.filter((s) => normaliseState(s.name) === normaliseState(bp.state));
  if (known.length > 0 && !known.some((s) => s.code === code)) {
    const expected = stateNamesForCode(code)[0] || code;
    ctx.addIssue({ code: "custom", path: ["state"], message: `GSTIN state code ${code} is ${expected}, but the state is ${bp.state}.` });
  }
});

export const clientSchema = z.object({
  clientName: required("Client name"),
  clientAddress: optionalText(),
  country: optionalText(),
  registrationNumber: optionalText(),
  vatId: optionalText(),
  group: optionalText(),
});

export const configInputSchema = z.object({
  businessProfile: businessSchema,
  luts: z.array(lutSchema).min(1, "Add the LUT for at least one financial year.").superRefine((luts, ctx) => {
    const seen = new Set<string>();
    luts.forEach((lut, i) => {
      if (seen.has(lut.financialYear)) {
        ctx.addIssue({ code: "custom", path: [i, "financialYear"], message: `There is already an LUT for FY ${lut.financialYear}.` });
      }
      seen.add(lut.financialYear);
    });
  }),
  bankAccounts: z.array(bankAccountSchema).min(1, "Add at least one bank account.").superRefine((accounts, ctx) => {
    if (accounts.filter((a) => a.isPrimary).length !== 1) {
      ctx.addIssue({ code: "custom", message: "Mark exactly one bank account as primary." });
    }
  }),
  clientProfile: clientSchema,
  // Non-secret Airtable settings only; the token comes from AIRTABLE_API_KEY
  airtableIntegration: z.object({
    baseId: z.string().trim().optional().default("")
      .refine((v) => v === "" || /^app[A-Za-z0-9]{14}$/.test(v), "Airtable base ID starts with \"app\" and is 17 characters."),
    tableName: z.string().trim().optional().default("GST Invoices").transform((v) => v || "GST Invoices"),
  }).optional().default({ baseId: "", tableName: "GST Invoices" }),
});

export type ConfigInput = z.output<typeof configInputSchema>;
export type LutInput = z.output<typeof lutSchema>;

/** Validation errors keyed by dotted path ("bankAccounts.0.ifsc"), first message per field. */
export type ConfigErrors = Record<string, string>;

export function validateConfigInput(input: unknown):
  | { ok: true; data: ConfigInput }
  | { ok: false; errors: ConfigErrors } {
  const result = configInputSchema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  const errors: ConfigErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path.map(String).join(".") || "_";
    if (!errors[key]) errors[key] = issue.message;
  }
  return { ok: false, errors };
}

// Fields a config needs before an invoice can be generated; drives the /setup prompt on the home page
const REQUIRED_FIELDS: [string, (c: RequiredView) => unknown][] = [
  ["Legal name", (c) => c.businessProfile?.legalName],
  ["GSTIN", (c) => c.businessProfile?.gstin],
  ["PAN", (c) => c.businessProfile?.pan],
  ["Address", (c) => c.businessProfile?.address],
  ["State", (c) => c.businessProfile?.state],
  ["Pincode", (c) => c.businessProfile?.pincode],
  ["LUT", (c) => c.luts?.some((l) => l.financialYear)],
  ["Bank account", (c) => c.bankAccounts?.some((b) => b.accountNumber && b.ifsc)],
];

type RequiredView = {
  businessProfile?: Partial<Record<"legalName" | "gstin" | "pan" | "address" | "state" | "pincode", string>>;
  luts?: { financialYear?: string }[];
  bankAccounts?: { accountNumber?: string; ifsc?: string }[];
};

/** Labels of required fields that are empty. Presence only; formats are checked on save. */
export function missingRequiredFields(config: RequiredView): string[] {
  return REQUIRED_FIELDS.filter(([, get]) => {
    const v = get(config);
    return typeof v === "string" ? !v.trim() : !v;
  }).map(([label]) => label);
}

/** Indian financial year (April to March) containing a date: 2026-10-13 -> "2026-27". */
export function financialYearOf(date: string | Date): string | null {
  let year: number;
  let month: number;
  const m = typeof date === "string" ? /^(\d{4})-(\d{2})/.exec(date) : null;
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
  } else {
    const d = typeof date === "string" ? new Date(date) : date;
    if (Number.isNaN(d.getTime())) return null;
    year = d.getFullYear();
    month = d.getMonth() + 1;
  }
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** The current Indian financial year, for new LUT rows. */
export const currentFinancialYear = () => financialYearOf(new Date()) as string;

type LutLike = { financialYear: string; filedDate?: string };
const fyStart = (fy: string) => {
  const year = parseInt(fy, 10);
  return Number.isFinite(year) ? year : -1;
};

/** The LUT with the latest financial year (then latest filing date), or undefined when there are none. */
export function latestLut<T extends LutLike>(luts: T[]): T | undefined {
  return [...luts].sort((a, b) =>
    fyStart(b.financialYear) - fyStart(a.financialYear) || (b.filedDate || "").localeCompare(a.filedDate || ""),
  )[0];
}

/**
 * LUT for an invoice dated `invoiceDate`: the one filed for that financial year.
 * Without one, the most recent LUT is used and a warning explains why; generation is never blocked here.
 */
export function selectLut<T extends LutLike>(luts: T[], invoiceDate: string): { lut: T | undefined; warning?: string } {
  const fy = financialYearOf(invoiceDate);
  const match = fy ? luts.find((l) => l.financialYear === fy) : undefined;
  if (match) return { lut: match };
  const latest = latestLut(luts);
  if (!latest) {
    return { lut: undefined, warning: "No LUT is saved in Settings, so the invoice doesn't name a valid LUT. Add your LUT before filing." };
  }
  const label = latest.financialYear ? `FY ${latest.financialYear}` : "an LUT without a financial year";
  return {
    lut: latest,
    warning: fy
      ? `No LUT is saved for FY ${fy} (invoice date ${invoiceDate}); used ${label} instead. Add the FY ${fy} LUT in Settings if you filed one.`
      : `Couldn't work out the financial year of the invoice date; used ${label}.`,
  };
}
