import fs from 'fs';
import path from 'path';
import type { Browser } from 'puppeteer-core';
import { GeneratedInvoice } from './types';
import { withRenderSlot } from './limits';

// Noto Sans (OFL) is embedded so the PDF looks the same on every host and always has the ₹ glyph
const FONT_DIR = path.join(process.cwd(), 'src', 'lib', 'fonts');
let fontFaceCss: string | null = null;
function embeddedFontCss(): string {
  if (fontFaceCss !== null) return fontFaceCss;
  const face = (file: string, weight: number, range: string) => {
    const data = fs.readFileSync(path.join(FONT_DIR, file)).toString('base64');
    return `@font-face { font-family: "Invoice Sans"; font-weight: ${weight}; font-style: normal; src: url(data:font/woff2;base64,${data}) format("woff2"); unicode-range: ${range}; }`;
  };
  const latin = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
  const latinExt = 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1E00-1E9F, U+1EF2-1EFF, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF';
  fontFaceCss = [
    face('noto-sans-latin-400-normal.woff2', 400, latin),
    face('noto-sans-latin-ext-400-normal.woff2', 400, latinExt),
    face('noto-sans-latin-700-normal.woff2', 700, latin),
    face('noto-sans-latin-ext-700-normal.woff2', 700, latinExt),
  ].join('\n');
  return fontFaceCss;
}

async function launchBrowser(): Promise<Browser> {
  if (process.env.VERCEL) {
    // Serverless: Chromium built for Lambda-style runtimes
    const [{ default: chromium }, { default: puppeteerCore }] = await Promise.all([
      import('@sparticuz/chromium'),
      import('puppeteer-core'),
    ]);
    return puppeteerCore.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }
  // Docker (system Chromium via PUPPETEER_EXECUTABLE_PATH) and local dev (Puppeteer's own Chrome)
  const { default: puppeteer } = await import('puppeteer');
  return (await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ]
  })) as unknown as Browser;
}

