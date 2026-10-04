import { type CompanyMessage, type CompanyState } from "./types.js";

export type GoalContract =
  | { kind: "invoice_import"; company?: string; sourceMessageId?: string; invoiceNumber?: string; latest: boolean; needsClarification: boolean; userSpecifiedCompany: boolean; userSpecifiedInvoiceNumber: boolean }
  | { kind: "invoice_report"; needsClarification: false }
  | { kind: "unsupported"; reason: string; needsClarification: false };

export type PlannerGoal =
  | { kind: "invoice_import"; company?: string; latest: boolean; needsClarification: boolean }
  | { kind: "invoice_report"; universe: "all inbox invoices; latest per company by issued date"; needsClarification: false }
  | { kind: "unsupported"; reason: string; needsClarification: false };

function messageForInvoiceNumber(company: CompanyState, task: string): CompanyMessage | undefined {
  const invoiceNumber = task.match(/\b[A-Z]{1,8}-\d{2,}\b/i)?.[0];
  if (!invoiceNumber) return undefined;
  return company.messages.find((message) => message.invoice?.invoiceNumber.toLowerCase() === invoiceNumber.toLowerCase());
}

function companyMention(task: string, company: CompanyState): string | undefined {
  const names = [...new Set([
    ...company.messages.flatMap((message) => message.invoice ? [message.invoice.company] : []),
    ...company.contacts.map((contact) => contact.company),
  ])];
  const matches = names.filter((name) => task.toLocaleLowerCase().includes(name.toLocaleLowerCase()));
  return matches.length === 1 ? matches[0] : undefined;
}

function latestInvoiceMessage(messages: CompanyMessage[]): CompanyMessage | undefined {
  return [...messages].sort((a, b) =>
    (b.invoice?.issuedDate ?? "").localeCompare(a.invoice?.issuedDate ?? "") ||
    (a.invoice?.invoiceNumber ?? "").localeCompare(b.invoice?.invoiceNumber ?? "") ||
    a.id.localeCompare(b.id),
  )[0];
}

export function deriveGoalContract(task: string, company: CompanyState): GoalContract {
  const normalized = task.toLocaleLowerCase();
  const isInvoiceTask = /\binvoices?\b/i.test(task);
  const isWrite = /\b(import|add|create|record|enter|save|log)\b/i.test(task);
  const isReport = /\b(report|summary|summari[sz](?:e|ed|ing|ation)?|export|list|overview)\b/i.test(task);

  if (isInvoiceTask && isWrite && !isReport) {
    const specific = messageForInvoiceNumber(company, task);
    const explicitCompany = companyMention(task, company);
    const userSpecifiedInvoiceNumber = Boolean(task.match(/\b[A-Z]{1,8}-\d{2,}\b/i));
    const requestedCompany = explicitCompany ?? specific?.invoice?.company;
    const latest = /\b(latest|most recent|newest)\b/i.test(task);
    const byCompany = requestedCompany
      ? company.messages.filter((message) => message.invoice?.company === requestedCompany)
      : [];
    const source = specific ?? (latest ? latestInvoiceMessage(byCompany) : byCompany.length === 1 ? byCompany[0] : undefined);
    const ambiguous = !source || (latest && !requestedCompany && !specific);
    return {
      kind: "invoice_import",
      ...(requestedCompany ? { company: requestedCompany } : {}),
      ...(source?.id ? { sourceMessageId: source.id } : {}),
      ...(source?.invoice?.invoiceNumber ? { invoiceNumber: source.invoice.invoiceNumber } : {}),
      latest,
      needsClarification: ambiguous,
      userSpecifiedCompany: Boolean(explicitCompany),
      userSpecifiedInvoiceNumber,
    };
  }
  if (isInvoiceTask && isReport) return { kind: "invoice_report", needsClarification: false };
  return {
    kind: "unsupported",
    reason: "Autonomous worker tasks are limited to importing a specific/latest invoice or creating a source-backed invoice report. Contact CRUD remains available in the company UI.",
    needsClarification: false,
  };
}

export function plannerGoal(goal: GoalContract): PlannerGoal {
  if (goal.kind === "invoice_import") {
    return {
      kind: goal.kind,
      ...(goal.userSpecifiedCompany && goal.company ? { company: goal.company } : {}),
      latest: goal.latest,
      needsClarification: goal.needsClarification,
    };
  }
  if (goal.kind === "invoice_report") {
    return { kind: goal.kind, universe: "all inbox invoices; latest per company by issued date", needsClarification: false };
  }
  return { kind: goal.kind, reason: goal.reason, needsClarification: false };
}

export function invoiceReportRows(company: CompanyState): string[] {
  const byCompany = new Map<string, CompanyMessage[]>();
  for (const message of company.messages) {
    if (!message.invoice) continue;
    const records = byCompany.get(message.invoice.company) ?? [];
    records.push(message);
    byCompany.set(message.invoice.company, records);
  }
  return [...byCompany.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, messages]) => {
      const latest = latestInvoiceMessage(messages)?.invoice;
      return latest ? [`${latest.invoiceNumber}|${latest.company}|${latest.amount.toFixed(2)}|${latest.currency}|${latest.issuedDate}|${latest.dueDate}`] : [];
    });
}
