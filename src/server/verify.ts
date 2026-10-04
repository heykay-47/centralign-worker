import { readFile } from "node:fs/promises";
import { type GoalContract, invoiceReportRows } from "./goals.js";
import { type StateStore } from "./store.js";
import { sandboxFilePath } from "./safety.js";
import { type Evidence, type ModelDecision } from "./types.js";

export type VerificationResult = { ok: boolean; errors: string[]; evidence: Evidence[]; summary?: string };

function pipeRows(content: string): string[] {
  return content.split(/\r?\n/).map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()).join("|"));
}

export async function verifyFinish(options: {
  store: StateStore;
  runId: string;
  decision: ModelDecision;
  goal: GoalContract;
  workspaceRoot: string;
}): Promise<VerificationResult> {
  const { store, runId, decision, goal, workspaceRoot } = options;
  const state = store.getState();
  const errors: string[] = [];
  const evidence: Evidence[] = [];
  let summary: string | undefined;
  const checks = decision.action.type === "finish" ? decision.action.checks : [];
  const invoiceChecks = checks.filter((check) => check.type === "invoice");
  const fileChecks = checks.filter((check) => check.type === "file");

  if (goal.kind === "invoice_import") {
    if (goal.needsClarification || !goal.sourceMessageId || !goal.invoiceNumber) {
      errors.push("The original invoice goal is ambiguous. Ask the user to identify a company or invoice before proceeding.");
    }
    if (checks.length !== 1 || invoiceChecks.length !== 1) {
      errors.push("The original goal is an invoice import; completion must verify that exact invoice, not an unrelated effect.");
    }
    const check = invoiceChecks[0];
    if (check && goal.sourceMessageId && goal.invoiceNumber) {
      const source = state.company.messages.find((message) => message.id === goal.sourceMessageId);
      const expected = source?.invoice;
      const stored = state.company.invoices.find((invoice) => invoice.invoiceNumber === goal.invoiceNumber);
      if (check.sourceMessageId !== goal.sourceMessageId || check.invoiceNumber !== goal.invoiceNumber) {
        errors.push("The completion check does not match the invoice required by the original task. Inspect visible source messages and retry.");
      } else if (!source || !expected || !stored || stored.sourceMessageId !== source.id ||
        stored.invoiceNumber !== expected.invoiceNumber || stored.company !== expected.company || stored.amount !== expected.amount ||
        stored.currency !== expected.currency || stored.issuedDate !== expected.issuedDate || stored.dueDate !== expected.dueDate) {
        errors.push("The persisted invoice does not match the source fields required by the original task.");
      } else if (goal.latest) {
        const companyMessages = state.company.messages.filter((message) => message.invoice?.company === expected.company);
        const newest = [...companyMessages].sort((a, b) =>
          (b.invoice?.issuedDate ?? "").localeCompare(a.invoice?.issuedDate ?? "") ||
          (a.invoice?.invoiceNumber ?? "").localeCompare(b.invoice?.invoiceNumber ?? "") || a.id.localeCompare(b.id),
        )[0];
        if (newest?.id !== source.id) errors.push(`The candidate invoice is not the latest source invoice by issued date for ${expected.company}. Inspect visible source messages and retry.`);
      }
      if (!errors.length && source?.invoice && stored) {
        evidence.push({ label: `Verified invoice ${stored.invoiceNumber}`, url: "/company?tab=accounting" });
        summary = `Imported and verified ${stored.invoiceNumber} for ${stored.company}: ${stored.amount.toFixed(2)} ${stored.currency}, due ${stored.dueDate}.`;
      }
    }
  } else if (goal.kind === "invoice_report") {
    if (checks.length !== 1 || fileChecks.length !== 1) {
      errors.push("The original goal is an invoice inbox report; completion must verify one report file against the complete source universe.");
    }
    const check = fileChecks[0];
    if (check) {
      try {
        const filePath = sandboxFilePath(`${workspaceRoot}/${runId}`, check.path);
        const content = await readFile(filePath, "utf8");
        const lines = pipeRows(content);
        const header = lines[0]?.toLocaleLowerCase();
        const rows = lines.slice(1);
        const expectedRows = invoiceReportRows(state.company);
        const expectedHeader = "invoice|company|amount|currency|issued date|due date";
        if (header !== expectedHeader) errors.push("Report must contain only the canonical invoice table with the six required columns.");
        if (JSON.stringify(rows) !== JSON.stringify(expectedRows)) {
          errors.push("Report rows do not exactly cover the latest invoice per company, in deterministic order, with source-backed amounts, currencies, issued dates, and due dates; extra claims or rows are not allowed.");
        }
        const missingIncludes = check.includes.filter((text) => !content.includes(text));
        if (missingIncludes.length) errors.push(`Report is missing requested content: ${missingIncludes.join(", ")}.`);
        if (!errors.length) {
          evidence.push({ label: `Verified complete invoice report (${rows.length} companies)`, url: `/api/runs/${runId}/file?path=${encodeURIComponent(check.path)}` });
          summary = `Created and verified ${check.path}: one latest, source-backed invoice for each of ${rows.length} companies.`;
        }
      } catch {
        errors.push(`Report file ${check.path} does not exist in this run's sandbox.`);
      }
    }
  } else {
    errors.push(`${goal.reason} Ask the user to restate the task as an invoice import or invoice report; no arbitrary check can complete an unsupported goal.`);
  }

  return { ok: errors.length === 0, errors, evidence, ...(summary ? { summary } : {}) };
}
