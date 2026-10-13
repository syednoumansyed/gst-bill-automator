import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { configExists, getConfig, hasLegacySecrets, saveConfig } from "../../src/lib/config";
import { validateConfigInput } from "../../src/lib/configSchema";
import { generateInvoiceData } from "../../src/lib/generateInvoiceData";
import { deelInvoice, legacyBusinessJson } from "./fixtures";

let dir: string;
let file: string;
const saved = { path: process.env.BUSINESS_CONFIG_PATH, json: process.env.BUSINESS_CONFIG_JSON };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gst-config-"));
  file = path.join(dir, "business.json");
  process.env.BUSINESS_CONFIG_PATH = file;
  delete process.env.BUSINESS_CONFIG_JSON;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (saved.path === undefined) delete process.env.BUSINESS_CONFIG_PATH;
  else process.env.BUSINESS_CONFIG_PATH = saved.path;
  if (saved.json === undefined) delete process.env.BUSINESS_CONFIG_JSON;
  else process.env.BUSINESS_CONFIG_JSON = saved.json;
});

const writeJson = (value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const readJson = () => JSON.parse(fs.readFileSync(file, "utf8"));

describe("legacy business.json", () => {
  it("round-trips load -> save -> load to the same AppConfig, with the legacy lut as luts[0]", () => {
    writeJson(legacyBusinessJson);
    const first = getConfig();

    expect(first.luts).toEqual([legacyBusinessJson.lut]);
    expect(first.businessProfile.lut).toEqual(legacyBusinessJson.lut);
    expect(first.businessProfile.gstin).toBe(legacyBusinessJson.businessProfile.gstin);
    expect(first.bankAccounts).toEqual(legacyBusinessJson.bankAccounts);
    expect(first.businessProfile.accountNumber).toBe("111122223333");
    expect(first.airtableIntegration).toEqual({ baseId: "appAAAAAAAAAAAAAA", tableName: "GST Invoices" });

    saveConfig(first);
    const second = getConfig();
    expect(second).toEqual(first);

    // The file keeps every legacy key (older copies still read it) and gains `luts`
    const written = readJson();
    expect(Object.keys(written)).toEqual(expect.arrayContaining(Object.keys(legacyBusinessJson)));
    expect(written.lut).toEqual(legacyBusinessJson.lut);
    expect(written.luts).toEqual([legacyBusinessJson.lut]);
    expect(written.businessProfile).toEqual(legacyBusinessJson.businessProfile);
    expect(written.bankDetails).toEqual(legacyBusinessJson.bankDetails);
    expect(written.clientProfile).toEqual(legacyBusinessJson.clientProfile);

    // A second save is a fixed point
    saveConfig(second);
    expect(readJson()).toEqual(written);
  });

  it("passes the shared schema once loaded, so Settings can save it unchanged", () => {
    writeJson(legacyBusinessJson);
    const result = validateConfigInput(getConfig());
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it("still loads a file with only bankDetails and a nested businessProfile.lut", () => {
    const { bankAccounts: _accounts, lut, ...rest } = legacyBusinessJson;
    void _accounts;
    writeJson({ ...rest, businessProfile: { ...rest.businessProfile, lut } });
    const config = getConfig();
    expect(config.luts).toEqual([lut]);
    expect(config.bankAccounts).toEqual([{
      id: "default", label: "Primary Account", bankName: "Test Bank", accountNumber: "111122223333",
      ifsc: "TEST0001234", branch: "Test Branch", isPrimary: true,
    }]);
  });

  it("produces the same invoice fields as before for an invoice in the LUT's year", () => {
    writeJson(legacyBusinessJson);
    const invoice = generateInvoiceData(deelInvoice("2026-10-01"), getConfig());
    expect(invoice.warnings).toBeUndefined();
    expect(invoice.supplier.lut).toEqual(legacyBusinessJson.lut);
    expect(invoice.lutNumber).toBe("Supply under LUT — Rule 96A");
    expect(invoice.lineItems[0].description).toBe("Professional Services — Sep 1 – Sep 30, 2026");
    expect(invoice.complianceMetadata.gst.lutFinancialYear).toBe("2026-27");
    expect(invoice.complianceMetadata.gst).not.toHaveProperty("lutArn");
  });
});

describe("secrets", () => {
  it("ignores legacy tokens on load and strips them on save", () => {
    writeJson({
      ...legacyBusinessJson,
      airtableIntegration: { ...legacyBusinessJson.airtableIntegration, token: "patFAKE.fake", vercelBlobToken: "vercel_blob_rw_FAKE" },
    });
    expect(hasLegacySecrets()).toBe(true);
    const config = getConfig();
    expect(JSON.stringify(config)).not.toMatch(/patFAKE|vercel_blob_rw_FAKE/);

    saveConfig(config);
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/patFAKE|vercel_blob_rw_FAKE|token/i);
    expect(hasLegacySecrets()).toBe(false);
  });
});

describe("BUSINESS_CONFIG_JSON", () => {
  it("is read instead of the file and can't be saved", () => {
    process.env.BUSINESS_CONFIG_JSON = JSON.stringify(legacyBusinessJson);
    expect(configExists()).toBe(true);
    const config = getConfig();
    expect(config.businessProfile.legalName).toBe("Test Person");
    expect(config.luts).toEqual([legacyBusinessJson.lut]);
    expect(() => saveConfig(config)).toThrow(/BUSINESS_CONFIG_JSON/);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("fresh install", () => {
  it("has no config, no LUTs and no bank accounts", () => {
    expect(configExists()).toBe(false);
    const config = getConfig();
    expect(config.luts).toEqual([]);
    expect(config.bankAccounts).toEqual([]);
  });

  it("loads config/business.example.json and it validates", () => {
    const example = fs.readFileSync(path.join(__dirname, "../../config/business.example.json"), "utf8");
    fs.writeFileSync(file, example);
    const config = getConfig();
    expect(config.luts?.[0].arn).toBe("AD290426000123X");
    const result = validateConfigInput(config);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });
});
