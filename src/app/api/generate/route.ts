import { NextRequest, NextResponse } from "next/server";
import { parseDeelInvoice } from "@/lib/parseDeelInvoice";
import { parseFiraPdf } from "@/lib/parseFira";
import { generateInvoiceData } from "@/lib/generateInvoiceData";
import { generatePdf } from "@/lib/generatePdf";
import { getConfig } from "@/lib/config";
import { put } from "@vercel/blob";
import { InvoiceValidationError, validateDeelData, validateSupplier } from "@/lib/validateInvoice";
import { isShareMode } from "@/lib/shareMode";
import { guardGenerateRequest } from "@/lib/requestGuards";
import { assertPdfUpload, MAX_REQUEST_BYTES, TooBusyError } from "@/lib/limits";

type AirtableFieldValue =
  | string
  | number
  | null
  | undefined
  | { url: string }[];

type AirtableFields = Record<string, AirtableFieldValue>;
type SyncStatus = {
  status: "success" | "warning" | "skipped";
  message?: string;
};

export async function POST(req: NextRequest) {
  // Another site must not be able to submit uploads here from the user's browser
  const crossOrigin = guardGenerateRequest(req);
  if (crossOrigin) return crossOrigin;
  const declaredLength = Number(req.headers.get("content-length"));
  if (!Number.isFinite(declaredLength) || declaredLength <= 0) {
    return NextResponse.json({ error: "Upload size is missing." }, { status: 411 });
  }
  if (declaredLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: `Uploads are limited to ${MAX_REQUEST_BYTES / 1024 / 1024} MB in total.` }, { status: 413 });
  }
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File;
    const firaFile = formData.get("firaFile") as File | null;
    const placeOfSupply = formData.get("placeOfSupply") as string;
    const notes = formData.get("notes") as string;
    const overrideHsnSac = formData.get("overrideHsnSac") as string;
    const overrideInvoiceNumber = formData.get("overrideInvoiceNumber") as string;

    // Strict: "90garbage", "-90" or "1e3" are rejected instead of being read as something else
    const parseFormattedNumber = (val: FormDataEntryValue | null, label: string): number | null => {
      if (val === null || (typeof val === "string" && val.trim() === "")) return null;
      const text = typeof val === "string" ? val.trim() : "";
      if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(text)) {
        throw new InvoiceValidationError(`${label} must be a positive number.`);
      }
      return parseFloat(text.replace(/,/g, ""));
    };

    const manualFiraReceivedUsd = parseFormattedNumber(formData.get("manualFiraReceivedUsd"), "USD received");
    const manualFiraRate = parseFormattedNumber(formData.get("manualFiraRate"), "Exchange rate");
    const manualFiraBankCharges = parseFormattedNumber(formData.get("manualFiraBankCharges"), "Fee") ?? 0;
    const manualFiraRef = formData.get("manualFiraRef") as string;
    const manualFiraDate = formData.get("manualFiraDate") as string;

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    // 1. Read the uploaded PDF file as a buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    assertPdfUpload(buffer, "The Deel invoice");

    // 2. Parse the Deel invoice text
    const deelData = await parseDeelInvoice(buffer);
    // Fail closed before any FIRA matching or uploads: a 0 or unreconciled total stops here.
    validateDeelData(deelData);
    validateSupplier(getConfig().businessProfile);

    // 3. Optionally parse the FIRA PDF if provided, OR use manual FIRA overrides
    let firaData = undefined;
    let firaSource: "pdf" | "manual" = "pdf";
    let firaBufferForUpload: Buffer | null = null;
    
    if (firaFile && firaFile.size > 0) {
      const firaBuffer = await firaFile.arrayBuffer();
      firaBufferForUpload = Buffer.from(firaBuffer);
      assertPdfUpload(firaBufferForUpload, "The FIRA");
      firaData = await parseFiraPdf(firaBufferForUpload);
      const unread = [
        !(firaData.fcyAmount > 0) && "USD amount",
        !(firaData.inrAmount > 0) && "INR amount",
        !firaData.firaRef && "reference number",
        !firaData.processedDate && "processed date",
      ].filter(Boolean);
      if (unread.length > 0) {
        throw new InvoiceValidationError(
          `Couldn't read the FIRA's ${unread.join(", ")}. Check it's the bank's FIRA PDF; if the bank changed its layout, enter the FIRA details manually.`,
        );
      }

      // Validation: Prevent accidental uploads of mismatched FIRA and Deel PDFs
      if (deelData.issueDate && firaData.processedDate) {
        // Issue Date is usually YYYY-MM-DD from Deel. FIRA date is DD-MM-YYYY
        const deelDate = new Date(deelData.issueDate);
        
        let fd = firaData.processedDate;
        if (fd.includes("-")) {
            const parts = fd.split("-");
            if (parts.length === 3 && parts[0].length === 2 && parts[2].length === 4) {
               fd = `${parts[2]}-${parts[1]}-${parts[0]}`; // Convert DD-MM-YYYY to YYYY-MM-DD
            }
        }
        const fDate = new Date(fd);

        if (!isNaN(deelDate.getTime()) && !isNaN(fDate.getTime())) {
          // Calculate difference in days
          const diffTime = Math.abs(fDate.getTime() - deelDate.getTime());
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
          
          if (diffDays > 90) { // If they are more than 90 days apart, it is almost certainly a mismatched file
            return NextResponse.json({ 
              error: `Document Mismatch Detected. The Deel Invoice is dated ${deelData.issueDate}, but the FIRA is dated ${firaData.processedDate}. Please ensure you uploaded the matching pair.` 
            }, { status: 400 });
          }
        }
      }

      // Amount Validation
      // The FIRA FCY Amount should usually be slightly less than the Deel Total (due to wire fees).
      // If the difference is massive, or negative, these files don't belong together.
      if (deelData.total && firaData.fcyAmount > 0) {
        const diffAmount = deelData.total - firaData.fcyAmount;
        
        if (diffAmount < 0 || diffAmount > 100) {
           return NextResponse.json({ 
              error: `Amount Mismatch: Deel billed USD ${deelData.total}, but FIRA received USD ${firaData.fcyAmount}. This implies a wire fee of $${diffAmount.toFixed(2)}, which is abnormal. Please ensure you uploaded the matching invoice and FIRA pair.` 
            }, { status: 400 });
        }
      }
    } else if (manualFiraRate !== null || manualFiraReceivedUsd !== null) {
      // Manual FIRA logic based on Skydo receipts
      firaSource = "manual";
      if (!manualFiraRate || !manualFiraReceivedUsd) {
        throw new InvoiceValidationError("Manual FIRA entry needs both the USD received and the exchange rate.");
      }
      // Same pairing rule as an uploaded FIRA: received ≤ billed, and at most $100 lost in transit
      const transitLoss = deelData.total - manualFiraReceivedUsd;
      if (transitLoss < 0 || transitLoss > 100) {
        throw new InvoiceValidationError(
          `USD received (${manualFiraReceivedUsd}) doesn't match the Deel total (${deelData.total}); it should be at most $100 less.`,
        );
      }
      const usdReceived = manualFiraReceivedUsd;
      const firaDate = parseManualFiraDate(manualFiraDate, deelData.issueDate);
      
      // Skydo Math:
      // 1. Converted Amount = USD Received * FX Rate
      // 2. You'll Receive (Net INR) = Converted Amount - Skydo Fee + GST (INR)
      const convertedAmountInr = usdReceived * manualFiraRate;
      const skydoFeeInr = manualFiraBankCharges; 
      const netInr = convertedAmountInr - skydoFeeInr;
      
      // Back-calculate the effective FCY (since GST relies on proportional FCY/INR ratio)
      // If we received 327,754 at 91.6601 rate => The legal FCY is 3575.76 USD.
      const netFcy = netInr / manualFiraRate;
      if (!(netInr > 0)) {
        throw new InvoiceValidationError("The fee is larger than the converted amount.");
      }
      
      firaData = {
        fcyAmount: Math.round(netFcy * 100) / 100,
        inrAmount: Math.round(netInr * 100) / 100,
        firaRef: manualFiraRef || "",
        processedDate: firaDate,
      };
    }

    // 4. Get the local config and generate the final schema data
    const config = getConfig();
    const invoiceData = generateInvoiceData(deelData, config, {
      placeOfSupply,
      notes,
      overrideHsnSac,
      overrideInvoiceNumber,
      firaData,
      firaSource
    });

    // 4. Generate the PDF
    const pdfBuffer = await generatePdf(invoiceData);

    // 5. If Airtable is configured, log the record and optionally upload attachments
    // Tokens only come from env; business.json holds the non-secret base and table
    const airtableToken = normalizeSecret(process.env.AIRTABLE_API_KEY);
    const baseId = normalizeSecret(process.env.AIRTABLE_BASE_ID) || normalizeSecret(config.airtableIntegration?.baseId);
    const tableName = normalizeSecret(process.env.AIRTABLE_TABLE_NAME) || normalizeSecret(config.airtableIntegration?.tableName) || "GST Invoices";
    
    let airtableSyncStatus: SyncStatus = { status: "skipped" };

    // The public share link never writes to the owner's Airtable or Blob
    if (!isShareMode() && airtableToken && baseId && tableName) {
      try {
        const airtableUrl = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;

        let deelBlobUrl = "";
        let firaBlobUrl = "";
        let gstBlobUrl = "";

        const vercelToken = normalizeSecret(process.env.BLOB_READ_WRITE_TOKEN);

        // If the user has a Vercel Blob token configured, upload the PDFs first
        if (vercelToken) {
          try {
            // Upload Deel Invoice
            const deelUpload = await put(createBlobName("deel", deelData.invoiceNumber), buffer, {
              access: 'public',
              addRandomSuffix: true,
              token: vercelToken
            });
            deelBlobUrl = deelUpload.url;

            // Upload FIRA if it exists
            if (firaFile && firaBufferForUpload) {
              const firaUpload = await put(createBlobName("fira", invoiceData.invoiceNumber), firaBufferForUpload, {
                access: 'public',
                addRandomSuffix: true,
                token: vercelToken
              });
              firaBlobUrl = firaUpload.url;
            }

            // Upload the newly generated GST PDF
            const gstUpload = await put(createBlobName("gst", invoiceData.invoiceNumber), pdfBuffer, {
              access: 'public',
              addRandomSuffix: true,
              token: vercelToken
            });
            gstBlobUrl = gstUpload.url;

            console.log("Successfully uploaded PDFs to Vercel Blob.");

          } catch (blobErr) {
             console.error("Failed to upload to Vercel Blob:", blobErr);
             // We continue without attachments so the row is still created in Airtable
          }
        }

        const attachmentFields: AirtableFields = {};

        // Attach URLs only if they were successfully generated by Vercel
        if (deelBlobUrl) {
          attachmentFields["Deel PDF"] = [{ url: deelBlobUrl }];
        }
        if (firaBlobUrl) {
          attachmentFields["FIRA PDF"] = [{ url: firaBlobUrl }];
        }
        if (gstBlobUrl) {
          attachmentFields["GST Invoice PDF"] = [{ url: gstBlobUrl }];
        }

        const legacyFields = buildLegacyAirtableFields(deelData, invoiceData);
        const complianceFields = buildComplianceAirtableFields(deelData, invoiceData);
        const recordFields = { ...legacyFields, ...complianceFields, ...attachmentFields };

        let atRes = await fetch(airtableUrl, {
          method: "PATCH",
          headers: {
            "Authorization": `Bearer ${airtableToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ 
            performUpsert: { fieldsToMergeOn: ["Deel Invoice Number"] },
            records: [{ fields: recordFields }] 
          })
        });
        let atErr: unknown = null;

        if (!atRes.ok) {
          atErr = await readJsonSafely(atRes);
          if (hasUnknownFieldError(atErr)) {
            console.warn("Airtable is missing one or more compliance fields. Retrying with the legacy schema only.");
            atRes = await fetch(airtableUrl, {
              method: "PATCH",
              headers: {
                "Authorization": `Bearer ${airtableToken}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ 
                performUpsert: { fieldsToMergeOn: ["Deel Invoice Number"] },
                records: [{ fields: { ...legacyFields, ...attachmentFields } }] 
              })
            });
            atErr = null;
          }
        }

        if (!atRes.ok) {
          if (atErr === null) {
            atErr = await readJsonSafely(atRes);
          }
          console.error("Airtable Sync Error:", JSON.stringify(atErr));
          airtableSyncStatus = {
            status: "warning",
            message: buildAirtableFailureMessage(atErr),
          };
        } else {
          console.log("Successfully synced invoice to Airtable:", invoiceData.invoiceNumber);
          airtableSyncStatus = { status: "success" };
          if (deelBlobUrl || firaBlobUrl || gstBlobUrl) {
            console.log("Preserving uploaded Blob URLs so Airtable can retain attachment access.");
          }
        }
      } catch (err) {
        console.error("Failed to push to Airtable:", err);
        airtableSyncStatus = {
          status: "warning",
          message: "Invoice was generated, but Airtable sync failed. Check your Airtable token, base, and table configuration.",
        };
      }
    }

    // 6. Return the PDF buffer to the client as an attachment
    const response = new NextResponse(new Uint8Array(pdfBuffer));
    response.headers.set("Content-Type", "application/pdf");
    response.headers.set("Content-Disposition", `attachment; filename="${invoiceData.invoiceNumber}-GST.pdf"`);
    response.headers.set("X-Airtable-Sync-Status", airtableSyncStatus.status);
    if (airtableSyncStatus.message) {
      response.headers.set("X-Airtable-Sync-Message", encodeURIComponent(airtableSyncStatus.message));
    }
    // Non-blocking notes (e.g. no LUT for this FY) as a URI-encoded JSON array of strings
    if (invoiceData.warnings?.length) {
      response.headers.set("X-Invoice-Warnings", encodeURIComponent(JSON.stringify(invoiceData.warnings)));
    }
    
    return response;

  } catch (error: unknown) {
    if (error instanceof InvoiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof TooBusyError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    // Unexpected errors can quote config or document contents, so neither the response nor the log carries the message
    console.error("Error generating invoice:", describeError(error));
    return NextResponse.json({ error: "Failed to generate the invoice. Check the server log for details." }, { status: 500 });
  }
}

