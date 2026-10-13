import fs from "fs";
import path from "path";
import { latestLut as pickLatestLut } from "./configSchema";

export interface LutInfo {
  formNumber: string;
  rule: string;
  filedAt: string;
  filedDate: string;
  financialYear: string;
  applicableFor: string;
  /** Acknowledgement (ARN) from the GST portal, printed on the invoice when present */
  arn?: string;
}

export interface BusinessProfile {
  legalName: string;
  tradeName: string;
  gstin: string;
  pan: string;
  address: string;
  city: string;
  district?: string;
  state: string;
  pincode: string;
  country: string;
  designation?: string;
  phone?: string;
  email?: string;
  /** Most recent LUT on file; invoices use the one for their own financial year (see selectLut) */
  lut: LutInfo;
  bankName: string;
  accountNumber: string;
  ifsc: string;
  branch: string;
  defaultSacCode: string;
  defaultPlaceOfSupply: string;
  defaultGstNote: string;
  /** Replaces Deel's "Fixed rate" line description on the invoice */
  defaultServiceDescription?: string;
}

export interface ClientProfile {
  clientName: string;
  clientAddress: string;
  country: string;
  registrationNumber?: string;
  vatId?: string;
  group?: string;
}

export interface BankAccount {
  id: string;
  label: string;
  bankName: string;
  accountNumber: string;
  ifsc: string;
  branch: string;
  isPrimary: boolean;
}

export interface AppConfig {
  businessProfile: BusinessProfile;
  clientProfile: ClientProfile;
  bankAccounts: BankAccount[];
  /** One LUT per financial year. getConfig always fills it; a legacy single `lut` becomes luts[0]. */
  luts?: LutInfo[];
  /** Non-secret Airtable settings. The token only comes from AIRTABLE_API_KEY. */
  airtableIntegration?: {
    baseId: string;
    tableName: string;
  };
}

/** What saveConfig needs: the editable fields. Derived ones (businessProfile.lut, bank fields) are ignored. */
export type SaveableConfig = {
  businessProfile: Omit<BusinessProfile, "lut" | "bankName" | "accountNumber" | "ifsc" | "branch"> & { lut?: LutInfo };
  luts?: LutInfo[];
  bankAccounts: BankAccount[];
  clientProfile: ClientProfile;
  airtableIntegration?: { baseId?: string; tableName?: string };
};

const DEFAULT_LUT: LutInfo = {
  formNumber: "FORM GST RFD-11",
  rule: "96A",
  filedAt: "",
  filedDate: "",
  financialYear: "",
  applicableFor: "Export of services without payment of integrated tax",
};
const DEFAULT_GST_NOTE = "Export of Services — Supply made under Letter of Undertaking without payment of Integrated Tax as per Rule 96A of the CGST Rules, 2017.";
// The original owner's wording; existing configs without a description keep producing the same invoices
export const DEFAULT_SERVICE_DESCRIPTION = "Professional Services";

/** config/business.json, or BUSINESS_CONFIG_PATH when set (tests, custom Docker mounts). */
export const configFilePath = () =>
  process.env.BUSINESS_CONFIG_PATH || path.join(process.cwd(), "config", "business.json");

/** A config problem whose message is safe to show the user (it never quotes the config's contents). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Hosted deployments supply business.json's contents as an env var and can't save. */
export const isConfigReadOnly = () => Boolean(process.env.BUSINESS_CONFIG_JSON);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readRawConfig(): any | null {
  const file = configFilePath();
  const source = process.env.BUSINESS_CONFIG_JSON
    || (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    // JSON.parse quotes the offending text, which could be a PAN or account number
    throw new ConfigError(
      process.env.BUSINESS_CONFIG_JSON ? "BUSINESS_CONFIG_JSON is not valid JSON." : "config/business.json is not valid JSON.",
    );
  }
}

/** True when there's a config file (or BUSINESS_CONFIG_JSON) at all; false on a fresh install. */
export function configExists(): boolean {
  return isConfigReadOnly() || fs.existsSync(configFilePath());
}

