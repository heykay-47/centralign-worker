import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompanyError, createInvoice } from "../src/server/company.js";
import { deriveGoalContract, invoiceReportRows, plannerGoal } from "../src/server/goals.js";
import { OpenCodePlanner, parseModelDecision, parseOpenCodeDecision, parseOpenCodeEventText } from "../src/server/provider.js";
import { isAllowedCompanyUrl, sandboxFilePath, writeSandboxFile } from "../src/server/safety.js";
import { StateStore } from "../src/server/store.js";
import { verifyFinish } from "../src/server/verify.js";
import { type ModelDecision } from "../src/server/types.js";

type FinishChecks = Extract<ModelDecision["action"], { type: "finish" }>["checks"];

async function temporaryStore(): Promise<{ root: string; store: StateStore }> {
  const root = await mkdtemp(join(tmpdir(), "centralign-core-test-"));
  const store = new StateStore(join(root, "state.json"));
  await store.initialize();
  return { root, store };
}

function sourceInvoice(store: StateStore, invoiceNumber: string) {
  const source = store.getState().company.messages.find((message) => message.invoice?.invoiceNumber === invoiceNumber);
  assert.ok(source?.invoice);
  return {
    invoiceNumber: source.invoice.invoiceNumber,
    company: source.invoice.company,
    amount: source.invoice.amount,
    currency: source.invoice.currency,
    issuedDate: source.invoice.issuedDate,
    dueDate: source.invoice.dueDate,
    sourceMessageId: source.id,
  };
}

function finishDecision(checks: FinishChecks): ModelDecision {
  return { plan: ["Verify actual records"], decisionNote: "Checking persisted state.", action: { type: "finish", summary: "Done", checks } } as ModelDecision;
}