function buildLegacyAirtableFields(
  deelData: Awaited<ReturnType<typeof parseDeelInvoice>>,
  invoiceData: ReturnType<typeof generateInvoiceData>,
): AirtableFields {
  return {
    "Invoice Number": invoiceData.invoiceNumber,
    "Date": invoiceData.invoiceDate,
    "Client": invoiceData.client.clientName,
    "USD Billed": invoiceData.firaData ? invoiceData.firaData.originalUsdBilled : invoiceData.subtotal,
    "INR Realized": invoiceData.firaData ? invoiceData.firaData.fundsRealizedInr : null,
    "Bank Charges (USD)": invoiceData.firaData ? invoiceData.firaData.bankChargesUsd : null,
    "FIRA Reference": invoiceData.firaData ? invoiceData.firaData.firaRef : null,
    "Deel Invoice Number": deelData.invoiceNumber,
    "Service Period": invoiceData.servicePeriod || null,
  };
}

function buildComplianceAirtableFields(
  deelData: Awaited<ReturnType<typeof parseDeelInvoice>>,
  invoiceData: ReturnType<typeof generateInvoiceData>,
): AirtableFields {
  const metadata = invoiceData.complianceMetadata;
  return {
    "Compliance Key": metadata.complianceKey,
    "Compliance Metadata": JSON.stringify(metadata, null, 2),
    "Workflow Version": metadata.workflowVersion,
    "Generated At": metadata.generatedAt,
    "Deel Reference": deelData.deelRef || null,
    "Deel Issue Date": deelData.issueDate || null,
    "Deel Due Date": deelData.dueDate || null,
    "Deel Currency": deelData.currency || null,
    "Deel Subtotal": stringifyField(deelData.subtotal),
    "Deel Total": stringifyField(deelData.total),
    "Client Country": invoiceData.client.country || null,
    "Client VAT ID": invoiceData.client.vatId || null,
    "Client Registration Number": invoiceData.client.registrationNumber || null,
    "GST Invoice Number": invoiceData.invoiceNumber,
    "GST Invoice Date": invoiceData.invoiceDate,
    "GST Currency": invoiceData.currency,
    "GST Place Of Supply": invoiceData.placeOfSupply,
    "GST Note": invoiceData.gstNote,
    "LUT Financial Year": invoiceData.supplier.lut.financialYear || null,
    "LUT Rule": invoiceData.supplier.lut.rule || null,
    "SAC Code": invoiceData.lineItems[0]?.sacCode || null,
    "FIRA Processed Date": invoiceData.firaData?.firaDate || null,
    "FIRA USD Realized": stringifyField(invoiceData.firaData?.fundsRealizedUsd),
    "FIRA INR Realized": stringifyField(invoiceData.firaData?.fundsRealizedInr),
    "Exchange Rate": stringifyField(invoiceData.firaData?.exchangeRate),
  };
}

