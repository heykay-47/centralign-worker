import { z } from "zod";

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_input",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const eventTypeSchema = z.enum([
  "plan",
  "thought",
  "action",
  "observation",
  "memory",
  "retry",
  "approval",
  "verification",
  "error",
  "complete",
]);
export type RunEvent = {
  id: string;
  time: string;
  type: z.infer<typeof eventTypeSchema>;
  message: string;
  data?: unknown;
};

export type Evidence = { label: string; url: string };

export type Run = {
  id: string;
  task: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  plan: string[];
  events: RunEvent[];
  summary?: string;
  error?: string;
  approval?: { question: string; details: string };
  question?: string;
  evidence?: Evidence[];
  partialEffects?: string[];
  steps: number;
  provider: string;
  model: string;
  screenshotUrl?: string;
};

export type CompanyMessage = {
  id: string;
  from: string;
  subject: string;
  receivedAt: string;
  body: string;
  invoice?: {
    invoiceNumber: string;
    company: string;
    amount: number;
    currency: string;
    issuedDate: string;
    dueDate: string;
  };
};

export type Invoice = {
  id: string;
  invoiceNumber: string;
  company: string;
  amount: number;
  currency: string;
  issuedDate: string;
  dueDate: string;
  sourceMessageId: string;
  createdAt: string;
};

export type Contact = {
  id: string;
  company: string;
  name: string;
  email: string;
  phone?: string;
  updatedAt: string;
};

export type CompanyState = {
  messages: CompanyMessage[];
  invoices: Invoice[];
  contacts: Contact[];
  saveFailuresRemaining: number;
};

export type MemoryFact = {
  id: string;
  fact: string;
  runId: string;
  createdAt: string;
};

export type PersistedState = {
  runs: Record<string, Run>;
  activeRunId: string | null;
  company: CompanyState;
  memory: MemoryFact[];
};

const refSchema = z.string().regex(/^ref-\d+$/, "Reference must be an issued browser-element reference");
const evidenceCheckSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("invoice"), invoiceNumber: z.string().min(1), sourceMessageId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("contact"), company: z.string().min(1), fields: z.record(z.string(), z.string().min(1)) }).strict(),
  z.object({ type: z.literal("file"), path: z.string().min(1), includes: z.array(z.string().min(1)).min(1) }).strict(),
]);

export const browserActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("observe") }).strict(),
  z.object({ type: z.literal("navigate"), url: z.string().url() }).strict(),
  z.object({ type: z.literal("click"), ref: refSchema }).strict(),
  z.object({ type: z.literal("fill"), fields: z.array(z.object({ ref: refSchema, value: z.string().max(4000) }).strict()).min(1).max(20) }).strict(),
  z.object({ type: z.literal("remember"), fact: z.string().min(3).max(1000) }).strict(),
  z.object({ type: z.literal("ask_user"), question: z.string().min(3).max(1000) }).strict(),
  z.object({ type: z.literal("write_file"), path: z.string().min(1).max(240), content: z.string().max(200_000) }).strict(),
  z.object({ type: z.literal("finish"), summary: z.string().min(1).max(2000), checks: z.array(evidenceCheckSchema).max(20) }).strict(),
]);
export type BrowserAction = z.infer<typeof browserActionSchema>;

export const modelDecisionSchema = z.object({
  plan: z.array(z.string().min(1).max(300)).min(1).max(12),
  decisionNote: z.string().min(1).max(500),
  action: browserActionSchema,
}).strict();
export type ModelDecision = z.infer<typeof modelDecisionSchema>;

export const invoiceInputSchema = z.object({
  invoiceNumber: z.string().trim().min(1).max(80),
  company: z.string().trim().min(1).max(160),
  amount: z.coerce.number().finite().positive().max(100_000_000),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()),
  issuedDate: z.string().date(),
  dueDate: z.string().date(),
  sourceMessageId: z.string().trim().min(1).max(120),
}).strict();

export const contactPatchSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  email: z.string().trim().email().max(320).optional(),
  phone: z.string().trim().max(60).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one contact field is required");