test("invoice failure is real, retry is idempotent, and source/invoice keys stay unique", async () => {
  const { root, store } = await temporaryStore();
  try {
    const invoice = sourceInvoice(store, "NS-1042");
    await store.mutate((state) => { state.company.saveFailuresRemaining = 1; });
    await assert.rejects(createInvoice(store, invoice), (error: unknown) => error instanceof CompanyError && error.status === 503);
    assert.equal(store.getState().company.invoices.length, 0, "the failed save must not persist");
    assert.equal(store.getState().company.saveFailuresRemaining, 0);

    const first = await createInvoice(store, invoice);
    assert.equal(first.created, true);
    const duplicate = await createInvoice(store, invoice);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.invoice.id, first.invoice.id);
    assert.equal(store.getState().company.invoices.length, 1);

    await assert.rejects(
      createInvoice(store, { ...invoice, invoiceNumber: "NS-1042-OTHER" }),
      (error: unknown) => error instanceof CompanyError && error.status === 409,
      "the same source message cannot be saved under a second invoice key",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("latest invoice goal and verifier use issued date, not inbox order or model claims", async () => {
  const { root, store } = await temporaryStore();
  try {
    const goal = deriveGoalContract("Import the latest invoice from Northstar Labs", store.getState().company);
    assert.equal(goal.kind, "invoice_import");
    if (goal.kind !== "invoice_import") throw new Error("Expected invoice import goal");
    assert.equal(goal.invoiceNumber, "NS-1042");
    const publicGoal = plannerGoal(goal);
    assert.deepEqual(publicGoal, { kind: "invoice_import", company: "Northstar Labs", latest: true, needsClarification: false });
    assert.equal("sourceMessageId" in publicGoal, false);
    assert.equal("invoiceNumber" in publicGoal, false, "the verifier's precomputed latest choice stays private");

    const oldInvoice = sourceInvoice(store, "NS-1031");
    await createInvoice(store, oldInvoice);
    const falseLatest = finishDecision([{ type: "invoice", invoiceNumber: "NS-1031", sourceMessageId: oldInvoice.sourceMessageId }]);
    const rejected = await verifyFinish({ store, runId: "run-old", decision: falseLatest, goal, workspaceRoot: join(root, "workspace") });
    assert.equal(rejected.ok, false);
    assert.ok(rejected.errors.some((error) => error.includes("original task") || error.includes("visible source")));
    assert.equal(rejected.errors.some((error) => error.includes("NS-1042")), false, "verification feedback must not leak the hidden latest invoice choice");

    const latestInvoice = sourceInvoice(store, "NS-1042");
    await createInvoice(store, latestInvoice);
    const trueLatest = finishDecision([{ type: "invoice", invoiceNumber: "NS-1042", sourceMessageId: latestInvoice.sourceMessageId }]);
    const accepted = await verifyFinish({ store, runId: "run-latest", decision: trueLatest, goal, workspaceRoot: join(root, "workspace") });
    assert.equal(accepted.ok, true, accepted.errors.join("; "));
    assert.match(accepted.summary ?? "", /^Imported and verified NS-1042 for Northstar Labs: 1840\.50 USD, due 2026-10-20\.$/);

    const reportOnly = finishDecision([{ type: "file", path: "old-report.md", includes: ["NS-1042"] }]);
    const fakeFinish = await verifyFinish({ store, runId: "run-latest", decision: reportOnly, goal, workspaceRoot: join(root, "workspace") });
    assert.equal(fakeFinish.ok, false, "an unrelated report must not satisfy an invoice import goal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invoice report verifier requires exact latest-per-company source coverage", async () => {
  const { root, store } = await temporaryStore();
  const workspaceRoot = join(root, "workspace");
  const runId = "run-report";
  const runWorkspace = join(workspaceRoot, runId);
  try {
    const goal = deriveGoalContract("Create an invoice report from the inbox", store.getState().company);
    assert.equal(goal.kind, "invoice_report");
    assert.equal(deriveGoalContract("Summarize the latest invoices in the inbox", store.getState().company).kind, "invoice_report");
    await mkdir(runWorkspace, { recursive: true });
    const fileCheck = [{ type: "file" as const, path: "inbox.md", includes: ["NS-1042"] }];
    await writeSandboxFile(runWorkspace, "inbox.md", [
      "Invoice|Company|Amount|Currency|Issued date|Due date",
      "NS-1042|Northstar Labs|1840.50|USD|2026-10-02|2026-10-20",
    ].join("\n"));
    const incomplete = await verifyFinish({ store, runId, decision: finishDecision(fileCheck), goal, workspaceRoot });
    assert.equal(incomplete.ok, false);
    assert.ok(incomplete.errors.some((error) => error.includes("exactly cover")));

    const expectedRows = invoiceReportRows(store.getState().company);
    assert.deepEqual(expectedRows, [
      "CS-219|Cedar Studio|275.00|USD|2026-10-01|2026-10-12",
      "NS-1042|Northstar Labs|1840.50|USD|2026-10-02|2026-10-20",
    ]);
    await writeSandboxFile(runWorkspace, "inbox.md", [
      "Invoice|Company|Amount|Currency|Issued date|Due date",
      ...expectedRows,
    ].join("\n"));
    const complete = await verifyFinish({ store, runId, decision: finishDecision(fileCheck), goal, workspaceRoot });
    assert.equal(complete.ok, true, complete.errors.join("; "));

    await writeSandboxFile(runWorkspace, "inbox.md", [
      "Invoice|Company|Amount|Currency|Issued date|Due date",
      ...expectedRows,
      "NS-1031|Northstar Labs|920.00|USD|2026-09-02|2026-09-20",
    ].join("\n"));
    const extraOldInvoice = await verifyFinish({ store, runId, decision: finishDecision(fileCheck), goal, workspaceRoot });
    assert.equal(extraOldInvoice.ok, false, "older inbox invoices may not inflate the report universe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported goals fail closed even when the model offers an unrelated existing check", async () => {
  const { root, store } = await temporaryStore();
  const workspaceRoot = join(root, "workspace");
  const runId = "run-unsupported";
  try {
    const goal = deriveGoalContract("Delete all invoices from accounting", store.getState().company);
    assert.equal(goal.kind, "unsupported");
    await writeSandboxFile(join(workspaceRoot, runId), "unrelated.md", "A previous report already exists.");
    const arbitraryCheck = finishDecision([{ type: "file", path: "unrelated.md", includes: ["previous report"] }]);
    const result = await verifyFinish({ store, runId, decision: arbitraryCheck, goal, workspaceRoot });
    assert.equal(result.ok, false);
    assert.match(result.errors[0] ?? "", /scope|unsupported/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser and file boundaries reject dashboard, external, and traversal targets", async () => {
  const origin = "http://127.0.0.1:3000/company";
  assert.equal(isAllowedCompanyUrl("/company?tab=inbox", origin), true);
  assert.equal(isAllowedCompanyUrl("/company/receipt", origin), true);
  assert.equal(isAllowedCompanyUrl("/", origin), false);
  assert.equal(isAllowedCompanyUrl("/api/runs/abc/approve", origin), false);
  assert.equal(isAllowedCompanyUrl("https://example.com/company", origin), false);
  assert.equal(isAllowedCompanyUrl("file:///etc/passwd", origin), false);

  const { root } = await temporaryStore();
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await assert.rejects(writeSandboxFile(workspace, "../escape.md", "no"));
    await assert.rejects(writeSandboxFile(workspace, "secret.html", "no"));
    assert.throws(() => sandboxFilePath(workspace, "/tmp/outside.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode JSON event parser reads text and rejects any tool-call event", () => {
  const textEvent = JSON.stringify({ type: "text", part: { id: "p1", type: "text", text: "{\"plan\":[\"Observe\"],\"decisionNote\":\"Read\",\"action\":{\"type\":\"observe\"}}" } });
  const text = parseOpenCodeEventText(textEvent);
  assert.deepEqual(parseModelDecision(text).action, { type: "observe" });
  assert.throws(() => parseOpenCodeEventText(JSON.stringify({ type: "message.part.updated", part: { type: "tool", tool: "shell" } })), /tool/i);
  assert.throws(() => parseOpenCodeEventText(JSON.stringify({ type: "message.updated", parts: [{ type: "text", text: "{}" }, { type: "tool", tool: "shell" }] })), /tool/i);
  const oneMessage = JSON.stringify({ type: "message.updated", info: { role: "assistant" }, parts: [{ id: "p1", type: "text", text: "decision" }] });
  assert.equal(parseOpenCodeEventText(`${oneMessage}\n${JSON.stringify({ type: "message.updated", info: { role: "assistant" }, parts: [{ id: "p1", type: "text", text: "final decision" }] })}`), "final decision");
  assert.throws(() => parseOpenCodeEventText(JSON.stringify({ type: "message.updated", info: { role: "assistant" }, parts: [
    { id: "p1", type: "text", text: "{}" }, { id: "p2", type: "text", text: "{}" },
  ] })), /multiple assistant text parts/i);
});

test("OpenCode accepts a valid final correction, but rejects conflicting or concatenated decisions", () => {
  const event = (partID: string, text: string) => JSON.stringify({ type: "text", partID, text });
  const valid = JSON.stringify({
    plan: ["Inspect the current page."],
    decisionNote: "Use the visible invoice entry.",
    action: { type: "click", ref: "ref-9" },
  });
  const malformedEarlier = `${valid}\n}`;
  const corrected = parseOpenCodeDecision(`${event("part-old", malformedEarlier)}\n${event("part-final", valid)}`);
  assert.deepEqual(corrected.action, { type: "click", ref: "ref-9" });

  const conflicting = JSON.stringify({
    plan: ["Inspect another control."],
    decisionNote: "Choose a different control.",
    action: { type: "click", ref: "ref-10" },
  });
  assert.throws(() => parseOpenCodeDecision(`${event("part-a", valid)}\n${event("part-b", conflicting)}`), /conflicting schema-valid actions/i);
  assert.throws(() => parseOpenCodeDecision(`${event("part-a", valid)}\n${event("part-b", `${valid}${valid}`)}`), /final text part was not one schema-valid decision/i);
});

test("invalid OpenCode response is captured privately with raw and parsed text", async () => {
  const root = await mkdtemp(join(tmpdir(), "centralign-provider-test-"));
  const diagnosticsDir = join(root, "diagnostics");
  const command = join(root, "fake-opencode");
  const invalidDecision = '{"plan":["observe"],"decisionNote":"read","action":{"type":"observe"}}{"plan":["second"],"decisionNote":"extra","action":{"type":"observe"}}';
  const event = JSON.stringify({ type: "text", part: { id: "p1", type: "text", text: invalidDecision } });
  await writeFile(command, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${event}\n`)});\n`);
  await chmod(command, 0o700);
  const planner = await OpenCodePlanner.create(command, "test-model", 5000, diagnosticsDir);
  try {
    await assert.rejects(planner.decide({
      task: "observe", step: 1, maxSteps: 2, observation: {}, observationHistory: [], plan: [], goal: {}, history: [], memory: [],
    }, new AbortController().signal), /Unexpected non-whitespace.*private diagnostic/);
    const files = await readdir(diagnosticsDir);
    assert.equal(files.length, 1);
    assert.ok(files[0]);
    const diagnosticPath = join(diagnosticsDir, files[0]);
    const diagnostic = JSON.parse(await readFile(diagnosticPath, "utf8")) as { stdout: string; parsedResponse: string; error: string };
    assert.match(diagnostic.stdout, /"type":"text"/);
    assert.ok(diagnostic.parsedResponse.endsWith(invalidDecision));
    assert.match(diagnostic.error, /Unexpected non-whitespace/);
    assert.equal((await stat(diagnosticPath)).mode & 0o777, 0o600);
  } finally {
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