function hasUnknownFieldError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const details = "error" in error && error.error && typeof error.error === "object"
    ? error.error
    : error;

  const type = "type" in details ? String(details.type) : "";
  const message = "message" in details ? String(details.message) : "";
  return type === "UNKNOWN_FIELD_NAME" || /unknown field name/i.test(message);
}

async function readJsonSafely(response: Response): Promise<unknown> {
  const rawBody = await response.text();

  if (!rawBody) {
    return null;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return { rawBody };
  }
}

function buildAirtableFailureMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "Invoice was generated, but Airtable sync failed.";
  }

  const details = "error" in error && error.error && typeof error.error === "object"
    ? error.error
    : error;

  const message = "message" in details ? String(details.message) : "";
  const type = "type" in details ? String(details.type) : "";

  if (type === "AUTHENTICATION_REQUIRED") {
    return "Invoice was generated, but Airtable sync failed because Airtable rejected the token. If you pasted the value shown in the token list, replace it with the full PAT secret from Create/Regenerate token.";
  }

  if (message.includes("Cannot update more than one record")) {
    return "Invoice was generated, but Airtable sync failed: There are existing duplicate rows for this Deel Invoice Number in Airtable. Please delete the duplicates in Airtable so the update can succeed.";
  }

  if (hasUnknownFieldError(error)) {
    return "Invoice was generated, but Airtable is missing one or more compliance fields. Update the table schema and try again.";
  }

  return message
    ? `Invoice was generated, but Airtable sync failed: ${message}`
    : "Invoice was generated, but Airtable sync failed.";
}

