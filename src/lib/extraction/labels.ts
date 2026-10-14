/**
 * Every label the engine reads a value from, per field, in one table. Deel and the bank rename labels without
 * notice (Deel: "TOTAL DUE" → "TOTAL", "Sub total" → "Subtotal" in July 2026; the bank split
 * "Customer Transaction Reference No" over two lines in October 2026), so a new spelling is one line here.
 *
 * Matching ignores case, spaces, punctuation and a trailing "No" / "No." / "#" / ":".
 * `weak` synonyms are used only when no other synonym of the field is on the page, and cap the confidence at medium.
 */

export interface Synonym {
  text: string;
  weak?: boolean;
}

const s = (...texts: string[]): Synonym[] => texts.map((text) => ({ text }));
const weak = (...texts: string[]): Synonym[] => texts.map((text) => ({ text, weak: true }));

export const LABELS = {
  // Deel invoice
  "deel.invoiceNumber": s("Invoice #", "Invoice No", "Invoice Number", "Document", "Document No", "Invoice ID"),
  "deel.issueDate": s("Issue Date", "Date Issued", "Issued On", "Invoice Date"),
  "deel.dueDate": s("Due Date", "Payment Due", "Due On"),
  /** Header and summary totals share the synonyms; which one a label is depends on where it sits (above or below the item table) */
  "deel.total": s("TOTAL DUE", "TOTAL", "Amount Due", "Balance Due", "Total Amount", "Grand Total"),
  "deel.subtotal": s("Subtotal", "Sub total", "Sub-total"),
  "deel.vat": s("VAT", "Tax", "Sales Tax"),
  "deel.deelRef": s("Deel Ref", "Deel Ref.", "Deel Reference"),
  "deel.billTo": s("BILL TO", "Billed To", "Invoice To"),
  "deel.billFrom": s("BILL FROM", "Billed From"),
  "deel.itemTable": s("Description", "Item", "Items", "Details", "Item Description"),
  // FIRA
  "fira.firaRef": s("Customer Transaction Reference", "Transaction Reference", "Customer Reference", "Remittance Reference"),
  "fira.processedDate": [...s("Processed Date", "Processing Date", "Credit Date"), ...weak("Value Date", "Transaction Date")],
  "fira.fcyAmount": s("FCY Amount", "Foreign Currency Amount", "Remittance Amount", "Amount in FCY"),
  "fira.inrAmount": s("INR Amount", "Amount in INR", "Credited Amount", "Credit Amount", "Rupee Equivalent"),
  "fira.currency": s("Currency", "FCY", "Remittance Currency", "Currency Code"),
} satisfies Record<string, Synonym[]>;

export type LabelField = keyof typeof LABELS;

/** Line items Deel prints in its table, matched as a prefix of the row ("Bonus: 2026 CEO Bonus"). "Fixed contract" is a section header, not an item. */
export const LINE_ITEM_PREFIX = /^(?:Fixed rate|Other|Bonus)\s*:/i;

/** Labels that carry no value of their own but are kept in the masked layout skeleton. */
export const STRUCTURAL_LABELS = [
  "INVOICE", "Amount", "Fixed contract", "VAT ID", "Registration number", "Group", "Page",
  "FOREIGN INWARD REMITTANCE CERTIFICATE", "Inward Remittance Certificate", "Remitter Name", "Remitter Address",
  "Purpose of Remittance", "Purpose Code", "No",
  "TAX INVOICE", "GSTIN", "Export of Services", "Place of Supply", "SAC", "HSN/SAC", "Bank Name",
  "FORM GST RFD-11", "Letter of Undertaking", "Date",
];

/** Lowercase letters and digits only, with a trailing "No" / "No." / "#" / ":" dropped. */
export function labelKey(text: string): string {
  const tokens = text.trim().split(/\s+/);
  while (tokens.length > 1 && /^(?:no\.?|#|:)$/i.test(tokens[tokens.length - 1])) tokens.pop();
  let last = tokens[tokens.length - 1] ?? "";
  last = last.replace(/(?:#|:|\.)+$/, "");
  if (tokens.length > 1 && /^no\.?$/i.test(last)) tokens.pop();
  else tokens[tokens.length - 1] = last;
  return tokens.join("").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const keyIndex = new Map<string, { field: LabelField; synonym: Synonym }[]>();
for (const [field, synonyms] of Object.entries(LABELS) as [LabelField, Synonym[]][]) {
  for (const synonym of synonyms) {
    const key = labelKey(synonym.text);
    const entries = keyIndex.get(key) ?? [];
    // "Subtotal", "Sub total" and "Sub-total" are one key: keep the first spelling per field
    if (!entries.some((e) => e.field === field)) keyIndex.set(key, [...entries, { field, synonym }]);
  }
}
const structuralKeys = new Set(STRUCTURAL_LABELS.map(labelKey));

/** Fields whose synonym is exactly this text (after normalising). */
export function fieldsForLabel(text: string): { field: LabelField; synonym: Synonym }[] {
  return keyIndex.get(labelKey(text)) ?? [];
}

/** True for any label the engine knows, value-bearing or structural. Used to keep labels in the skeleton and to stop value searches. */
export function isKnownLabel(text: string): boolean {
  const key = labelKey(text);
  return key.length > 0 && (keyIndex.has(key) || structuralKeys.has(key));
}

/** Synonyms of a field as normalised keys, longest first, for prefix ("Label: value") matching. */
export function synonymKeys(field: LabelField): { key: string; synonym: Synonym }[] {
  return LABELS[field].map((synonym) => ({ key: labelKey(synonym.text), synonym })).sort((a, b) => b.key.length - a.key.length);
}
