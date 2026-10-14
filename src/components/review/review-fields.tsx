"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useReview } from "./context";
import { FieldRow } from "./field-row";
import { LineItems } from "./line-items";

function Group({ id, title, description, tone, children }: { id: string; title: string; description: string; tone: string; children: React.ReactNode }) {
  return (
    <Card role="group" aria-labelledby={id} className="overflow-hidden rounded-[28px] border-2 border-black bg-white shadow-[8px_8px_0_0_black]">
      <CardHeader className={`border-b-2 border-black ${tone}`}>
        <CardTitle id={id} tabIndex={-1} className="text-xl font-black uppercase tracking-[0.04em] outline-none">
          {title}
        </CardTitle>
        <CardDescription className="text-sm leading-6 text-black/70">{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 p-4 pt-5 sm:p-6">{children}</CardContent>
    </Card>
  );
}

const Grid = ({ children }: { children: React.ReactNode }) => <div className="grid gap-4 sm:grid-cols-2">{children}</div>;

export function DeelGroup() {
  return (
    <Group id="group-deel" title="Deel invoice" description="Compare each value with the Deel PDF. Amber and red fields were not read with full confidence." tone="bg-[#FFF4C4]">
      <FieldRow path="deel.invoiceNumber" label="Invoice number" required />
      <Grid>
        <FieldRow path="deel.issueDate" label="Issue date" required placeholder="YYYY-MM-DD" />
        <FieldRow path="deel.dueDate" label="Due date" placeholder="YYYY-MM-DD" />
        <FieldRow path="deel.periodStart" label="Service period start" placeholder="YYYY-MM-DD" />
        <FieldRow path="deel.periodEnd" label="Service period end" placeholder="YYYY-MM-DD" />
      </Grid>
      <Grid>
        <FieldRow path="deel.clientName" label="Client name" required />
        <FieldRow path="deel.clientCountry" label="Client country" />
        <FieldRow path="deel.clientVatId" label="Client VAT ID" />
        <FieldRow path="deel.clientRegistrationNumber" label="Client registration number" />
      </Grid>
      <FieldRow path="deel.clientAddress" label="Client address" kind="textarea" />
      <LineItems />
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldRow path="deel.subtotal" label="Subtotal (USD)" kind="amount" />
        <FieldRow path="deel.vat" label="VAT (USD)" kind="amount" />
        <FieldRow path="deel.total" label="Total (USD)" kind="amount" required />
      </div>
    </Group>
  );
}

export function FiraGroup() {
  const { draft } = useReview();
  const manual = draft.fira?.source === "manual";
  return (
    <Group
      id="group-fira"
      title="FIRA"
      description={draft.fira ? (manual ? "Entered manually. Check each value against the bank or Skydo statement." : "Compare each value with the FIRA PDF.") : "No FIRA was provided."}
      tone="bg-[#E9F6FF]"
    >
      {draft.fira ? (
        <Grid>
          <FieldRow path="fira.firaRef" label="Reference" hint={manual ? "Entered manually" : undefined} />
          <FieldRow path="fira.processedDate" label="Processed date" placeholder="DD-MM-YYYY or YYYY-MM-DD" hint={manual ? "Entered manually" : undefined} />
          <FieldRow path="fira.fcyAmount" label="USD received" kind="amount" hint={manual ? "Entered manually" : undefined} />
          <FieldRow path="fira.inrAmount" label="INR amount" kind="amount" hint={manual ? "Entered manually" : undefined} />
        </Grid>
      ) : (
        <p className="rounded-2xl border-2 border-dashed border-black/30 bg-[#F8F7F3] p-4 text-sm leading-6 text-black/70">
          The invoice will be issued in USD. To issue it in INR, start over and attach the FIRA PDF or enter the realization details manually.
        </p>
      )}
    </Group>
  );
}

const INVOICE_NUMBER = /^INV-\d{2}-\d{2}(-[\w-]+)?$/i;

export function OptionsGroup() {
  const { draft } = useReview();
  const override = draft.options.overrideInvoiceNumber;
  return (
    <Group id="group-options" title="Options" description="Leave blank to use your standard settings. Change only when this invoice differs." tone="bg-[#F4EDFF]">
      <Grid>
        <FieldRow path="options.placeOfSupply" label="Place of supply" placeholder="Outside India (e.g. United States)" />
        <FieldRow path="options.overrideHsnSac" label="SAC code" placeholder="998392" />
      </Grid>
      <FieldRow
        path="options.overrideInvoiceNumber"
        label="Invoice number override"
        placeholder="INV-25-26-001"
        hint={
          override && !INVOICE_NUMBER.test(override)
            ? "Unusual format. Expected INV-YY-YY-XX so Airtable and GST records stay aligned."
            : "Blank: derived from the Deel issue date"
        }
      />
      <FieldRow path="options.notes" label="GST note" kind="textarea" placeholder="Leave blank for the standard export statement." />
    </Group>
  );
}