function createBlobName(prefix: string, invoiceNumber: string): string {
  const safeInvoiceNumber = invoiceNumber.replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/-+/g, "-");
  return `${prefix}-${safeInvoiceNumber || "invoice"}.pdf`;
}

function stringifyField(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return String(value);
}

function normalizeSecret(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim() || undefined;
  }

  return trimmed;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const frames = (error.stack || "").split("\n").slice(1, 4).map((line) => line.trim()).join(" ← ");
  return `${error.name} ${frames}`;
}

/**
 * Manual FIRA date: optional (defaults to today), otherwise a real YYYY-MM-DD date from the GST era up to tomorrow,
 * within 90 days of the Deel invoice like an uploaded FIRA.
 */
function parseManualFiraDate(value: string | null, deelIssueDate: string): string {
  // An omitted date means today, checked like any other date
  const text = (value || "").trim() || new Date().toISOString().split("T")[0];
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!m || !date || date.toISOString().slice(0, 10) !== text) {
    throw new InvoiceValidationError("FIRA date must be a real date in YYYY-MM-DD format.");
  }
  const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
  if (text < "2017-07-01" || date.getTime() > tomorrow) {
    throw new InvoiceValidationError("FIRA date must be between July 2017 and today.");
  }
  const deel = new Date(deelIssueDate);
  if (!isNaN(deel.getTime()) && Math.abs(date.getTime() - deel.getTime()) > 90 * 24 * 60 * 60 * 1000) {
    throw new InvoiceValidationError("FIRA date is more than 90 days from the Deel invoice date.");
  }
  return text;
}
