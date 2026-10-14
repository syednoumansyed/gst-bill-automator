import { describe, expect, it } from "vitest";
import { parseDeelDate, parseFiraDate, sortIssues, validateDraft } from "@/lib/draftValidation";
import { issue, IssueError, ISSUE_STATUS } from "@/lib/errors";
import { assertPageCount, assertPdfUpload, assertTextItemCount, TooBusyError } from "@/lib/limits";
import { InvoiceValidationError, validateDeelData, validateSupplier } from "@/lib/validateInvoice";
import { deelData, fakeConfig } from "../../helpers/fixtures";
import { codes, draft } from "./fixtures";

const supplier = fakeConfig().businessProfile;
const check = (d = draft()) => validateDraft(d, supplier);
const only = (d: ReturnType<typeof draft>) => {
  const issues = check(d);
  return { issues, codes: codes(issues), fields: issues.map((i) => i.field) };
};

describe("validateDraft: accepts", () => {
  it("a draft with a bank FIRA", () => {
    expect(check()).toEqual([]);
  });

  it("a draft without a FIRA", () => {
    expect(check(draft({ fira: null }))).toEqual([]);
  });

  it("a manual FIRA dated YYYY-MM-DD without a reference", () => {
    expect(check(draft({ fira: { source: "manual", firaRef: "", processedDate: "2026-08-25" } }))).toEqual([]);
  });

  it("a zero-value line next to a real one, and totals off by one cent of rounding", () => {
    const d = draft({
      deel: {
        lineItems: [
          { description: "Fixed rate: Monthly payment", amount: 2000 },
          { description: "Other: adjustment", amount: 0 },
        ],
        total: 2000.01,
      },
    });
    expect(check(d)).toEqual([]);
  });
});

describe("validateDraft: Deel figures", () => {
  it("line items that don't add up to the subtotal", () => {
    const r = only(draft({ deel: { lineItems: [{ description: "Fixed rate: x", amount: 1500 }] } }));
    expect(r.codes).toEqual(["DEEL_ITEMS_DONT_SUM"]);
    expect(r.fields).toEqual(["deel.subtotal"]);
    expect(r.issues[0].message).toMatch(/add up to 1500\.00.*2000\.00/);
  });

  it("subtotal + VAT that doesn't match the total", () => {
    const r = only(draft({ deel: { total: 2100 }, fira: null }));
    expect(r.codes).toEqual(["DEEL_TOTALS_DISAGREE"]);
    expect(r.fields).toEqual(["deel.total"]);
  });

  it("a zero total, flagged on the field to correct", () => {
    const r = only(draft({ deel: { total: 0 }, fira: null }));
    expect(r.codes).toContain("DEEL_FIELD_UNREADABLE");
    expect(r.fields).toContain("deel.total");
  });

  it("VAT, which isn't supported", () => {
    const r = only(draft({ deel: { vat: 200, total: 2200 }, fira: null }));
    expect(r.codes).toEqual(["DEEL_VAT_UNSUPPORTED"]);
    expect(r.issues[0].action).toMatch(/VAT row/);
  });

  it("a currency other than USD", () => {
    const d = draft({ fira: null });
    (d.deel as { currency: string }).currency = "EUR";
    expect(only(d).codes).toEqual(["DEEL_CURRENCY_UNSUPPORTED"]);
  });

  it("missing identity fields, each on its own field", () => {
    const r = only(draft({ deel: { invoiceNumber: " ", issueDate: "", clientName: "" }, fira: null }));
    expect(r.codes).toEqual(["DEEL_FIELD_UNREADABLE", "DEEL_FIELD_UNREADABLE", "DEEL_FIELD_UNREADABLE"]);
    expect(r.fields).toEqual(["deel.invoiceNumber", "deel.issueDate", "deel.clientName"]);
  });

  it("an issue date that isn't a date", () => {
    expect(only(draft({ deel: { issueDate: "Febtember 40, 2026" }, fira: null })).fields).toEqual(["deel.issueDate"]);
  });

  it("a negative line, on that line's amount", () => {
    const r = only(
      draft({
        deel: {
          lineItems: [
            { description: "Fixed rate: x", amount: 2100 },
            { description: "Other: refund", amount: -100 },
          ],
        },
        fira: null,
      }),
    );
    expect(r.fields).toEqual(["deel.lineItems.1.amount"]);
  });
});

