import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { type Run } from "../src/server/types.js";

const baseUrl = (process.env.CENTRALIGN_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const task = process.env.WORKER_SMOKE_TASK ?? "Import the latest invoice from Northstar Labs into accounting";
const prompt = createInterface({ input: stdin, output: stdout });

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

async function main(): Promise<void> {
  const health = await jsonRequest<{ modelReady: boolean; provider: string; model: string }>("/api/health");
  if (!health.modelReady) throw new Error(`Model provider is not ready (${health.provider}/${health.model})`);
  console.log(`Using real planner ${health.provider}/${health.model}`);
  const run = await jsonRequest<Run>("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task, injectFailure: process.env.SMOKE_INJECT_FAILURE === "1" }),
  });
  console.log(`Started run ${run.id}: ${run.task}`);

  const deadline = Date.now() + 10 * 60_000;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const current = await jsonRequest<Run>(`/api/runs/${run.id}`);
    if (current.status !== lastStatus) {
      lastStatus = current.status;
      console.log(`Run status: ${current.status}`);
    }
    if (current.status === "awaiting_approval") {
      console.log("Exact pending write (review all fields before approving):\n");
      console.log(current.approval?.details ?? "(details unavailable)");
      const answer = (await prompt.question("Approve this one write? [y/N] ")).trim().toLowerCase();
      await jsonRequest(`/api/runs/${run.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved: answer === "y" || answer === "yes" }),
      });
    } else if (current.status === "awaiting_input") {
      const answer = await prompt.question(`${current.question ?? "Worker needs clarification"}\n> `);
      await jsonRequest(`/api/runs/${run.id}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer }),
      });
    } else if (current.status === "completed") {
      console.log(current.summary ?? "Verified run completed.");
      console.log(JSON.stringify(current.evidence ?? [], null, 2));
      return;
    } else if (current.status === "failed" || current.status === "cancelled") {
      throw new Error(`${current.status}: ${current.error ?? current.summary ?? "run ended without completion"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  throw new Error("Smoke run exceeded ten minutes");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  prompt.close();
}
