import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { type GoalContract, deriveGoalContract, plannerGoal } from "./goals.js";
import { type Planner } from "./provider.js";
import { comparableJson, isAllowedCompanyUrl, writeSandboxFile } from "./safety.js";
import { type StateStore } from "./store.js";
import { browserActionSchema, type BrowserAction, type ModelDecision, type Run, type RunEvent } from "./types.js";
import { verifyFinish } from "./verify.js";

type WriteDescriptor = {
  method: string;
  path: string;
  body: Record<string, unknown>;
  hash: string;
  description: string;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type Gate = {
  kind: "approval" | "input";
  handled: boolean;
  resolve: (value: boolean | string) => void;
  reject: (reason?: unknown) => void;
  promise: Promise<boolean | string>;
};

type ActionOutcome =
  | { kind: "continue"; message: string }
  | { kind: "input"; message: string; answer: string }
  | { kind: "finish"; message: string; summary: string };

type Runtime = {
  controller: AbortController;
  goal: GoalContract;
  history: Array<{ action: unknown; result: string }>;
  observationHistory: Array<{ url: string; title: string; text: string }>;
  clarifications: string[];
  browser?: Browser;
  page?: Page;
  gate?: Gate;
  approvedWrite?: { descriptor: WriteDescriptor; token: string };
  lastDispatched?: WriteDescriptor;
  requiredRetryHash?: string;
  pendingWrite?: WriteDescriptor;
  actionFailures: Map<string, number>;
  refSequence: number;
  workspacePath: string;
};

export type WorkerEngineOptions = {
  companyUrl: string;
  artifactsDir: string;
  workspaceRoot: string;
  maxSteps: number;
  onRunChanged?: (run: Run) => void;
};

export class WorkerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "WorkerError";
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function abortError(): DOMException {
  return new DOMException("Run cancelled", "AbortError");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isTerminal(status: Run["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isCompanyApiPath(path: string): boolean {
  return path === "/api/company/state" || path === "/api/company/invoices" || /^\/api\/company\/contacts\/[^/]+$/.test(path);
}

async function describeWrite(page: Page, ref: string): Promise<WriteDescriptor | undefined> {
  const extracted = await page.evaluate((targetRef) => {
    const target = document.querySelector<HTMLElement>(`[data-worker-ref="${targetRef}"]`);
    if (!target) throw new Error(`Reference ${targetRef} is not available`);
    const root = target.closest<HTMLElement>("[data-write]");
    if (!root) return undefined;
    const form = (root instanceof HTMLFormElement ? root : root.closest("form")) as HTMLFormElement | null;
    const body: Record<string, unknown> = {};
    if (form) {
      for (const field of Array.from(form.elements)) {
        if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) continue;
        if (!field.name || field.disabled || ["button", "submit", "reset", "file"].includes((field as HTMLInputElement).type)) continue;
        if (field instanceof HTMLInputElement && ["checkbox", "radio"].includes(field.type) && !field.checked) continue;
        const value: unknown = field instanceof HTMLSelectElement && field.multiple
          ? Array.from(field.selectedOptions).map((option) => option.value)
          : field.value;
        if (Object.hasOwn(body, field.name)) {
          const existing = body[field.name];
          body[field.name] = Array.isArray(existing) ? [...existing, value] : [existing, value];
        } else body[field.name] = value;
      }
    }
    const pathValue = root.dataset.apiPath || form?.dataset.apiPath || form?.getAttribute("action") || "";
    const inferredInvoice = Object.hasOwn(body, "invoiceNumber") && Object.hasOwn(body, "company");
    const inferredContact = Boolean(root.dataset.contactId || form?.dataset.contactId || body.contactId);
    const path = pathValue || (inferredInvoice
      ? "/api/company/invoices"
      : inferredContact
        ? `/api/company/contacts/${encodeURIComponent(String(root.dataset.contactId || form?.dataset.contactId || body.contactId))}`
        : "");
    const resolved = path ? new URL(path, location.href) : undefined;
    const methodValue = root.dataset.apiMethod || form?.dataset.apiMethod || form?.method || (inferredInvoice ? "post" : "patch");
    const method = methodValue.toUpperCase() === "GET" ? (inferredInvoice ? "POST" : "PATCH") : methodValue.toUpperCase();
    return {
      marked: true,
      method,
      path: resolved?.pathname ?? "",
      body,
      marker: root.dataset.write ?? "",
      label: root.getAttribute("aria-label") || root.innerText?.trim().slice(0, 120) || target.innerText?.trim().slice(0, 120) || "Company write",
    };
  }, ref);

  if (!extracted) return undefined;
  if (!extracted.path || !isCompanyApiPath(extracted.path)) throw new Error("Marked write target has no safe company API route");
  if (extracted.path === "/api/company/invoices" && extracted.method !== "POST") throw new Error("Invoice writes must use POST");
  if (extracted.path.startsWith("/api/company/contacts/") && extracted.method !== "PATCH") throw new Error("Contact writes must use PATCH");
  if (!Object.keys(extracted.body).length) throw new Error("Write form has no named fields");
  const material = { method: extracted.method, path: extracted.path, body: extracted.body };
  const hash = createHash("sha256").update(comparableJson(material)).digest("hex");
  return {
    ...material,
    hash,
    description: `${extracted.method} ${extracted.path}\nForm: ${JSON.stringify(extracted.body, null, 2)}\nApproval fingerprint: ${hash}`,
  };
}

function responseIsMutation(response: import("playwright").Response, descriptor: WriteDescriptor): boolean {
  try {
    const url = new URL(response.url());
    return response.request().method().toUpperCase() === descriptor.method && url.pathname === descriptor.path;
  } catch {
    return false;
  }
}

export class WorkerEngine {
  private readonly runtimes = new Map<string, Runtime>();

  constructor(
    private readonly store: StateStore,
    private readonly planner: Planner,
    private readonly options: WorkerEngineOptions,
  ) {
    if (!isAllowedCompanyUrl(options.companyUrl, options.companyUrl)) {
      throw new Error("WORKER_COMPANY_URL must be a localhost /company URL");
    }
  }

  async start(task: string, injectFailure = false): Promise<Run> {
    const state = this.store.getState();
    const active = state.activeRunId ? state.runs[state.activeRunId] : undefined;
    if (active && !isTerminal(active.status)) throw new WorkerError(409, `Run ${active.id} is still ${active.status}`);

    const now = new Date().toISOString();
    const id = randomUUID();
    const run: Run = {
      id,
      task,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      plan: [],
      events: [],
      steps: 0,
      provider: this.planner.provider,
      model: this.planner.model,
    };
    const runtime: Runtime = {
      controller: new AbortController(),
      goal: deriveGoalContract(task, state.company),
      history: [],
      observationHistory: [],
      clarifications: [],
      actionFailures: new Map(),
      refSequence: 0,
      workspacePath: join(this.options.workspaceRoot, id),
    };
    this.runtimes.set(id, runtime);
    const created = await this.store.createRun(run, injectFailure);
    this.notify(created);
    void this.execute(id).catch(() => undefined);
    return created;
  }

  async approve(id: string, approved: boolean): Promise<Run> {
    const run = this.requireRun(id);
    const runtime = this.requireRuntime(id);
    const gate = runtime.gate;
    if (run.status !== "awaiting_approval" || !gate || gate.kind !== "approval" || gate.handled) {
      throw new WorkerError(409, "There is no pending approval for this run");
    }
    gate.handled = true;
    if (approved && (!runtime.pendingWrite || runtime.controller.signal.aborted)) {
      throw new WorkerError(409, "The approved write is no longer active");
    }
    const updated = await this.store.updateRun(id, (current) => {
      if (current.status !== "awaiting_approval" || runtime.controller.signal.aborted) throw new WorkerError(409, "The run is no longer awaiting approval");
      current.status = "running";
      delete current.approval;
      current.events.push(this.event(approved ? "approval" : "approval", approved ? "User approved the exact pending form payload." : "User rejected the pending write.", {
        approved,
        ...(runtime.pendingWrite ? { fingerprint: runtime.pendingWrite.hash } : {}),
      }));
    });
    this.notify(updated);
    if (approved && !runtime.controller.signal.aborted && runtime.pendingWrite) {
        runtime.approvedWrite = { descriptor: runtime.pendingWrite, token: randomUUID() };
        delete runtime.pendingWrite;
      gate.resolve(true);
    }
    else {
      delete runtime.approvedWrite;
      delete runtime.pendingWrite;
      gate.resolve(false);
    }
    return updated;
  }

  async answer(id: string, answer: string): Promise<Run> {
    const run = this.requireRun(id);
    const runtime = this.requireRuntime(id);
    const gate = runtime.gate;
    if (run.status !== "awaiting_input" || !gate || gate.kind !== "input" || gate.handled) {
      throw new WorkerError(409, "There is no pending question for this run");
    }
    gate.handled = true;
    const updated = await this.store.updateRun(id, (current) => {
      if (current.status !== "awaiting_input" || runtime.controller.signal.aborted) throw new WorkerError(409, "The run is no longer awaiting input");
      current.status = "running";
      delete current.question;
      current.events.push(this.event("observation", `User clarified: ${answer}`, { answer }));
    });
    this.notify(updated);
    if (!runtime.controller.signal.aborted) gate.resolve(answer);
    return updated;
  }

  async cancel(id: string): Promise<Run> {
    const run = this.requireRun(id);
    if (isTerminal(run.status)) return run;
    const runtime = this.requireRuntime(id);
    runtime.controller.abort();
    delete runtime.approvedWrite;
    delete runtime.pendingWrite;
    void runtime.browser?.close().catch(() => undefined);
    const updated = await this.store.updateRun(id, (current) => {
      if (isTerminal(current.status)) return;
      current.status = "cancelled";
      delete current.approval;
      delete current.question;
      const effects = current.partialEffects ?? [];
      if (effects.length) current.summary = `Cancelled after ${effects.length} committed write(s); these changes were not rolled back.`;
      current.events.push(this.event("error", effects.length
        ? `Run cancelled. ${effects.length} write(s) had already committed and remain in the company records.`
        : "Run cancelled before any write was committed."));
    });
    this.notify(updated);
    return updated;
  }

  async authorizeMutation(input: { runId?: string; token?: string; method: string; path: string; body: unknown }): Promise<boolean> {
    if (!input.runId) return true;
    const runtime = this.runtimes.get(input.runId);
    const run = this.store.getRun(input.runId);
    if (!runtime || !run || run.status !== "running" || runtime.controller.signal.aborted || !input.token) return false;
    const pending = runtime.approvedWrite;
    if (!pending || pending.token !== input.token) return false;
    const method = input.method.toUpperCase();
    const actualHash = createHash("sha256").update(comparableJson({ method, path: input.path, body: input.body ?? {} })).digest("hex");
    if (method !== pending.descriptor.method || input.path !== pending.descriptor.path || actualHash !== pending.descriptor.hash) return false;
    const goalAllows = this.writeMatchesGoal(runtime.goal, pending.descriptor);
    if (!goalAllows) return false;
    runtime.lastDispatched = pending.descriptor;
    delete runtime.approvedWrite;
    return true;
  }

  async markWriteFailed(id: string, status: number): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime?.lastDispatched || status !== 503) return;
    runtime.requiredRetryHash = runtime.lastDispatched.hash;
    delete runtime.lastDispatched;
    const run = this.store.getRun(id);
    if (run && run.status === "running") {
      const updated = await this.store.appendEvent(id, {
        type: "retry",
        message: "The company service failed before saving. Only the identical approved form payload may be retried.",
        data: { status, fingerprint: runtime.requiredRetryHash },
      });
      this.notify(updated);
    }
  }

  async markWriteCommitted(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    delete runtime.requiredRetryHash;
    delete runtime.lastDispatched;
    const run = this.store.getRun(id);
    if (run) this.notify(run);
  }

  latestScreenshot(id: string): string | undefined {
    return this.store.getRun(id)?.screenshotUrl;
  }

  workerContextActive(id: string): boolean {
    const runtime = this.runtimes.get(id);
    const run = this.store.getRun(id);
    return Boolean(runtime && run && !runtime.controller.signal.aborted && !isTerminal(run.status));
  }

  getWorkspacePath(id: string): string {
    return join(this.options.workspaceRoot, id);
  }

  async close(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      runtime.controller.abort();
      await runtime.browser?.close().catch(() => undefined);
    }
    await this.planner.close?.();
  }

  private requireRun(id: string): Run {
    const run = this.store.getRun(id);
    if (!run) throw new WorkerError(404, "Run not found");
    return run;
  }

  private requireRuntime(id: string): Runtime {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new WorkerError(409, "This run is no longer active in this server process");
    return runtime;
  }

  private notify(run: Run): void {
    this.options.onRunChanged?.(run);
  }

  private event(type: RunEvent["type"], message: string, data?: unknown): RunEvent {
    return { id: randomUUID(), time: new Date().toISOString(), type, message, ...(data === undefined ? {} : { data }) };
  }

  private async emit(id: string, type: RunEvent["type"], message: string, data?: unknown): Promise<void> {
    const updated = await this.store.appendEvent(id, { type, message, ...(data === undefined ? {} : { data }) });
    this.notify(updated);
  }

  private async execute(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    let page: Page | undefined;
    try {
      const started = await this.store.updateRun(id, (run) => {
        if (run.status !== "queued") throw abortError();
        run.status = "running";
      });
      this.notify(started);
      this.assertActive(id, runtime);
      await mkdir(this.options.artifactsDir, { recursive: true });
      await mkdir(runtime.workspacePath, { recursive: true });
      const browser = await chromium.launch({ headless: true });
      runtime.browser = browser;
      const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, acceptDownloads: false });
      await context.route("**/*", async (route) => {
        const request = route.request();
        const destination = new URL(request.url());
        const base = new URL(this.options.companyUrl);
        const method = request.method().toUpperCase();
        const path = destination.pathname;
        const isCompanyDocument = destination.origin === base.origin && (path === "/company" || path.startsWith("/company/"));
        const isCompanyApi = destination.origin === base.origin && isCompanyApiPath(path) &&
          ((method === "GET" && path === "/api/company/state") ||
            (method === "POST" && path === "/api/company/invoices") ||
            (method === "PATCH" && /^\/api\/company\/contacts\/[^/]+$/.test(path)));
        const isStaticCompanyAsset = destination.origin === base.origin && path !== "/" && !path.startsWith("/api/") &&
          ["script", "stylesheet", "image", "font"].includes(request.resourceType());
        if (runtime.controller.signal.aborted || (!isCompanyDocument && !isCompanyApi && !isStaticCompanyAsset)) {
          await route.abort("blockedbyclient").catch(() => undefined);
          return;
        }
        const headers = { ...request.headers() };
        for (const name of Object.keys(headers)) if (["x-worker-run", "x-worker-approval"].includes(name.toLowerCase())) delete headers[name];
        if (destination.origin === base.origin && path.startsWith("/api/company/")) {
          headers["x-worker-run"] = id;
          if (runtime.approvedWrite) headers["x-worker-approval"] = runtime.approvedWrite.token;
        }
        await route.continue({ headers });
      });
      page = await context.newPage();
      runtime.page = page;
      page.on("popup", (popup) => { void popup.close().catch(() => undefined); });
      page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => undefined); });
      await page.goto(this.options.companyUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
      this.assertActive(id, runtime);
      let observation: unknown = await this.captureObservation(id, runtime, page, 0);

      for (let step = 1; step <= this.options.maxSteps; step += 1) {
        this.assertActive(id, runtime);
        const run = this.requireRun(id);
        const effectiveTask = runtime.clarifications.length
          ? `${run.task}\n\nUSER CLARIFICATIONS:\n${runtime.clarifications.join("\n")}`
          : run.task;
        let decision: ModelDecision | undefined;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          this.assertActive(id, runtime);
          try {
            decision = await this.planner.decide({
              task: effectiveTask,
              step,
              maxSteps: this.options.maxSteps,
              observation,
              observationHistory: runtime.observationHistory.slice(-5, -1),
              plan: run.plan,
              goal: plannerGoal(runtime.goal),
              history: runtime.history,
              memory: this.store.getState().memory.slice(-30).map((entry) => entry.fact),
            }, runtime.controller.signal);
            break;
          } catch (error) {
            if (runtime.controller.signal.aborted || asError(error).name === "AbortError") throw error;
            const detail = asError(error).message.replace(/\s+/g, " ").slice(0, 500);
            if (attempt >= 3) throw new Error(`Model failed to return one valid decision after 2 retries: ${detail}`);
            this.assertActive(id, runtime);
            await this.emit(id, "retry", `Model response ${attempt} was invalid or unavailable; retrying with the same page observation. ${detail}`, { attempt, maxRetries: 2 });
            runtime.history.push({
              action: { type: "model_response_rejected" },
              result: `The prior model response was rejected or unavailable (${detail}). Return exactly one complete JSON decision object with one schema-valid action; do not concatenate responses.`,
            });
          }
        }
        if (!decision) throw new Error("Model did not return a valid decision");
        this.assertActive(id, runtime); // A late CLI response may not revive a cancelled run.
        const validated = browserActionSchema.parse(decision.action);
        const decisionPlan = decision.plan;
        const current = this.requireRun(id);
        const planChanged = JSON.stringify(current.plan) !== JSON.stringify(decisionPlan);
        const updated = await this.store.updateRun(id, (target) => {
          if (target.status !== "running") throw abortError();
          target.steps = step;
          target.plan = decisionPlan;
          if (planChanged) target.events.push(this.event("plan", "Worker plan updated.", { plan: decisionPlan }));
          target.events.push(this.event("thought", decision.decisionNote));
        });
        this.notify(updated);
        runtime.history.push({ action: validated, result: `Decision note: ${decision.decisionNote}` });

        let outcome: ActionOutcome;
        try {
          outcome = await this.performAction(id, runtime, page, validated, step);
          observation = await this.captureObservation(id, runtime, page, step);
          runtime.actionFailures.delete(this.actionKey(validated));
        } catch (error) {
          if (runtime.controller.signal.aborted || asError(error).name === "AbortError") throw error;
          const key = this.actionKey(validated);
          const attempts = (runtime.actionFailures.get(key) ?? 0) + 1;
          runtime.actionFailures.set(key, attempts);
          await this.emit(id, "retry", `${asError(error).message}${attempts < 3 ? " Re-observing and replanning." : " Retry limit reached for this action."}`, { action: validated, attempts });
          observation = await this.captureObservation(id, runtime, page, step);
          runtime.history.push({ action: validated, result: `Action failed on attempt ${attempts}: ${asError(error).message}` });
          if (attempts >= 3) throw error;
          continue;
        }
        runtime.history.push({ action: validated, result: outcome.message });

        if (outcome.kind === "input") {
          const answer = outcome.answer;
          runtime.clarifications.push(answer);
          runtime.goal = deriveGoalContract(`${this.requireRun(id).task}\n${runtime.clarifications.join("\n")}`, this.store.getState().company);
          continue;
        }
        if (outcome.kind === "finish") {
          const verification = await verifyFinish({
            store: this.store,
            runId: id,
            decision,
            goal: runtime.goal,
            workspaceRoot: this.options.workspaceRoot,
          });
          if (!verification.ok) {
            const message = `Finish rejected: ${verification.errors.join(" ")}`;
            await this.emit(id, "verification", message, { errors: verification.errors });
            runtime.history.push({ action: validated, result: message });
            continue;
          }
          this.assertActive(id, runtime);
          const done = await this.store.updateRun(id, (target) => {
            if (target.status !== "running") throw abortError();
            target.status = "completed";
            target.summary = verification.summary ?? "The requested invoice outcome was independently verified.";
            target.evidence = verification.evidence;
            target.events.push(this.event("verification", "Persisted records and source-backed evidence verified."));
            target.events.push(this.event("complete", target.summary, { evidence: verification.evidence }));
          });
          this.notify(done);
          return;
        }
      }
      const run = this.store.getRun(id);
      if (run?.status === "running") {
        const failed = await this.store.updateRun(id, (target) => {
          if (target.status !== "running") return;
          target.status = "failed";
          target.error = `Worker reached the ${this.options.maxSteps}-step limit without verified completion.`;
          target.events.push(this.event("error", target.error));
        });
        this.notify(failed);
      }
    } catch (error) {
      const run = this.store.getRun(id);
      if (runtime.controller.signal.aborted || run?.status === "cancelled" || asError(error).name === "AbortError") {
        if (run && run.status !== "cancelled" && !isTerminal(run.status)) {
          const cancelled = await this.store.updateRun(id, (target) => {
            if (!isTerminal(target.status)) {
              target.status = "cancelled";
              target.events.push(this.event("error", "Run cancelled."));
            }
          });
          this.notify(cancelled);
        }
      } else if (run && !isTerminal(run.status)) {
        const message = asError(error).message;
        const failed = await this.store.updateRun(id, (target) => {
          if (isTerminal(target.status)) return;
          target.status = "failed";
          target.error = message;
          delete target.approval;
          delete target.question;
          target.events.push(this.event("error", message));
        });
        this.notify(failed);
      }
    } finally {
      await runtime.browser?.close().catch(() => undefined);
      delete runtime.browser;
      delete runtime.page;
    }
  }

  private async performAction(
    id: string,
    runtime: Runtime,
    page: Page,
    action: BrowserAction,
    step: number,
  ): Promise<ActionOutcome> {
    this.assertActive(id, runtime);
    if (action.type === "observe") {
      await this.emit(id, "action", "Observed the current company page.");
      return { kind: "continue", message: "Observed the company page." };
    }
    if (action.type === "navigate") {
      if (!isAllowedCompanyUrl(action.url, this.options.companyUrl)) throw new Error("Navigation blocked: workers may navigate only within /company on the configured localhost origin.");
      await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await this.emit(id, "action", `Navigated to ${new URL(action.url).pathname}.`);
      return { kind: "continue", message: `Navigated to ${new URL(action.url).pathname}.` };
    }
    if (action.type === "fill") {
      for (const field of action.fields) {
        this.assertActive(id, runtime);
        const locator = page.locator(`[data-worker-ref="${field.ref}"]`);
        if (await locator.count() !== 1) throw new Error(`Reference ${field.ref} is missing or ambiguous; re-observe the page.`);
        await locator.fill(field.value, { timeout: 8000 });
      }
      await this.emit(id, "action", `Filled ${action.fields.length} visible field(s).`, { refs: action.fields.map((field) => field.ref) });
      return { kind: "continue", message: `Filled ${action.fields.length} field(s).` };
    }
    if (action.type === "click") {
      const locator = page.locator(`[data-worker-ref="${action.ref}"]`);
      if (await locator.count() !== 1) throw new Error(`Reference ${action.ref} is missing or ambiguous; re-observe the page.`);
      const href = await locator.evaluate((element) => element instanceof HTMLAnchorElement ? element.href : undefined);
      if (href && !isAllowedCompanyUrl(href, this.options.companyUrl)) throw new Error("Click blocked: links outside the company mainframe are not allowed.");
      const descriptor = await describeWrite(page, action.ref);
      if (descriptor) {
        const permission = this.writeMatchesGoal(runtime.goal, descriptor);
        if (!permission) throw new Error("Write blocked: this form does not match the original task goal or its source-backed values.");
        if (runtime.requiredRetryHash && descriptor.hash !== runtime.requiredRetryHash) {
          throw new Error("Retry blocked: after a save failure, only the exact same full form payload may be retried.");
        }
        const alreadyApproved = runtime.approvedWrite?.descriptor.hash === descriptor.hash;
        if (!alreadyApproved) {
          delete runtime.approvedWrite;
          runtime.pendingWrite = descriptor;
          const gate = this.createGate(runtime, "approval");
          const details = `${descriptor.description}\n\nOnly this exact method, route, and complete payload can be submitted once.`;
          const pending = await this.store.updateRun(id, (run) => {
            if (run.status !== "running" || runtime.controller.signal.aborted) throw abortError();
            run.status = "awaiting_approval";
            run.approval = { question: "Approve this exact company write?", details };
            run.events.push(this.event("approval", "Worker paused before a marked company write.", {
              method: descriptor.method,
              path: descriptor.path,
              body: descriptor.body,
              fingerprint: descriptor.hash,
            }));
          });
          this.notify(pending);
          await this.captureObservation(id, runtime, page, step);
          const approved = await gate.promise;
          delete runtime.gate;
          if (approved !== true) return { kind: "continue", message: "User rejected the exact write payload; no mutation was submitted." };
          this.assertActive(id, runtime);
          const currentDescriptor = await describeWrite(page, action.ref);
          if (!currentDescriptor || currentDescriptor.hash !== descriptor.hash || this.runtimes.get(id)?.approvedWrite?.descriptor.hash !== descriptor.hash) {
            delete runtime.approvedWrite;
            throw new Error("Approved form changed before dispatch; the write was not submitted and needs a new approval.");
          }
        }
        this.assertActive(id, runtime); // Cancellation wins before browser dispatch.
        if (!runtime.approvedWrite || runtime.approvedWrite.descriptor.hash !== descriptor.hash) throw new Error("Approval expired before dispatch.");
        runtime.lastDispatched = descriptor;
        const responsePromise = page.waitForResponse((response) => responseIsMutation(response, descriptor), { timeout: 8000 }).catch(() => undefined);
        try {
          await locator.click({ timeout: 8000 });
          const response = await responsePromise;
          if (response && response.status() >= 400) {
            const detail = (await response.text().catch(() => "")).slice(0, 400);
            if (response.status() === 503) await this.markWriteFailed(id, 503);
            throw new Error(`Company write returned HTTP ${response.status()}${detail ? `: ${detail}` : ""}`);
          }
          if (!response) throw new Error("Approved write did not dispatch to the expected company API route.");
          await this.markWriteCommitted(id);
          await this.emit(id, "action", `Submitted approved ${descriptor.method} ${descriptor.path} payload.`, { fingerprint: descriptor.hash });
          return { kind: "continue", message: `Submitted the approved ${descriptor.path} form and received HTTP ${response.status()}.` };
        } finally {
          delete runtime.approvedWrite;
        }
      }
      await locator.click({ timeout: 8000 });
      await this.emit(id, "action", `Clicked ${action.ref}.`, { ref: action.ref });
      return { kind: "continue", message: `Clicked ${action.ref}.` };
    }
    if (action.type === "remember") {
      const fact = action.fact.trim();
      const updated = await this.store.mutate((state) => {
        if (!state.memory.some((entry) => entry.fact === fact)) {
          state.memory.push({ id: randomUUID(), fact, runId: id, createdAt: new Date().toISOString() });
        }
        const run = state.runs[id];
        if (!run || run.status !== "running") throw abortError();
        run.events.push(this.event("memory", fact));
        run.updatedAt = new Date().toISOString();
        return run;
      });
      this.notify(updated);
      return { kind: "continue", message: `Remembered: ${fact}` };
    }
    if (action.type === "ask_user") {
      const gate = this.createGate(runtime, "input");
      const pending = await this.store.updateRun(id, (run) => {
        if (run.status !== "running" || runtime.controller.signal.aborted) throw abortError();
        run.status = "awaiting_input";
        run.question = action.question;
        run.events.push(this.event("observation", action.question));
      });
      this.notify(pending);
      await this.captureObservation(id, runtime, page, step);
      const answer = await gate.promise;
      delete runtime.gate;
      this.assertActive(id, runtime);
      await this.emit(id, "observation", "Received user clarification; continuing with the original task.", { answer });
      return { kind: "input", message: `User clarified: ${answer}`, answer: String(answer) };
    }
    if (action.type === "write_file") {
      const path = await writeSandboxFile(runtime.workspacePath, action.path, action.content);
      await this.emit(id, "action", `Wrote sandboxed file ${action.path}.`, { path: action.path });
      return { kind: "continue", message: `Wrote ${path}.` };
    }
    if (action.type === "finish") {
      await this.emit(id, "action", `Proposed completion: ${action.summary}`, { checks: action.checks });
      return { kind: "finish", message: action.summary, summary: action.summary };
    }
    const exhaustive: never = action;
    throw new Error(`Unsupported worker action: ${String(exhaustive)}`);
  }

  private createGate(runtime: Runtime, kind: Gate["kind"]): Gate {
    const wait = deferred<boolean | string>();
    const gate: Gate = { kind, handled: false, promise: wait.promise, resolve: wait.resolve, reject: wait.reject };
    runtime.gate = gate;
    const abort = () => gate.reject(abortError());
    if (runtime.controller.signal.aborted) abort();
    else runtime.controller.signal.addEventListener("abort", abort, { once: true });
    void gate.promise.finally(() => runtime.controller.signal.removeEventListener("abort", abort)).catch(() => undefined);
    return gate;
  }

  private async captureObservation(id: string, runtime: Runtime, page: Page, step: number): Promise<unknown> {
    const companyContent = page.locator("#company-content");
    if (await companyContent.count() && await companyContent.getAttribute("aria-busy") === "true") {
      await page.locator('#company-content[aria-busy="false"]').waitFor({ state: "attached", timeout: 10_000 }).catch(() => undefined);
    }
    const activeRun = this.requireRun(id);
    if (runtime.controller.signal.aborted || isTerminal(activeRun.status)) throw abortError();
    const snapshot = await page.evaluate((startingSequence) => {
      const refKey = Symbol.for("centralign.worker.element-refs");
      const refWindow = window as unknown as Record<PropertyKey, unknown>;
      let refMap = refWindow[refKey] as WeakMap<Element, string> | undefined;
      if (!refMap) {
        refMap = new WeakMap<Element, string>();
        Object.defineProperty(window, refKey, { value: refMap, configurable: false });
      }
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(
        'button,a[href],input:not([type="hidden"]),select,textarea,[role="button"],[role="link"]',
      ));
      const refs: Array<Record<string, unknown>> = [];
      let sequence = startingSequence;
      for (const element of candidates) {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || element.getClientRects().length === 0) continue;
        let ref = refMap.get(element);
        if (!ref) {
          ref = `ref-${++sequence}`;
          refMap.set(element, ref);
        }
        element.dataset.workerRef = ref;
        const labels = element instanceof HTMLInputElement ? Array.from(element.labels ?? []).map((label) => label.innerText).join(" ") : "";
        const name = element.getAttribute("aria-label") || labels || element.innerText?.trim() ||
          element.getAttribute("placeholder") || element.getAttribute("name") || element.getAttribute("title") || "";
        refs.push({
          ref,
          role: element.getAttribute("role") || element.tagName.toLowerCase(),
          name: name.slice(0, 160),
          ...(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
            ? { value: element.value.slice(0, 300) }
            : {}),
          ...(element instanceof HTMLAnchorElement ? { href: element.href } : {}),
          ...(element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? { disabled: element.disabled } : {}),
          ...(element.closest("[data-write]") ? { write: true } : {}),
        });
      }
      return {
        url: location.href,
        title: document.title,
        text: (document.body?.innerText ?? "").slice(0, 16_000),
        refs: refs.slice(0, 160),
        nextRefSequence: sequence,
      };
    }, runtime.refSequence);
    runtime.refSequence = snapshot.nextRefSequence;
    const { nextRefSequence: _nextRefSequence, ...publicSnapshot } = snapshot;
    const screenshotDir = join(this.options.artifactsDir, id);
    await mkdir(screenshotDir, { recursive: true });
    const file = `step-${String(step).padStart(3, "0")}-${randomUUID().slice(0, 8)}.png`;
    const path = join(screenshotDir, file);
    await page.screenshot({ path, fullPage: false, timeout: 10_000 });
    const screenshotUrl = `/artifacts/${id}/${file}`;
    const updated = await this.store.updateRun(id, (run) => {
      if (run.status === "cancelled") throw abortError();
      run.screenshotUrl = screenshotUrl;
      run.events.push(this.event("observation", `Observed ${publicSnapshot.title || "company page"}.`, { ...publicSnapshot, screenshotUrl }));
    });
    this.notify(updated);
    runtime.observationHistory.push({
      url: String(publicSnapshot.url),
      title: String(publicSnapshot.title),
      text: String(publicSnapshot.text).slice(-5_000),
    });
    if (runtime.observationHistory.length > 6) runtime.observationHistory.splice(0, runtime.observationHistory.length - 6);
    return { ...publicSnapshot, screenshotUrl };
  }

  private writeMatchesGoal(goal: GoalContract, descriptor: WriteDescriptor): boolean {
    if (descriptor.path === "/api/company/invoices") {
      if (goal.kind !== "invoice_import" || goal.needsClarification || !goal.invoiceNumber || !goal.sourceMessageId) return false;
      const source = this.store.getState().company.messages.find((message) => message.id === goal.sourceMessageId)?.invoice;
      if (!source) return false;
      const body = descriptor.body;
      const amount = Number(body.amount);
      return body.invoiceNumber === source.invoiceNumber && body.company === source.company && Number.isFinite(amount) && amount === source.amount &&
        String(body.currency).toUpperCase() === source.currency && body.dueDate === source.dueDate && body.sourceMessageId === goal.sourceMessageId &&
        (!body.issuedDate || body.issuedDate === source.issuedDate);
    }
    if (descriptor.path.startsWith("/api/company/contacts/")) return false;
    return false;
  }

  private assertActive(id: string, runtime: Runtime): void {
    if (runtime.controller.signal.aborted) throw abortError();
    const run = this.store.getRun(id);
    if (!run || run.status !== "running") throw abortError();
  }

  private actionKey(action: BrowserAction): string {
    if (action.type === "click") return `click:${action.ref}`;
    if (action.type === "fill") return `fill:${action.fields.map((field) => field.ref).join(",")}`;
    if (action.type === "navigate") return `navigate:${action.url}`;
    if (action.type === "write_file") return `write_file:${action.path}`;
    return action.type;
  }
}
