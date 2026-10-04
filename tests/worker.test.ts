import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/server/app.js";
import { type Planner, type PlannerInput } from "../src/server/provider.js";
import { writeSandboxFile } from "../src/server/safety.js";
import { StateStore } from "../src/server/store.js";
import { type BrowserAction, type ModelDecision, type Run } from "../src/server/types.js";
import { WorkerEngine } from "../src/server/worker.js";

// Deterministic planners are test fixtures only; the demo's default planner is always the real model adapter.
class TestOnlyPlanner implements Planner {
  readonly provider = "test-only";
  readonly model = "deterministic-fixture";

  constructor(private readonly decideAction: (input: PlannerInput) => BrowserAction) {}

  ready(): boolean {
    return true;
  }

  async decide(input: PlannerInput, signal: AbortSignal): Promise<ModelDecision> {
    if (signal.aborted) throw new DOMException("cancelled", "AbortError");
    return {
      plan: ["Test-only: exercise the typed browser boundary"],
      decisionNote: "Deterministic test fixture response.",
      action: this.decideAction(input),
    };
  }
}

const invoiceValues = {
  company: "Northstar Labs",
  invoiceNumber: "NS-1042",
  amount: "1840.50",
  currency: "USD",
  issuedDate: "2026-10-02",
  dueDate: "2026-10-20",
  sourceMessageId: "msg-ns-1042",
};

function companyFixture(mutatePayload: boolean, replaceSave = false): string {
  const values = Object.entries(invoiceValues).map(([name, value]) =>
    `<label>${name}<input name="${name}" value="${value}" /></label>`,
  ).join("\n");
  const replaceButton = replaceSave ? '<button id="replace-save" type="button">Refresh form</button>' : "";
  const replaceScript = replaceSave ? `document.querySelector("#replace-save").addEventListener("click", () => { const old = document.querySelector("[data-write]"); const replacement = old.cloneNode(true); replacement.textContent = "New save control"; old.replaceWith(replacement); });` : "";
  return `<!doctype html><html><head><title>Company test fixture</title></head><body>
    <h1>Company workspace</h1>
    ${replaceButton}
    <form id="invoice-form">${values}<button type="submit" data-write="true">Save invoice</button></form>
    <output id="result"></output>
    <script>
      document.querySelector("form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(event.currentTarget));
        const payload = ${mutatePayload ? "{ ...values, amount: Number(values.amount) + 1 }" : "{ ...values, amount: Number(values.amount) }"};
        const response = await fetch("/api/company/invoices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        document.querySelector("#result").textContent = String(response.status);
      });
      ${replaceScript}
    </script>
  </body></html>`;
}

type Harness = {
  root: string;
  store: StateStore;
  engine: WorkerEngine;
  server: Server;
  baseUrl: string;
  close: () => Promise<void>;
};

