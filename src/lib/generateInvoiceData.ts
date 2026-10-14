import { AppConfig, DEFAULT_SERVICE_DESCRIPTION } from "./config";
import { selectLut } from "./configSchema";
import { ComplianceMetadata, DeelParsedInvoice, FiraParsedData, GeneratedInvoice } from "./types";
import { InvoiceValidationError, validateDeelData, validateGeneratedInvoice, validateSupplier } from "./validateInvoice";

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

  // Uploaded Deel data is the source of truth; saved config only fills gaps.
  const finalClient = {
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

  // Formulate Line Items
  const fira = overrides?.firaData;
  const isFira = !!fira;
  let subtotal = deelData.subtotal;
  let grandTotal = deelData.total;
  let currency = deelData.currency || "USD";

  // If FIRA exists, calculate exchange rate and bank charges
  let firaDerivedData: GeneratedInvoice["firaData"] = undefined;
  if (isFira) {
    if (
      fira.fcyAmount <= 0 ||
      fira.inrAmount <= 0 ||
      (overrides?.firaSource !== "manual" && (!fira.firaRef || !fira.processedDate))
    ) {
      throw new InvoiceValidationError("FIRA data is incomplete. Please upload a valid FIRA PDF or fill out the required manual fields.");
    }

    currency = "INR";
    grandTotal = fira.inrAmount;
    subtotal = fira.inrAmount; // Since GST is 0, subtotal matches grandTotal

    const exchangeRate = fira.inrAmount / fira.fcyAmount;
    const bankChargesUsd = Math.max(0, deelData.total - fira.fcyAmount);

    firaDerivedData = {
      originalUsdBilled: deelData.total,
      fundsRealizedUsd: fira.fcyAmount,
      fundsRealizedInr: fira.inrAmount,
      bankChargesUsd,
      exchangeRate,
      firaRef: fira.firaRef,
      firaDate: fira.processedDate,
    };
  }
  
  const firaSourceInfo = overrides?.firaSource || "pdf";

  // Map Deel line items → GST line items
  const lineItems = deelData.lineItems.map((item) => {
    let description = item.description;

    // "Fixed rate: Monthly payment" → the configured service description
    if (/Fixed rate/i.test(description)) {
      description = `${supplier.defaultServiceDescription || DEFAULT_SERVICE_DESCRIPTION}${periodLabel ? ` — ${periodLabel}` : ""}`;
    }

    // Convert to INR if FIRA data exists
    let finalAmount = item.amount;
    let finalRate = item.amount;

    if (isFira) {
      // Proportion of total billing
      const proportion = item.amount / deelData.total;
      // Proportional distribution of the total realized INR
      finalAmount = Math.round(fira.inrAmount * proportion * 100) / 100;
      finalRate = finalAmount;
      
      // Append original USD value note
      description += `\n(Original Value: USD ${item.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`;
    }

    return {
      description,
      sacCode,
      qty: 1,
      rate: finalRate,
      amount: finalAmount,
      sgst: 0,
      cgst: 0,
      igst: 0,
      cess: 0,
    };
  });

  // Adjust mathematically for any rounding 1-cent discrepancies on the last item for FIRA invoices
  if (isFira && lineItems.length > 0) {
    const sumLineItems = lineItems.reduce((acc, curr) => acc + curr.amount, 0);
    const diff = Math.round((fira.inrAmount - sumLineItems) * 100) / 100;
    if (diff !== 0) {
      // Put the paisa residual on the largest line so a zero-value row never goes negative
      const target = lineItems.reduce((best, item) => (item.amount > best.amount ? item : best), lineItems[0]);
      target.amount = Math.round((target.amount + diff) * 100) / 100;
      target.rate = Math.round((target.rate + diff) * 100) / 100;
    }
  }

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
