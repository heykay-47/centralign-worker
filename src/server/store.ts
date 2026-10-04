import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { seedCompany } from "./seed.js";
import { type PersistedState, type Run, type RunEvent } from "./types.js";

function freshState(): PersistedState {
  return { runs: {}, activeRunId: null, company: seedCompany(), memory: [] };
}

export class StateStore {
  private state = freshState();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      this.state = JSON.parse(await readFile(this.filePath, "utf8")) as PersistedState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = freshState();
    }
    if (!this.state || typeof this.state !== "object" || !this.state.runs || !this.state.company) {
      throw new Error(`Persisted state at ${this.filePath} is malformed`);
    }

    const interruptedAt = new Date().toISOString();
    for (const run of Object.values(this.state.runs)) {
      if (["queued", "running", "awaiting_approval", "awaiting_input"].includes(run.status)) {
        run.status = "failed";
        run.updatedAt = interruptedAt;
        run.error = "The server restarted before this run completed.";
        run.events.push({
          id: randomUUID(),
          time: interruptedAt,
          type: "error",
          message: run.error,
        });
      }
    }
    this.state.activeRunId = null;
    await this.persist();
  }

  getState(): PersistedState {
    return structuredClone(this.state);
  }

  getRun(id: string): Run | undefined {
    const run = this.state.runs[id];
    return run ? structuredClone(run) : undefined;
  }

  listRuns(): Run[] {
    return Object.values(this.state.runs)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((run) => structuredClone(run));
  }

  async mutate<T>(change: (state: PersistedState) => T): Promise<T> {
    const result = change(this.state);
    await this.persist();
    return structuredClone(result);
  }

  async createRun(run: Run, injectFailure = false): Promise<Run> {
    return this.mutate((state) => {
      state.runs[run.id] = run;
      state.activeRunId = run.id;
      if (injectFailure) state.company.saveFailuresRemaining = Math.max(state.company.saveFailuresRemaining, 1);
      return run;
    });
  }

  async updateRun(id: string, change: (run: Run, state: PersistedState) => void): Promise<Run> {
    return this.mutate((state) => {
      const run = state.runs[id];
      if (!run) throw new Error(`Run ${id} does not exist`);
      change(run, state);
      run.updatedAt = new Date().toISOString();
      if (["completed", "failed", "cancelled"].includes(run.status) && state.activeRunId === id) {
        state.activeRunId = null;
      }
      return run;
    });
  }

  async appendEvent(id: string, event: Omit<RunEvent, "id" | "time">): Promise<Run> {
    return this.updateRun(id, (run) => {
      run.events.push({ id: randomUUID(), time: new Date().toISOString(), ...event });
    });
  }

  async resetCompany(): Promise<void> {
    await this.mutate((state) => {
      state.company = seedCompany();
    });
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    const next = this.writeQueue.then(async () => {
      const temp = join(dirname(this.filePath), `.state-${process.pid}-${randomUUID()}.tmp`);
      await writeFile(temp, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.filePath);
    });
    this.writeQueue = next.catch(() => undefined);
    await next;
  }
}
