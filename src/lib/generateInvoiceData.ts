import { AppConfig, DEFAULT_SERVICE_DESCRIPTION } from "./config";
import { selectLut } from "./configSchema";
import type { InvoiceDraft } from "./draft";
import { invoiceInputFromDraft, type DeelExtras } from "./draftAdapter";
import { fromCents, isWholeCents, toCents } from "./draftValidation";
import { issue } from "./errors";
import { ComplianceMetadata, DeelParsedInvoice, FiraParsedData, GeneratedInvoice, ReviewRecord } from "./types";
import { InvoiceValidationError, validateDeelData, validateGeneratedInvoice, validateSupplier } from "./validateInvoice";

/**
 * Builds the invoice from a review draft. Callers run validateDraft first; generateInvoiceData still re-checks the
 * figures it uses, so a draft that skipped validation can't produce a wrong invoice either.
 */
export function generateInvoiceFromDraft(
  draft: InvoiceDraft,
  config: AppConfig,
  opts: { review?: ReviewRecord; extras?: DeelExtras } = {},
): GeneratedInvoice {
  const { deelData, overrides } = invoiceInputFromDraft(draft, opts.extras);
  return generateInvoiceData(deelData, config, { ...overrides, review: opts.review, clientFromDraft: true });
}

export function generateInvoiceData(
  deelData: DeelParsedInvoice,
  config: AppConfig,
  overrides?: {
    placeOfSupply?: string;
    notes?: string;
    overrideHsnSac?: string;
    overrideInvoiceNumber?: string;
    firaData?: FiraParsedData;
    firaSource?: "pdf" | "manual";
    /** Recorded in complianceMetadata.review */
    review?: ReviewRecord;
    /** The client fields come from a reviewed draft: never fill them from the saved client profile */
    clientFromDraft?: boolean;
  }
): GeneratedInvoice {
  const client = config.clientProfile;
  validateDeelData(deelData);
  validateSupplier(config.businessProfile);

  // LUT for the invoice's financial year; falls back to the latest with a warning instead of failing
  const invoiceDate = deelData.issueDate || new Date().toISOString().split("T")[0];
  const warnings: string[] = [];
  const lutChoice = selectLut(config.luts ?? [config.businessProfile.lut], invoiceDate);
  if (lutChoice.warning) warnings.push(lutChoice.warning);
  const supplier = { ...config.businessProfile, lut: lutChoice.lut || config.businessProfile.lut };

  // From a review draft the reviewed client is authoritative: a field left blank stays blank. Only the old
  // direct signature lets saved config fill gaps (the legacy route fills them once, in draftFromParsed).
  const finalClient = overrides?.clientFromDraft
    ? {
        clientName: deelData.clientName,
        clientAddress: deelData.clientAddress,
        country: deelData.clientCountry || "",
        vatId: deelData.clientVatId || "",
        registrationNumber: deelData.clientRegistrationNumber || "",
      }
    : {
        ...client,
        clientName: deelData.clientName || client.clientName,
        clientAddress: deelData.clientAddress || client.clientAddress,
        country: deelData.clientCountry || client.country || "",
        vatId: deelData.clientVatId || client.vatId || "",
        registrationNumber: deelData.clientRegistrationNumber || client.registrationNumber || "",
      };

  const sacCode = overrides?.overrideHsnSac || supplier.defaultSacCode || "998392";
  const placeOfSupply = overrides?.placeOfSupply || supplier.defaultPlaceOfSupply || "Outside India";

  // Build period label: "Feb 1 – Feb 28, 2026"
  const periodLabel = formatPeriodShort(deelData.periodStart, deelData.periodEnd);
  const servicePeriod = deelData.periodText || "";

  // Amounts are worked out in whole cents/paise and only then turned back into dollars/rupees, so every printed
  // figure is exactly a validated one and the lines add up to the total with no floating-point drift.
  const fira = overrides?.firaData;
  const isFira = !!fira;
  const totalCents = wholeCents(deelData.total, "deel.total");
  let subtotal = fromCents(wholeCents(deelData.subtotal, "deel.subtotal"));
  let grandTotal = fromCents(totalCents);
  let currency = deelData.currency || "USD";
  const itemCents = deelData.lineItems.map((item, i) => wholeCents(item.amount, `deel.lineItems.${i}.amount`));

  // If FIRA exists, calculate exchange rate and bank charges
  let firaDerivedData: GeneratedInvoice["firaData"] = undefined;
  let lineCents = itemCents;
  if (isFira) {
    if (
      !(fira.fcyAmount > 0) ||
      !(fira.inrAmount > 0) ||
      (overrides?.firaSource !== "manual" && (!fira.firaRef || !fira.processedDate))
    ) {
      const manual = overrides?.firaSource === "manual";
      throw new InvoiceValidationError(
        issue(
          manual ? "MANUAL_FIRA_INVALID" : "FIRA_FIELD_UNREADABLE",
          "fira",
          "FIRA data is incomplete. Please upload a valid FIRA PDF or fill out the required manual fields.",
          manual
            ? "Enter the USD received and the exchange rate."
            : "Enter the reference, processed date, USD and INR amounts shown on your FIRA.",
          { field: "fira" },
        ),
      );
    }

    const fcyCents = wholeCents(fira.fcyAmount, "fira.fcyAmount");
    const inrPaise = wholeCents(fira.inrAmount, "fira.inrAmount");

    currency = "INR";
    grandTotal = fromCents(inrPaise);
    subtotal = grandTotal; // Since GST is 0, subtotal matches grandTotal

    firaDerivedData = {
      originalUsdBilled: fromCents(totalCents),
      fundsRealizedUsd: fromCents(fcyCents),
      fundsRealizedInr: fromCents(inrPaise),
      bankChargesUsd: fromCents(Math.max(0, totalCents - fcyCents)),
      exchangeRate: inrPaise / fcyCents,
      firaRef: fira.firaRef,
      firaDate: fira.processedDate,
    };

    // Each line's share of the realised INR, in paise; the residual paisa goes on the largest line so a zero-value
    // row never goes negative and the lines add up exactly to the FIRA's INR amount.
    lineCents = itemCents.map((c) => Math.round((inrPaise * c) / totalCents));
    const residual = inrPaise - lineCents.reduce((a, b) => a + b, 0);
    if (residual !== 0 && lineCents.length > 0) {
      const largest = itemCents.reduce((best, c, i) => (c > itemCents[best] ? i : best), 0);
      lineCents[largest] += residual;
    }
  }

  const firaSourceInfo = overrides?.firaSource || "pdf";

  // Map Deel line items → GST line items
  const lineItems = deelData.lineItems.map((item, i) => {
    let description = item.description;

    // "Fixed rate: Monthly payment" → the configured service description
    if (/Fixed rate/i.test(description)) {
      description = `${supplier.defaultServiceDescription || DEFAULT_SERVICE_DESCRIPTION}${periodLabel ? ` — ${periodLabel}` : ""}`;
    }
    if (isFira) {
      // Append original USD value note
      description += `\n(Original Value: USD ${fromCents(itemCents[i]).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`;
    }

    const amount = fromCents(lineCents[i]);
    return {
      description,
      sacCode,
      qty: 1,
      rate: amount,
      amount,
      sgst: 0,
      cgst: 0,
      igst: 0,
      cess: 0,
    };
  });

  // LUT reference — GSTIN and FY are rendered separately in the PDF template
  const lutNumber = `Supply under LUT — Rule ${supplier.lut.rule}`;

  // Export statement (mandatory — most critical legal line on the invoice)
  const exportStatement =
    "Export of Services — Supply made under Letter of Undertaking without payment of Integrated Tax as per Rule 96A of the CGST Rules, 2017.";

  const gstNote = overrides?.notes || supplier.defaultGstNote || exportStatement;

  let finalInvoiceNumber = overrides?.overrideInvoiceNumber || "";

  if (!finalInvoiceNumber) {
    const issueDate = deelData.issueDate ? new Date(deelData.issueDate) : new Date();
    if (!isNaN(issueDate.getTime())) {
      const month = issueDate.getMonth() + 1; // 1-12
      const year = issueDate.getFullYear();
      
      const monthStr = month.toString().padStart(2, "0");
      finalInvoiceNumber = `INV-${year}-${monthStr}`;
    } else {
      finalInvoiceNumber = deelData.invoiceNumber || `INV-${Date.now()}`;
    }
  }

  const generatedAt = new Date().toISOString();
  const complianceKey = buildComplianceKey(
    finalInvoiceNumber,
    deelData.invoiceNumber,
    firaDerivedData?.firaRef,
  );

  const complianceMetadata: ComplianceMetadata = {
    complianceKey,
    workflowVersion: "2026-03-compliance-v1",
    generatedAt,
    sourceDocuments: {
      deelInvoiceNumber: deelData.invoiceNumber,
      deelReference: deelData.deelRef || "",
      firaReference: firaDerivedData?.firaRef,
    },
    deel: {
      invoiceNumber: deelData.invoiceNumber,
      issueDate: deelData.issueDate,
      dueDate: deelData.dueDate,
      periodStart: deelData.periodStart,
      periodEnd: deelData.periodEnd,
      servicePeriod: servicePeriod || deelData.periodText,
      currency: deelData.currency,
      subtotal: deelData.subtotal,
      total: deelData.total,
      clientName: deelData.clientName,
      clientAddress: deelData.clientAddress,
      clientCountry: deelData.clientCountry,
      clientVatId: deelData.clientVatId,
      clientRegistrationNumber: deelData.clientRegistrationNumber,
      supplierName: deelData.supplierName,
      supplierAddress: deelData.supplierAddress,
      role: deelData.role,
      lineItems: deelData.lineItems,
    },
    gst: {
      invoiceNumber: finalInvoiceNumber,
      invoiceDate,
      dueDate: deelData.dueDate,
      currency,
      subtotal,
      grandTotal,
      placeOfSupply,
      sacCode,
      gstNote,
      servicePeriod,
      lutFinancialYear: supplier.lut.financialYear,
      lutRule: supplier.lut.rule,
      ...(supplier.lut.arn ? { lutArn: supplier.lut.arn } : {}),
    },
    fira: firaDerivedData
      ? {
          source: firaSourceInfo,
          reference: firaDerivedData.firaRef || "",
          processedDate: firaDerivedData.firaDate || "",
          realizedUsd: firaDerivedData.fundsRealizedUsd,
          realizedInr: firaDerivedData.fundsRealizedInr,
          bankChargesUsd: firaDerivedData.bankChargesUsd,
          exchangeRate: firaDerivedData.exchangeRate,
        }
      : undefined,
    ...(overrides?.review ? { review: overrides.review } : {}),
  };

  const invoice: GeneratedInvoice = {
    invoiceNumber: finalInvoiceNumber,
    invoiceDate,
    dueDate: deelData.dueDate,
    placeOfSupply,
    exportType: "Export of Services under LUT",
    lutNumber,
    supplier,
    client: finalClient,
    currency,
    lineItems,
    subtotal,
    gstTotal: 0,
    grandTotal,
    gstNote,
    terms: "Payment to be made by due date.",
    // Extra fields for the PDF template
    servicePeriod,
    deelRef: deelData.deelRef || "",
    complianceMetadata,
    firaData: firaDerivedData,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  validateGeneratedInvoice(invoice);
  return invoice;
}

/** An amount in whole cents/paise; a fraction of a cent is refused rather than rounded into something unreviewed. */
function wholeCents(n: number, field: string): number {
  if (!Number.isFinite(n) || !isWholeCents(n)) {
    throw new InvoiceValidationError(
      issue("DRAFT_INVALID", field.startsWith("fira") ? "fira" : "deel", `${field}: Use at most two decimal places.`, "Enter the amount exactly as printed, with at most two decimals.", { field }),
    );
  }
  return toCents(n);
}

function buildComplianceKey(
  gstInvoiceNumber: string,
  deelInvoiceNumber: string,
  firaReference?: string,
): string {
  return [gstInvoiceNumber, deelInvoiceNumber, firaReference].filter(Boolean).join("__");
}

/** "October 1, 2025" + "October 31, 2025" → "Oct 1 – Oct 31, 2025" */
function formatPeriodShort(start?: string, end?: string): string {
  if (!start || !end) return "";
  const months: Record<string, string> = {
    January: "Jan", February: "Feb", March: "Mar", April: "Apr", May: "May",
    June: "Jun", July: "Jul", August: "Aug", September: "Sep",
    October: "Oct", November: "Nov", December: "Dec",
  };
  const sMatch = start.match(/^([A-Za-z]+)\s+(\d+),?\s+(\d{4})$/);
  const eMatch = end.match(/^([A-Za-z]+)\s+(\d+),?\s+(\d{4})$/);
  if (!sMatch || !eMatch) return `${start} to ${end}`;
  const sMonth = months[sMatch[1]] || sMatch[1];
  const eMonth = months[eMatch[1]] || eMatch[1];
  return `${sMonth} ${sMatch[2]} – ${eMonth} ${eMatch[2]}, ${eMatch[3]}`;
}