/** A token left in business.json by an older version. It's ignored; the user should move it to env. */
export function hasLegacySecrets(): boolean {
  try {
    const airtable = readRawConfig()?.airtableIntegration || {};
    return Boolean(airtable.token || airtable.vercelBlobToken);
  } catch {
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normaliseLut(lut: any): LutInfo {
  return {
    formNumber: lut.formNumber || DEFAULT_LUT.formNumber,
    rule: lut.rule || DEFAULT_LUT.rule,
    filedAt: lut.filedAt || "",
    filedDate: lut.filedDate || "",
    financialYear: lut.financialYear || "",
    applicableFor: lut.applicableFor || DEFAULT_LUT.applicableFor,
    ...(lut.arn ? { arn: String(lut.arn) } : {}),
  };
}

/** The LUT with the latest financial year, or the default blank LUT when there are none. */
export const latestLut = (luts: LutInfo[]): LutInfo => pickLatestLut(luts) || { ...DEFAULT_LUT };

/** Read and normalise the config file. Secrets in it are ignored. */
export function getConfig(): AppConfig {
  const raw = readRawConfig();
  if (!raw) return defaultConfig();

  const bp = raw.businessProfile || {};
  const defaults = raw.invoiceDefaults || {};
  const cp = raw.clientProfile || {};
  const airtable = raw.airtableIntegration || {};

  // `luts` (current) wins; otherwise the legacy single `lut` (top level, or older nested) becomes luts[0]
  const legacyLut = raw.lut || bp.lut;
  const luts: LutInfo[] = Array.isArray(raw.luts) && raw.luts.length > 0
    ? raw.luts.map(normaliseLut)
    : legacyLut ? [normaliseLut(legacyLut)] : [];

  let bankAccounts: BankAccount[] = raw.bankAccounts || [];
  if (bankAccounts.length === 0) {
    const bank = raw.bankDetails || {};
    bankAccounts = [{
      id: "default",
      label: "Primary Account",
      bankName: bank.bankName || "",
      accountNumber: bank.accountNumber || "",
      ifsc: bank.ifscCode || bank.ifsc || "",
      branch: bank.branch || "",
      isPrimary: true
    }];
  }
  const primaryBank = bankAccounts.find(b => b.isPrimary) || bankAccounts[0] || {} as Partial<BankAccount>;

  return {
    businessProfile: {
      legalName: bp.legalName || bp.name || "",
      tradeName: bp.tradeName || bp.businessName || "",
      gstin: bp.gstin || "",
      pan: bp.pan || "",
      address: bp.address || bp.addressLines || "",
      city: bp.city || "",
      district: bp.district || "",
      state: bp.state || "",
      pincode: bp.pincode || "",
      country: bp.country || "India",
      designation: bp.designation || "Proprietor",
      phone: bp.phone || "",
      email: bp.email || "",
      lut: latestLut(luts),
      bankName: primaryBank.bankName || "",
      accountNumber: primaryBank.accountNumber || "",
      ifsc: primaryBank.ifsc || "",
      branch: primaryBank.branch || "",
      defaultSacCode: defaults.sacCode || "998392",
      defaultPlaceOfSupply: defaults.placeOfSupply || "Outside India",
      defaultGstNote: defaults.gstNote || DEFAULT_GST_NOTE,
      defaultServiceDescription: defaults.serviceDescription || DEFAULT_SERVICE_DESCRIPTION,
    },
    luts,
    bankAccounts,
    clientProfile: {
      clientName: cp.clientName || "",
      clientAddress: cp.clientAddress || "",
      country: cp.country || "",
      registrationNumber: cp.registrationNumber || "",
      vatId: cp.vatId || cp.taxId || "",
      group: cp.group || "",
    },
    airtableIntegration: {
      baseId: airtable.baseId || "",
      tableName: airtable.tableName || "GST Invoices",
    }
  };
}

/** Write business.json in the shape older versions read, plus `luts`. Never writes secrets. */
export function saveConfig(config: SaveableConfig) {
  if (isConfigReadOnly()) {
    throw new ConfigError("Settings come from the BUSINESS_CONFIG_JSON environment variable here and can't be saved.");
  }
  const file = configFilePath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const bp = config.businessProfile;
  const luts = (config.luts && config.luts.length > 0 ? config.luts : bp.lut ? [bp.lut] : []).map(normaliseLut);
  const primaryBank = config.bankAccounts.find(b => b.isPrimary) || config.bankAccounts[0];

  const nested = {
    businessProfile: {
      legalName: bp.legalName,
      tradeName: bp.tradeName,
      gstin: bp.gstin,
      pan: bp.pan,
      address: bp.address,
      city: bp.city,
      district: bp.district,
      state: bp.state,
      pincode: bp.pincode,
      country: bp.country,
      designation: bp.designation,
      phone: bp.phone,
      email: bp.email,
    },
    // Single `lut` kept for older copies of the app; `luts` is the source of truth
    lut: latestLut(luts),
    luts,
    bankDetails: {
      bankName: primaryBank?.bankName || "",
      accountNumber: primaryBank?.accountNumber || "",
      ifscCode: primaryBank?.ifsc || "",
      branch: primaryBank?.branch || "",
    },
    bankAccounts: config.bankAccounts,
    invoiceDefaults: {
      sacCode: bp.defaultSacCode,
      placeOfSupply: bp.defaultPlaceOfSupply,
      gstNote: bp.defaultGstNote,
      serviceDescription: bp.defaultServiceDescription,
    },
    clientProfile: config.clientProfile,
    // Only the non-secret fields: any legacy token/vercelBlobToken is dropped here
    airtableIntegration: {
      baseId: config.airtableIntegration?.baseId || "",
      tableName: config.airtableIntegration?.tableName || "GST Invoices",
    },
  };
  // Write then rename so a crash never leaves half a file; owner-only because it holds bank details
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(nested, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

function defaultConfig(): AppConfig {
  return {
    businessProfile: {
      legalName: "", tradeName: "", gstin: "", pan: "",
      address: "", city: "", state: "", pincode: "", country: "India",
      designation: "Proprietor", phone: "", email: "",
      lut: { ...DEFAULT_LUT },
      bankName: "", accountNumber: "", ifsc: "", branch: "",
      defaultSacCode: "998392", defaultPlaceOfSupply: "Outside India",
      defaultGstNote: DEFAULT_GST_NOTE,
      defaultServiceDescription: DEFAULT_SERVICE_DESCRIPTION,
    },
    luts: [],
    bankAccounts: [],
    clientProfile: {
      clientName: "", clientAddress: "", country: "", registrationNumber: "", vatId: "", group: "",
    },
    airtableIntegration: { baseId: "", tableName: "GST Invoices" }
  };
}