export async function generatePdf(invoiceData: GeneratedInvoice): Promise<Buffer> {
  const {
    supplier, client, lineItems, subtotal, grandTotal, invoiceNumber,
    invoiceDate, dueDate, placeOfSupply, currency, exportType,
    gstNote, terms, servicePeriod, deelRef, firaData
  } = invoiceData;

  const supplierAddr = `${supplier.address}, ${supplier.city}, ${supplier.state} ${supplier.pincode}, ${supplier.country}`;
  const clientAddr = `${client.clientAddress}, ${client.country}`;
  const safeSupplierAddr = escapeHtml(supplierAddr);
  const safeClientAddr = escapeHtml(clientAddr);

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Tax Invoice – ${escapeHtml(invoiceNumber)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    ${embeddedFontCss()}
    body { font-family: "Invoice Sans", "Helvetica Neue", Helvetica, Arial, sans-serif; color: #1a1a1a; font-size: 11px; line-height: 1.45; }
    .page { padding: 32px 36px; max-width: 800px; margin: 0 auto; }

    /* ── Header ── */
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; padding-bottom: 14px; border-bottom: 2.5px solid #1a1a1a; }
    .header-left h1 { font-size: 22px; font-weight: 900; letter-spacing: 2.5px; text-transform: uppercase; }
    .header-right { text-align: right; }
    .header-right .trade-name { font-size: 15px; font-weight: 800; margin-bottom: 2px; }
    .header-right .legal-name { font-size: 10px; color: #555; }
    .header-right .addr { font-size: 9.5px; color: #555; margin-top: 3px; max-width: 260px; line-height: 1.3; }
    .header-right .ids { font-size: 9.5px; margin-top: 5px; }
    .header-right .ids strong { color: #333; }

    /* ── Meta Grid ── */
    .meta-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 20px; }
    .meta-box { padding: 12px 14px; border: 1px solid #ddd; border-radius: 5px; background: #f9f9f8; }
    .meta-box h3 { font-size: 9px; text-transform: uppercase; letter-spacing: 1.5px; color: #888; margin-bottom: 8px; padding-bottom: 5px; border-bottom: 1px solid #e5e5e5; font-weight: 700; }
    .meta-box .name { font-weight: 700; font-size: 12px; margin-bottom: 3px; }
    .meta-box .addr { font-size: 10px; color: #555; }
    .meta-box .ids-line { font-size: 9px; color: #555; margin-top: 4px; }
    .meta-row { display: flex; justify-content: space-between; font-size: 10px; padding: 3px 0; }
    .meta-row .label { color: #888; font-weight: 500; }
    .meta-row .value { font-weight: 600; text-align: right; }

    /* ── Table ── */
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    thead th { background: #1a1a1a; color: #fff; font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.8px; padding: 7px 10px; text-align: left; font-weight: 700; }
    thead th.r { text-align: right; }
    thead th.c { text-align: center; }
    tbody td { padding: 7px 10px; border-bottom: 1px solid #eee; font-size: 10px; }
    tbody td.r { text-align: right; font-variant-numeric: tabular-nums; }
    tbody td.c { text-align: center; }
    tbody tr:last-child td { border-bottom: 2px solid #ddd; }

    /* ── Totals ── */
    .totals { display: flex; justify-content: flex-end; margin-bottom: 16px; }
    .totals-box { width: 255px; }
    .totals-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 10px; border-bottom: 1px solid #eee; }
    .totals-row .label { color: #666; }
    .totals-row.zero { color: #bbb; }
    .totals-row.grand { font-size: 13px; font-weight: 800; border-bottom: 3px double #1a1a1a; border-top: 2px solid #1a1a1a; padding: 7px 0; color: #000; }

    /* ── Export Statement ── */
    .export-block { background: #f5f9f0; border: 1px solid #c3dda8; border-radius: 5px; padding: 10px 14px; margin-bottom: 20px; font-size: 9.5px; color: #2d5a0f; line-height: 1.5; }
    .export-block strong { font-size: 10px; display: block; margin-bottom: 3px; }

    /* ── FIRA Details Block ── */
    .fira-block { background: #fdfdfd; border: 1px solid #e0e0e0; border-radius: 5px; padding: 10px 14px; margin-bottom: 20px; font-size: 9.5px; color: #555; }
    .fira-block strong { font-size: 9px; display: block; margin-bottom: 6px; color: #777; text-transform: uppercase; letter-spacing: 1.5px; }
    .fira-block ul { list-style: none; padding-left: 0; }
    .fira-block li { padding: 2px 0; border-bottom: 1px dotted #eaeaea; display: flex; justify-content: space-between; max-width: 450px; }
    .fira-block li span.k { color: #888; }
    .fira-block li span.v { font-weight: 600; color: #333; }
    .fira-block .f-note { font-style: italic; color: #999; font-size: 8px; margin-top: 6px; }

    /* ── Footer ── */
    .footer { display: flex; justify-content: space-between; align-items: flex-end; padding-top: 16px; border-top: 1px solid #ddd; }
    .footer .bank { width: 55%; }
    .footer .bank h4 { font-size: 9px; text-transform: uppercase; letter-spacing: 1.5px; color: #888; font-weight: 700; margin-bottom: 6px; }
    .footer .bank .row { display: flex; font-size: 9.5px; padding: 2px 0; }
    .footer .bank .row .k { width: 95px; color: #888; }
    .footer .ref { font-size: 8.5px; color: #999; margin-top: 10px; }
    .notes { font-size: 9px; color: #777; font-style: italic; margin-top: 6px; max-width: 320px; line-height: 1.3; }
    .footer .signatory { width: 35%; text-align: center; }
    .footer .signatory .line { width: 150px; border-bottom: 1.5px solid #aaa; margin: 0 auto 5px; height: 40px; }
    .footer .signatory p { font-size: 9px; color: #666; }
    .footer .signatory .sig-name { font-weight: 700; color: #333; margin-top: 2px; }
  </style>
</head>
<body>
  <div class="page">

    <!-- ═══════ HEADER ═══════ -->
    <div class="header">
      <div class="header-left">
        <h1>Tax Invoice</h1>
      </div>
      <div class="header-right">
        <div class="trade-name">${escapeHtml(supplier.tradeName || supplier.legalName)}</div>
        ${supplier.tradeName ? `<div class="legal-name">${escapeHtml(supplier.legalName)}</div>` : ''}
        <div class="addr">${safeSupplierAddr}</div>
        <div class="ids">
          <strong>GSTIN:</strong> ${escapeHtml(supplier.gstin)} &nbsp;|&nbsp; <strong>PAN:</strong> ${escapeHtml(supplier.pan)}
        </div>
      </div>
    </div>

    <!-- ═══════ META GRID ═══════ -->
    <div class="meta-grid">
      <!-- Bill To -->
      <div class="meta-box">
        <h3>Bill To</h3>
        <div class="name">${escapeHtml(client.clientName)}</div>
        <div class="addr">${safeClientAddr}</div>
        ${client.vatId ? `<div class="ids-line"><strong>VAT ID:</strong> ${escapeHtml(client.vatId)}</div>` : ''}
      </div>
      <!-- Ship To -->
      <div class="meta-box">
        <h3>Ship To</h3>
        <div class="name">${escapeHtml(client.clientName)}</div>
        <div class="addr">${safeClientAddr}</div>
        ${client.vatId ? `<div class="ids-line"><strong>VAT ID:</strong> ${escapeHtml(client.vatId)}</div>` : ''}
      </div>
      <!-- Invoice Details -->
      <div class="meta-box">
        <div class="meta-row"><span class="label">Invoice #</span><span class="value">${escapeHtml(invoiceNumber)}</span></div>
        <div class="meta-row"><span class="label">Invoice Date</span><span class="value">${escapeHtml(invoiceDate)}</span></div>
        <div class="meta-row"><span class="label">Due Date</span><span class="value">${escapeHtml(dueDate)}</span></div>
        ${servicePeriod ? `<div class="meta-row"><span class="label">Service Period</span><span class="value">${escapeHtml(servicePeriod)}</span></div>` : ''}
        <div style="border-top:1px solid #e5e5e5; margin:5px 0;"></div>
        <div class="meta-row"><span class="label">Place of Supply</span><span class="value">${escapeHtml(placeOfSupply)}</span></div>
        <div class="meta-row"><span class="label">Currency</span><span class="value">${currency === 'INR' ? 'INR (₹)' : currency}</span></div>
        ${firaData ? `<div class="meta-row"><span class="label">Exchange Rate</span><span class="value">1 USD = ₹ ${formatExchangeRate(firaData.exchangeRate)}</span></div>` : ''}
      </div>
    </div>

    <!-- ═══════ LINE ITEMS TABLE ═══════ -->
    <table>
      <thead>
        <tr>
          <th style="width:6%">#</th>
          <th style="width:40%">Description</th>
          <th class="c" style="width:10%">SAC</th>
          <th class="c" style="width:8%">Qty</th>
          <th class="r" style="width:14%">Rate (${currency})</th>
          <th class="c" style="width:8%">IGST</th>
          <th class="r" style="width:14%">Amount (${currency})</th>
        </tr>
      </thead>
      <tbody>
        ${lineItems.map((item, idx) => `
        <tr>
          <td>${idx + 1}</td>
          <td style="line-height: 1.6;">${formatDescription(item.description)}</td>
          <td class="c">${escapeHtml(item.sacCode)}</td>
          <td class="c">${item.qty}</td>
          <td class="r">${formatCurrency(item.rate)}</td>
          <td class="c" style="color:#bbb;">0%</td>
          <td class="r">${formatCurrency(item.amount)}</td>
        </tr>`).join('')}
      </tbody>
    </table>

    <!-- ═══════ TOTALS ═══════ -->
    <div class="totals">
      <div class="totals-box">
        <div class="totals-row"><span class="label">Subtotal</span><span>${currency} ${formatCurrency(subtotal)}</span></div>
        <div class="totals-row zero"><span class="label">IGST @ 0%</span><span>${currency} 0.00</span></div>
        <div class="totals-row grand"><span>Total Due</span><span>${currency} ${formatCurrency(grandTotal)}</span></div>
      </div>
    </div>

    <!-- ═══════ EXPORT STATEMENT (Mandatory — most critical legal block) ═══════ -->
    <div class="export-block">
      <strong>${escapeHtml(exportType)}</strong>
      ${escapeHtml(gstNote)}<br/>
      GSTIN: ${escapeHtml(supplier.gstin)} | ${supplier.lut.arn ? `LUT FY ${escapeHtml(supplier.lut.financialYear)} | ARN ${escapeHtml(supplier.lut.arn)}` : `FY ${escapeHtml(supplier.lut.financialYear)}`}
    </div>

    ${firaData ? `
    <!-- ═══════ FOREIGN INWARD REMITTANCE DETAILS ═══════ -->
    <div class="fira-block">
      <strong>Foreign Inward Remittance Details (FIRA)</strong>
      <ul>
        <li><span class="k">Total Billed Amount:</span><span class="v">USD ${formatCurrency(firaData.originalUsdBilled)}</span></li>
        <li><span class="k">Realized Amount (via FIRA):</span><span class="v">USD ${formatCurrency(firaData.fundsRealizedUsd)} (₹ ${formatCurrency(firaData.fundsRealizedInr)})</span></li>
        ${firaData.bankChargesUsd > 0 ? `<li><span class="k">Intermediary Bank Charges:</span><span class="v">USD ${formatCurrency(firaData.bankChargesUsd)}</span></li>` : ''}
        <li><span class="k">Exchange Rate Applied:</span><span class="v">1 USD = ₹ ${formatExchangeRate(firaData.exchangeRate)}</span></li>
        <li><span class="k">FIRA Reference No:</span><span class="v">${escapeHtml(firaData.firaRef)}</span></li>
        <li><span class="k">Realized Date:</span><span class="v">${escapeHtml(firaData.firaDate)}</span></li>
      </ul>
      <div class="f-note">* Note: Invoice generated mathematically proportional to exact FIRA realization per banking documentation.</div>
    </div>
    ` : ''}

    <!-- ═══════ FOOTER ═══════ -->
    <div class="footer">
      <div class="bank">
        <h4>Bank Details</h4>
        <div class="row"><span class="k">Bank Name</span><span>${escapeHtml(supplier.bankName || '—')}</span></div>
        <div class="row"><span class="k">Account #</span><span>${escapeHtml(supplier.accountNumber || '—')}</span></div>
        <div class="row"><span class="k">IFSC</span><span>${escapeHtml(supplier.ifsc || '—')}</span></div>
        <div class="row"><span class="k">Branch</span><span>${escapeHtml(supplier.branch || '—')}</span></div>
        ${deelRef ? `<div class="ref">Deel Ref: ${escapeHtml(deelRef)}</div>` : ''}
        ${terms ? `<div class="notes">${escapeHtml(terms)}</div>` : ''}
      </div>
      <div class="signatory">
        <div class="line"></div>
        <p>Authorised Signatory</p>
        <p class="sig-name">${escapeHtml(supplier.legalName)}</p>
        <p>(${escapeHtml(supplier.designation || 'Proprietor')})</p>
      </div>
    </div>

  </div>
</body>
</html>`;

  return withRenderSlot(async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      // The template is static HTML: no scripts and no network, so injected markup can't fetch anything
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const url = req.url();
        if (url.startsWith("data:") || url.startsWith("about:")) req.continue();
        else req.abort();
      });
      await page.setContent(htmlContent, { waitUntil: 'load', timeout: 15000 });
      const pdfUint8Array = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '8mm', bottom: '8mm', left: '8mm', right: '8mm' },
      });
      return Buffer.from(pdfUint8Array);
    } finally {
      await browser.close();
    }
  });
}

function formatCurrency(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatExchangeRate(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDescription(value: string): string {
  const parts = escapeHtml(value).split("\n");
  if (parts.length === 1) {
    return parts[0];
  }

  return [
    parts[0],
    ...parts.slice(1).map(
      (part) =>
        `<br/><span style="color:#888; font-size:8.5px; font-style:italic;">${part}</span>`,
    ),
  ].join("");
}