async function reservePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function createHarness(planner: Planner, mutatePayload = false, replaceSave = false, hiddenDataDir = false): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "centralign-worker-test-"));
  const publicDir = join(root, "public");
  const dataDir = join(root, hiddenDataDir ? ".data" : "data");
  const artifactsDir = join(dataDir, "artifacts");
  const workspaceRoot = join(dataDir, "workspace");
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, "company.html"), companyFixture(mutatePayload, replaceSave));
  const store = new StateStore(join(dataDir, "state.json"));
  await store.initialize();
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const engine = new WorkerEngine(store, planner, {
    companyUrl: `${baseUrl}/company`,
    artifactsDir,
    workspaceRoot,
    maxSteps: 3,
  });
  const app = createApp({ store, engine, publicDir, artifactsDir, workspaceRoot, providerReady: () => true });
  const server = createServer(app);
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    root,
    store,
    engine,
    server,
    baseUrl,
    close: async () => {
      await engine.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

function saveButtonRef(input: PlannerInput): string {
  const refs = (input.observation as { refs?: Array<{ ref: string; write?: boolean }> }).refs ?? [];
  const button = refs.find((item) => item.write);
  assert.ok(button, "the latest page snapshot should expose the marked Save invoice button");
  return button.ref;
}

async function waitForRun(baseUrl: string, id: string, predicate: (run: Run) => boolean, timeoutMs = 20_000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/runs/${id}`);
    assert.equal(response.status, 200);
    const run = await response.json() as Run;
    if (predicate(run)) return run;
    if (["failed", "completed", "cancelled"].includes(run.status)) throw new Error(`Run ended before expected state (${run.status}): ${run.error ?? run.summary ?? ""}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for run ${id}`);
}

function invoiceCheck(): BrowserAction {
  return {
    type: "finish",
    summary: "Invoice imported.",
    checks: [{ type: "invoice", invoiceNumber: "NS-1042", sourceMessageId: "msg-ns-1042" }],
  };
}

test("save failure retries only the identical approved payload; cancellation reports committed effects", { timeout: 60_000 }, async () => {
  const planner = new TestOnlyPlanner((input) => {
    if (input.step <= 2) return { type: "click", ref: saveButtonRef(input) };
    return { type: "ask_user", question: "Test run is paused after the verified write." };
  });
  const harness = await createHarness(planner);
  try {
    const started = await fetch(`${harness.baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "Import the latest invoice from Northstar Labs", injectFailure: true }),
    });
    assert.equal(started.status, 201);
    const initial = await started.json() as Run;
    const firstApproval = await waitForRun(harness.baseUrl, initial.id, (run) => run.status === "awaiting_approval");
    const firstFingerprint = firstApproval.events.findLast((event) => event.type === "approval")?.data as { fingerprint?: string };
    assert.ok(firstFingerprint?.fingerprint);

    const firstApproved = await fetch(`${harness.baseUrl}/api/runs/${initial.id}/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: true }),
    });
    assert.equal(firstApproved.status, 200);
    const retryApproval = await waitForRun(harness.baseUrl, initial.id, (run) =>
      run.status === "awaiting_approval" && run.events.filter((event) => event.type === "approval" && (event.data as { fingerprint?: string })?.fingerprint).length >= 2,
    );
    const fingerprints = retryApproval.events.filter((event) => event.type === "approval")
      .map((event) => (event.data as { fingerprint?: string })?.fingerprint).filter(Boolean);
    assert.equal(fingerprints[1], firstFingerprint.fingerprint, "retry requires an identical full form fingerprint");
    assert.equal(retryApproval.events.some((event) => event.type === "retry" && event.message.toLowerCase().includes("only the identical")), true);

    const retryApproved = await fetch(`${harness.baseUrl}/api/runs/${initial.id}/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: true }),
    });
    assert.equal(retryApproved.status, 200);
    const waitingForInput = await waitForRun(harness.baseUrl, initial.id, (run) => run.status === "awaiting_input");
    assert.equal(harness.store.getState().company.invoices.length, 1, "the retry saves exactly one record");
    assert.equal(waitingForInput.partialEffects?.length, 1);

    const cancelledResponse = await fetch(`${harness.baseUrl}/api/runs/${initial.id}/cancel`, { method: "POST" });
    const cancelled = await cancelledResponse.json() as Run;
    assert.equal(cancelled.status, "cancelled");
    assert.match(cancelled.summary ?? "", /committed write/);
    assert.match(cancelled.events.at(-1)?.message ?? "", /had already committed/);
    assert.equal(harness.store.getState().company.invoices.length, 1, "cancellation does not roll back a committed invoice");
  } finally {
    await harness.close();
  }
});

test("server rejects changed payloads and a worker cannot approve itself", { timeout: 60_000 }, async () => {
  const planner = new TestOnlyPlanner((input) => input.step === 1
    ? { type: "click", ref: saveButtonRef(input) }
    : invoiceCheck());
  const harness = await createHarness(planner, true);
  try {
    const started = await fetch(`${harness.baseUrl}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "Import the latest invoice from Northstar Labs" }),
    });
    const run = await started.json() as Run;
    await waitForRun(harness.baseUrl, run.id, (current) => current.status === "awaiting_approval");

    const selfApproval = await fetch(`${harness.baseUrl}/api/runs/${run.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-run": run.id },
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(selfApproval.status, 403);
    assert.equal(harness.store.getRun(run.id)?.status, "awaiting_approval");

    const directWrite = await fetch(`${harness.baseUrl}/api/company/invoices`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-run": run.id },
      body: JSON.stringify(invoiceValues),
    });
    assert.equal(directWrite.status, 403, "a missing approval token cannot authorize a browser/API bypass");

    const approved = await fetch(`${harness.baseUrl}/api/runs/${run.id}/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: true }),
    });
    assert.equal(approved.status, 200);
    const ended = await waitForRun(harness.baseUrl, run.id, (current) => ["failed", "completed"].includes(current.status));
    assert.equal(ended.status, "failed", "false finish checks cannot mark an unsaved invoice complete");
    assert.equal(harness.store.getState().company.invoices.length, 0, "server-side payload hash mismatch prevents mutation");
    assert.ok(ended.events.some((event) => event.type === "retry" && event.message.includes("HTTP 403")));
    assert.ok(ended.events.some((event) => event.type === "verification" && event.message.includes("Finish rejected")));
  } finally {
    await harness.close();
  }
});

test("cancelling a pending approval prevents later approval and write dispatch", { timeout: 60_000 }, async () => {
  const planner = new TestOnlyPlanner((input) => ({ type: "click", ref: saveButtonRef(input) }));
  const harness = await createHarness(planner);
  try {
    const started = await fetch(`${harness.baseUrl}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "Import the latest invoice from Northstar Labs" }),
    });
    const run = await started.json() as Run;
    await waitForRun(harness.baseUrl, run.id, (current) => current.status === "awaiting_approval");
    const cancelledResponse = await fetch(`${harness.baseUrl}/api/runs/${run.id}/cancel`, { method: "POST" });
    assert.equal(cancelledResponse.status, 200);
    const lateApproval = await fetch(`${harness.baseUrl}/api/runs/${run.id}/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: true }),
    });
    assert.equal(lateApproval.status, 409);
    const attemptedWrite = await fetch(`${harness.baseUrl}/api/company/invoices`, {
      method: "POST", headers: { "content-type": "application/json", "x-worker-run": run.id, "x-worker-approval": "stale" },
      body: JSON.stringify(invoiceValues),
    });
    assert.equal(attemptedWrite.status, 403);
    assert.equal(harness.store.getState().company.invoices.length, 0);
    assert.equal(harness.store.getRun(run.id)?.status, "cancelled");
  } finally {
    await harness.close();
  }
});

test("a ref from before a DOM replacement cannot rebind to the replacement element", { timeout: 60_000 }, async () => {
  let staleSaveRef = "";
  const planner = new TestOnlyPlanner((input) => {
    const refs = (input.observation as { refs?: Array<{ ref: string; name: string; write?: boolean }> }).refs ?? [];
    if (input.step === 1) {
      staleSaveRef = refs.find((item) => item.write)?.ref ?? "";
      const refresh = refs.find((item) => item.name === "Refresh form");
      assert.ok(refresh);
      return { type: "click", ref: refresh.ref };
    }
    return { type: "click", ref: staleSaveRef };
  });
  const harness = await createHarness(planner, false, true);
  try {
    const started = await fetch(`${harness.baseUrl}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "Import the latest invoice from Northstar Labs" }),
    });
    const run = await started.json() as Run;
    const ended = await waitForRun(harness.baseUrl, run.id, (current) => ["failed", "completed", "cancelled"].includes(current.status));
    assert.equal(ended.status, "failed");
    assert.ok(ended.events.some((event) => event.type === "retry" && event.message.includes("Reference ref-")));
    assert.equal(ended.events.some((event) => event.type === "approval"), false);
    assert.equal(harness.store.getState().company.invoices.length, 0);
  } finally {
    await harness.close();
  }
});