describe("validateDraft: FIRA pairing", () => {
  it("a FIRA that received more than Deel billed", () => {
    const r = only(draft({ fira: { fcyAmount: 2100, inrAmount: 189000 } }));
    expect(r.codes).toEqual(["FIRA_AMOUNT_MISMATCH"]);
    expect(r.fields).toEqual(["fira.fcyAmount"]);
  });

  it("a FIRA more than $100 short of the Deel total", () => {
    const r = only(draft({ fira: { fcyAmount: 1500, inrAmount: 135000 } }));
    expect(r.codes).toEqual(["FIRA_AMOUNT_MISMATCH"]);
    expect(r.issues[0].message).toMatch(/amount mismatch/i);
  });

  it("exactly $100 short is still a pair", () => {
    expect(check(draft({ fira: { fcyAmount: 1900, inrAmount: 171000 } }))).toEqual([]);
  });

  it("a FIRA dated more than 90 days from the Deel invoice, in either date format", () => {
    expect(only(draft({ fira: { processedDate: "25-01-2026" } })).codes).toEqual(["FIRA_DATE_MISMATCH"]);
    expect(only(draft({ fira: { source: "manual", processedDate: "2026-01-25" } })).issues[0].message).toMatch(/90 days/);
  });

  it("a FIRA date before GST or after tomorrow", () => {
    expect(only(draft({ fira: { processedDate: "01-01-2016" } })).codes).toContain("FIRA_DATE_MISMATCH");
    expect(only(draft({ fira: { source: "manual", processedDate: "2099-01-01" } })).codes).toEqual(["MANUAL_FIRA_INVALID"]);
  });

  it("an impossible FIRA date", () => {
    const r = only(draft({ fira: { source: "manual", processedDate: "2026-02-31" } }));
    expect(r.codes).toEqual(["MANUAL_FIRA_INVALID"]);
    expect(r.issues[0].message).toMatch(/real date/);
  });

  it("an exchange rate outside 60–130", () => {
    const r = only(draft({ fira: { inrAmount: 1995 } }));
    expect(r.codes).toEqual(["FIRA_RATE_IMPLAUSIBLE"]);
    expect(r.fields).toEqual(["fira.inrAmount"]);
  });

  it("unreadable bank-FIRA fields, each with an action naming the field", () => {
    const r = only(draft({ fira: { firaRef: "", processedDate: "", fcyAmount: 0, inrAmount: 0 } }));
    expect(new Set(r.codes)).toEqual(new Set(["FIRA_FIELD_UNREADABLE"]));
    expect(r.fields).toEqual(["fira.fcyAmount", "fira.inrAmount", "fira.firaRef", "fira.processedDate"]);
    expect(r.issues.find((i) => i.field === "fira.firaRef")?.action).toBe("Enter the reference shown on your FIRA in the Reference field.");
  });

  it("an edit can't skip a check: correcting the FIRA amount past the Deel total is refused", () => {
    const r = only(draft({ fira: { fcyAmount: 2500, inrAmount: 225000 }, edited: ["fira.fcyAmount", "fira.inrAmount"] }));
    expect(r.codes).toEqual(["FIRA_AMOUNT_MISMATCH"]);
  });
});

describe("validateDraft: settings", () => {
  it("names every missing supplier field in one CONFIG_INCOMPLETE issue", () => {
    const issues = validateDraft(draft(), fakeConfig({ gstin: "", pan: " ", accountNumber: "" }).businessProfile);
    expect(codes(issues)).toEqual(["CONFIG_INCOMPLETE"]);
    expect(issues[0].message).toMatch(/GSTIN, PAN, bank account number/);
    expect(issues[0].document).toBe("config");
  });
});

describe("issue plumbing", () => {
  it("every issue has a concrete action", () => {
    const issues = [
      ...check(draft({ deel: { invoiceNumber: "", total: 0, vat: 5 }, fira: { firaRef: "", processedDate: "x", fcyAmount: 0 } })),
      ...validateDraft(draft(), undefined),
    ];
    expect(issues.length).toBeGreaterThan(5);
    for (const i of issues) expect(i.action.length).toBeGreaterThan(15);
  });

  it("sorts errors first and drops repeats of the same code and field", () => {
    const warn = issue("DOC_LAYOUT_NEW", "deel", "w", "a", { severity: "warning" });
    const err = issue("DEEL_FIELD_UNREADABLE", "deel", "e", "a", { field: "deel.total" });
    expect(sortIssues([warn, err, { ...err, message: "again" }])).toEqual([err, warn]);
  });

  it("reads Deel and FIRA dates in the formats they're printed in", () => {
    expect(parseDeelDate("August 21, 2026")).toBe(Date.UTC(2026, 7, 21));
    expect(parseDeelDate("Aug 21 2026")).toBe(Date.UTC(2026, 7, 21));
    expect(parseDeelDate("2026-08-21")).toBe(Date.UTC(2026, 7, 21));
    expect(parseFiraDate("07-10-2026")).toBe(Date.UTC(2026, 9, 7));
    expect(parseFiraDate("2026-10-07")).toBe(Date.UTC(2026, 9, 7));
    expect(parseFiraDate("31-02-2026")).toBeNull();
  });

  it("InvoiceValidationError is an IssueError with a code, document and field", () => {
    const err = (() => {
      try {
        validateDeelData(deelData({ vat: 10 }));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvoiceValidationError);
    expect(err).toBeInstanceOf(IssueError);
    expect((err as IssueError).issues[0]).toMatchObject({ code: "DEEL_VAT_UNSUPPORTED", document: "deel", field: "deel.vat" });
    expect(() => validateSupplier(fakeConfig({ gstin: "" }).businessProfile)).toThrow(
      expect.objectContaining({ code: "CONFIG_INCOMPLETE" }),
    );
  });

  it("upload limits throw PDF_* and SERVER_BUSY issues with their statuses", () => {
    const codeOf = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        return (e as IssueError).issues[0];
      }
    };
    expect(codeOf(() => assertPdfUpload(Buffer.from("nope"), "The FIRA"))).toMatchObject({ code: "PDF_NOT_PDF", document: "fira" });
    expect(codeOf(() => assertPdfUpload(Buffer.alloc(6 * 1024 * 1024), "The Deel invoice"))).toMatchObject({ code: "PDF_TOO_LARGE", document: "deel" });
    expect(codeOf(() => assertPageCount(11, "The Deel invoice"))?.code).toBe("PDF_TOO_MANY_PAGES");
    expect(codeOf(() => assertTextItemCount(5001, "The FIRA"))?.code).toBe("PDF_TOO_MUCH_TEXT");
    const busy = new TooBusyError();
    expect(busy).toBeInstanceOf(IssueError);
    expect(busy.code).toBe("SERVER_BUSY");
    expect(busy.status).toBe(503);
    expect(ISSUE_STATUS.PDF_TOO_LARGE).toBe(413);
  });
});
