import { randomUUID } from "node:crypto";
import { type StateStore } from "./store.js";
import { contactPatchSchema, invoiceInputSchema, type Contact, type Invoice } from "./types.js";

export class CompanyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "CompanyError";
  }
}

function sameInvoice(left: Omit<Invoice, "id" | "createdAt">, right: Invoice): boolean {
  return left.invoiceNumber === right.invoiceNumber && left.company === right.company && left.amount === right.amount &&
    left.currency === right.currency && left.issuedDate === right.issuedDate && left.dueDate === right.dueDate &&
    left.sourceMessageId === right.sourceMessageId;
}

export async function createInvoice(
  store: StateStore,
  input: unknown,
  dispatchAllowed: () => boolean = () => true,
  workerRunId?: string,
): Promise<{ invoice: Invoice; created: boolean }> {
  let inputWithIssueDate = input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (!record.issuedDate && typeof record.sourceMessageId === "string") {
      const sourceDate = store.getState().company.messages.find((message) => message.id === record.sourceMessageId)?.invoice?.issuedDate;
      if (sourceDate) inputWithIssueDate = { ...record, issuedDate: sourceDate };
    }
  }
  const parsed = invoiceInputSchema.safeParse(inputWithIssueDate);
  if (!parsed.success) throw new CompanyError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
  const values = parsed.data;
  if (values.dueDate < values.issuedDate) throw new CompanyError(400, "Due date cannot be before issue date");

  const result = await store.mutate((state) => {
    if (!dispatchAllowed()) return { kind: "cancelled" as const };
    const existing = state.company.invoices.find((invoice) => invoice.invoiceNumber.toLowerCase() === values.invoiceNumber.toLowerCase() || invoice.sourceMessageId === values.sourceMessageId);
    if (existing) {
      if (!sameInvoice(values, existing)) return { kind: "conflict" as const };
      return { kind: "existing" as const, invoice: existing };
    }

    const source = state.company.messages.find((message) => message.id === values.sourceMessageId)?.invoice;
    if (!source || source.invoiceNumber !== values.invoiceNumber || source.company !== values.company || source.amount !== values.amount ||
      source.currency.toUpperCase() !== values.currency || source.issuedDate !== values.issuedDate || source.dueDate !== values.dueDate) {
      return { kind: "source-mismatch" as const };
    }
    if (state.company.saveFailuresRemaining > 0) {
      state.company.saveFailuresRemaining -= 1;
      return { kind: "transient-failure" as const };
    }
    const invoice: Invoice = { id: randomUUID(), ...values, createdAt: new Date().toISOString() };
    state.company.invoices.push(invoice);
    if (workerRunId) recordWorkerEffect(state, workerRunId, `Invoice ${invoice.invoiceNumber} saved (${invoice.company}, ${invoice.amount.toFixed(2)} ${invoice.currency}).`);
    return { kind: "created" as const, invoice };
  });

  if (result.kind === "conflict") throw new CompanyError(409, "An invoice with this invoice number already exists with different details");
  if (result.kind === "source-mismatch") throw new CompanyError(422, "Invoice fields do not match the selected source message");
  if (result.kind === "transient-failure") throw new CompanyError(503, "Temporary invoice save failure. The invoice was not saved; retry the same operation.");
  if (result.kind === "cancelled") throw new CompanyError(409, "The worker run was cancelled before the write could be committed");
  return { invoice: result.invoice, created: result.kind === "created" };
}

export async function updateContact(
  store: StateStore,
  contactId: string,
  input: unknown,
  dispatchAllowed: () => boolean = () => true,
  workerRunId?: string,
): Promise<Contact> {
  const parsed = contactPatchSchema.safeParse(input);
  if (!parsed.success) throw new CompanyError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
  return store.mutate((state) => {
    if (!dispatchAllowed()) throw new CompanyError(409, "The worker run was cancelled before the write could be committed");
    const contact = state.company.contacts.find((candidate) => candidate.id === contactId);
    if (!contact) throw new CompanyError(404, "Contact not found");
    Object.assign(contact, parsed.data, { updatedAt: new Date().toISOString() });
    if (workerRunId) recordWorkerEffect(state, workerRunId, `Contact ${contact.company} updated.`);
    return contact;
  });
}

function recordWorkerEffect(state: ReturnType<StateStore["getState"]>, runId: string, message: string): void {
  const run = state.runs[runId];
  if (!run) return;
  const time = new Date().toISOString();
  run.partialEffects ??= [];
  run.partialEffects.push(message);
  run.events.push({ id: randomUUID(), time, type: "action", message, data: { committed: true } });
  run.updatedAt = time;
  if (run.status === "cancelled") run.summary = `Cancelled after a committed write: ${message}`;
}
