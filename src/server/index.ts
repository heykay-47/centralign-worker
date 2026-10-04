import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { createPlanner } from "./provider.js";
import { StateStore } from "./store.js";
import { WorkerEngine } from "./worker.js";

try {
  process.loadEnvFile?.(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

function envInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
}

const root = resolve(process.cwd());
const dataDir = resolve(root, process.env.DATA_DIR ?? ".data");
const artifactsDir = resolve(dataDir, "artifacts");
const workspaceRoot = resolve(dataDir, "workspace");
const port = envInteger("PORT", 3000, 1, 65535);
const host = process.env.HOST ?? "127.0.0.1";
const model = process.env.WORKER_MODEL ?? "openai/gpt-6-luna#low";
const provider = process.env.WORKER_PROVIDER ?? "opencode";
const timeoutMs = envInteger("WORKER_STEP_TIMEOUT_MS", 90_000, 5_000, 300_000);
const maxSteps = envInteger("WORKER_MAX_STEPS", 25, 1, 100);
const companyUrl = process.env.WORKER_COMPANY_URL ?? `http://127.0.0.1:${port}/company`;
const publicDir = resolve(root, "public");

const store = new StateStore(resolve(dataDir, "state.json"));
await store.initialize();
await mkdir(artifactsDir, { recursive: true });
await mkdir(workspaceRoot, { recursive: true });
const planner = await createPlanner({
  provider,
  model,
  command: process.env.WORKER_OPENCODE_COMMAND ?? "opencode",
  ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
  baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  timeoutMs,
  diagnosticsDir: resolve(dataDir, "diagnostics"),
});
const engine = new WorkerEngine(store, planner, { companyUrl, artifactsDir, workspaceRoot, maxSteps });
const app = createApp({ store, engine, publicDir, artifactsDir, workspaceRoot, providerReady: () => planner.ready() });
const server = createServer(app);

server.listen(port, host, () => {
  console.log(`Centralign backend listening at http://${host}:${port}`);
  console.log(`Worker model: ${planner.provider}/${planner.model}`);
});

const shutdown = async () => {
  server.close();
  await engine.close();
  process.exit(0);
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
