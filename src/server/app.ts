import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import { z } from "zod";
import { CompanyError, createInvoice, updateContact } from "./company.js";
import { type StateStore } from "./store.js";
import { contactPatchSchema, invoiceInputSchema, type Run } from "./types.js";
import { WorkerEngine, WorkerError } from "./worker.js";
import { sandboxFilePath } from "./safety.js";

const newRunSchema = z.object({ task: z.string().trim().min(1).max(2000), injectFailure: z.boolean().optional() }).strict();
const approvalSchema = z.object({ approved: z.boolean() }).strict();
const answerSchema = z.object({ answer: z.string().trim().min(1).max(2000) }).strict();

export type AppOptions = {
  store: StateStore;
  engine: WorkerEngine;
  publicDir: string;
  artifactsDir: string;
  workspaceRoot: string;
  providerReady: () => boolean;
};

function jsonError(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

function validationMessage(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
}

function isTerminal(run: Run): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "cancelled";
}

export function createApp(options: AppOptions): express.Express {
  const app = express();
  const publicDir = resolve(options.publicDir);
  const companyFile = resolve(publicDir, "company.html");
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));

  app.use((req, res, next) => {
    const workerRun = req.get("x-worker-run");
    if (!workerRun) return next();
    if (!options.engine.workerContextActive(workerRun)) return jsonError(res, 403, "Worker context is inactive or cancelled");
    const path = req.path;
    const allowedRead = req.method === "GET" && path === "/api/company/state";
    const allowedInvoiceWrite = req.method === "POST" && path === "/api/company/invoices";
    const allowedContactWrite = req.method === "PATCH" && /^\/api\/company\/contacts\/[^/]+$/.test(path);
    if (!allowedRead && !allowedInvoiceWrite && !allowedContactWrite) {
      return jsonError(res, 403, "Worker requests are restricted to company data; run controls and dashboard APIs are unavailable");
    }
    next();
  });

  app.get("/api/health", (_req, res) => {
    const state = options.store.getState();
    res.json({
      ok: true,
      provider: process.env.WORKER_PROVIDER ?? "opencode",
      model: process.env.WORKER_MODEL ?? "openai/gpt-6-luna#low",
      modelReady: options.providerReady(),
      ...(state.activeRunId ? { activeRunId: state.activeRunId } : {}),
    });
  });

  app.get("/api/runs", (_req, res) => res.json(options.store.listRuns()));
  app.post("/api/runs", async (req, res, next) => {
    const parsed = newRunSchema.safeParse(req.body);
    if (!parsed.success) return jsonError(res, 400, validationMessage(parsed.error));
    try {
      const run = await options.engine.start(parsed.data.task, parsed.data.injectFailure ?? false);
      res.status(201).json(run);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/runs/:id", (req, res) => {
    const run = options.store.getRun(req.params.id);
    if (!run) return jsonError(res, 404, "Run not found");
    res.json(run);
  });

  app.get("/api/runs/:id/events", (req, res) => {
    const initial = options.store.getRun(req.params.id);
    if (!initial) return jsonError(res, 404, "Run not found");
    res.status(200);
    res.set({ "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
    res.flushHeaders();
    let lastUpdated = "";
    const send = (): boolean => {
      const run = options.store.getRun(req.params.id);
      if (!run) {
        res.write("event: error\ndata: {\"error\":\"Run not found\"}\n\n");
        res.end();
        return true;
      }
      if (run.updatedAt !== lastUpdated) {
        lastUpdated = run.updatedAt;
        res.write(`event: run\ndata: ${JSON.stringify(run)}\n\n`);
      }
      if (isTerminal(run)) {
        res.end();
        return true;
      }
      return false;
    };
    if (send()) return;
    const timer = setInterval(() => {
      if (send()) clearInterval(timer);
    }, 400);
    timer.unref();
    req.on("close", () => clearInterval(timer));
  });

  app.post("/api/runs/:id/approve", async (req, res, next) => {
    const parsed = approvalSchema.safeParse(req.body);
    if (!parsed.success) return jsonError(res, 400, validationMessage(parsed.error));
    try {
      res.json(await options.engine.approve(req.params.id, parsed.data.approved));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/runs/:id/answer", async (req, res, next) => {
    const parsed = answerSchema.safeParse(req.body);
    if (!parsed.success) return jsonError(res, 400, validationMessage(parsed.error));
    try {
      res.json(await options.engine.answer(req.params.id, parsed.data.answer));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/runs/:id/cancel", async (req, res, next) => {
    try {
      res.json(await options.engine.cancel(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/runs/:id/screenshot", (req, res) => {
    const run = options.store.getRun(req.params.id);
    if (!run) return jsonError(res, 404, "Run not found");
    const screenshot = options.engine.latestScreenshot(req.params.id);
    if (!screenshot) return jsonError(res, 404, "No screenshot is available for this run");
    res.redirect(302, screenshot);
  });

  app.get("/api/runs/:id/file", (req, res) => {
    if (!options.store.getRun(req.params.id)) return jsonError(res, 404, "Run not found");
    try {
      const path = sandboxFilePath(options.engine.getWorkspacePath(req.params.id), String(req.query.path ?? ""));
      res.set("x-content-type-options", "nosniff");
      res.type(extname(path).toLowerCase() === ".json" ? "application/json" : "text/plain; charset=utf-8");
      res.sendFile(path, { dotfiles: "allow" }, (error) => { if (error && !res.headersSent) jsonError(res, 404, "File not found"); });
    } catch (error) {
      jsonError(res, 400, error instanceof Error ? error.message : "Invalid file path");
    }
  });

  app.get("/api/memory", (_req, res) => res.json(options.store.getState().memory));

  app.post("/api/reset", async (_req, res, next) => {
    const state = options.store.getState();
    const active = state.activeRunId ? state.runs[state.activeRunId] : undefined;
    if (active && !isTerminal(active)) return jsonError(res, 409, "Cancel or finish the active run before resetting the demo");
    try {
      await options.store.resetCompany();
      res.json(options.store.getState().company);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/company/state", (_req, res) => res.json(options.store.getState().company));

  app.post("/api/company/invoices", async (req, res, next) => {
    const workerRunId = req.get("x-worker-run");
    if (workerRunId) {
      const allowed = await options.engine.authorizeMutation({
        runId: workerRunId,
        ...(req.get("x-worker-approval") ? { token: req.get("x-worker-approval")! } : {}),
        method: req.method,
        path: req.path,
        body: req.body,
      });
      if (!allowed) return jsonError(res, 403, "Invoice mutation is not bound to an approved exact form payload");
    }
    try {
      const payload = invoiceInputSchema.partial({ issuedDate: true }).safeParse(req.body);
      if (!payload.success) throw new CompanyError(400, validationMessage(payload.error));
      const result = await createInvoice(options.store, req.body, workerRunId ? () => options.engine.workerContextActive(workerRunId) : () => true, workerRunId);
      if (workerRunId) await options.engine.markWriteCommitted(workerRunId);
      res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      if (workerRunId && error instanceof CompanyError) await options.engine.markWriteFailed(workerRunId, error.status);
      next(error);
    }
  });

  app.patch("/api/company/contacts/:id", async (req, res, next) => {
    const workerRunId = req.get("x-worker-run");
    if (workerRunId) {
      const allowed = await options.engine.authorizeMutation({
        runId: workerRunId,
        ...(req.get("x-worker-approval") ? { token: req.get("x-worker-approval")! } : {}),
        method: req.method,
        path: req.path,
        body: req.body,
      });
      if (!allowed) return jsonError(res, 403, "Contact mutation is not bound to an approved exact form payload");
    }
    const parsed = contactPatchSchema.safeParse(req.body);
    if (!parsed.success) return jsonError(res, 400, validationMessage(parsed.error));
    try {
      const result = await updateContact(
        options.store,
        req.params.id,
        parsed.data,
        workerRunId ? () => options.engine.workerContextActive(workerRunId) : () => true,
        workerRunId,
      );
      if (workerRunId) await options.engine.markWriteCommitted(workerRunId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.use("/artifacts", express.static(options.artifactsDir, { fallthrough: false, index: false, dotfiles: "deny" }));
  if (existsSync(companyFile)) {
    app.use("/company", (_req, res, next) => res.sendFile(companyFile, (error) => { if (error) next(error); }));
  }
  app.use(express.static(publicDir, { index: "index.html" }));

  const errors: ErrorRequestHandler = (error, _req: Request, res: Response, _next) => {
    if (error instanceof CompanyError || error instanceof WorkerError) return jsonError(res, error.status, error.message);
    if (error instanceof z.ZodError) return jsonError(res, 400, validationMessage(error));
    if (res.headersSent) return;
    const message = error instanceof Error ? error.message : "Internal server error";
    jsonError(res, 500, message);
  };
  app.use(errors);
  return app;
}