test("malformed model responses get two bounded retries and prior visible pages stay in context", { timeout: 60_000 }, async () => {
  let calls = 0;
  let stepTwoInput: PlannerInput | undefined;
  const planner: Planner = {
    provider: "test-only",
    model: "malformed-retry-fixture",
    ready: () => true,
    async decide(input, signal) {
      if (signal.aborted) throw new DOMException("cancelled", "AbortError");
      calls += 1;
      if (calls <= 2) throw new SyntaxError("Unexpected non-whitespace after JSON");
      if (input.step === 1) return {
        plan: ["Navigate to another company tab."],
        decisionNote: "Open the accounting tab.",
        action: { type: "navigate", url: new URL("/company?tab=accounting", String((input.observation as { url: string }).url)).toString() },
      };
      stepTwoInput = input;
      return {
        plan: ["Ask the user to confirm the next step."],
        decisionNote: "The company source should remain available in the earlier page context.",
        action: { type: "ask_user", question: "Please confirm the test run can stop here." },
      };
    },
  };
  const harness = await createHarness(planner);
  try {
    const started = await fetch(`${harness.baseUrl}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "Inspect the invoice source" }),
    });
    const run = await started.json() as Run;
    const waiting = await waitForRun(harness.baseUrl, run.id, (current) => current.status === "awaiting_input");
    assert.equal(calls, 4, "two invalid model responses are retried, then each browser decision uses the planner once");
    assert.equal(waiting.events.filter((event) => event.type === "retry" && event.message.includes("Model response")).length, 2);
    assert.ok(stepTwoInput);
    assert.equal(stepTwoInput.observationHistory.some((entry) => entry.title.includes("Company test fixture")), true);
    assert.equal(stepTwoInput.observationHistory.some((entry) => "refs" in entry), false, "historical refs are never reusable");
  } finally {
    await harness.close();
  }
});

test("verified sandbox files download through a hidden data ancestor without relaxing traversal checks", { timeout: 60_000 }, async () => {
  const harness = await createHarness(new TestOnlyPlanner(() => ({ type: "observe" })), false, false, true);
  const id = "verified-report-run";
  const report = "Invoice|Company|Amount|Currency|Issued date|Due date\nCS-219|Cedar Studio|275.00|USD|2026-10-01|2026-10-12\n";
  try {
    const now = new Date().toISOString();
    await harness.store.createRun({
      id,
      task: "Create the invoice report",
      status: "completed",
      createdAt: now,
      updatedAt: now,
      plan: [],
      events: [],
      steps: 1,
      provider: "test-only",
      model: "fixture",
    });
    await writeSandboxFile(harness.engine.getWorkspacePath(id), "invoice-report.md", report);

    const served = await fetch(`${harness.baseUrl}/api/runs/${id}/file?path=invoice-report.md`);
    assert.equal(served.status, 200);
    assert.equal(await served.text(), report);
    assert.match(served.headers.get("content-type") ?? "", /text\/plain/i);
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");

    const traversal = await fetch(`${harness.baseUrl}/api/runs/${id}/file?path=${encodeURIComponent("../outside.txt")}`);
    assert.equal(traversal.status, 400);
  } finally {
    await harness.close();
  }
});
