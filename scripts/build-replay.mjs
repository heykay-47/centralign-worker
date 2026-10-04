// Builds a static, read-only replay of recorded live runs for hosting on Vercel.
// Usage: node scripts/build-replay.mjs [dataDir]   (default: .data/final)
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dataDir = resolve(root, process.argv[2] ?? ".data/final");
const out = join(root, "replay-site");

const state = JSON.parse(await readFile(join(dataDir, "state.json"), "utf8"));
const runs = Object.values(state.runs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

// Files the worker wrote in each run's sandbox, served by /api/runs/:id/file.
const files = {};
for (const run of runs) {
  const dir = join(dataDir, "workspace", run.id);
  if (!existsSync(dir)) continue;
  for (const name of await readdir(dir)) {
    files[`${run.id}/${name}`] = await readFile(join(dir, name), "utf8");
  }
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(join(root, "public"), out, { recursive: true });
await cp(join(dataDir, "artifacts"), join(out, "artifacts"), { recursive: true });

// Evidence links open files by navigation, which the fetch shim can't intercept, so serve them statically.
for (const [key, text] of Object.entries(files)) {
  await mkdir(join(out, "files", key, ".."), { recursive: true });
  await writeFile(join(out, "files", key), text);
}
for (const run of runs) {
  for (const item of run.evidence ?? []) {
    const match = item.url?.match(/^\/api\/runs\/([^/]+)\/file\?path=(.+)$/);
    if (match) item.url = `/files/${match[1]}/${decodeURIComponent(match[2])}`;
  }
}

const replayData = {
  health: { ok: true, provider: "Recorded replay", model: "openai/gpt-6-luna#low", modelReady: true, replay: true },
  runs,
  company: state.company,
  memory: state.memory ?? [],
  files,
};
await writeFile(join(out, "replay-data.js"), `window.__REPLAY__ = ${JSON.stringify(replayData)};\n`);
await cp(join(root, "scripts", "replay-shim.js"), join(out, "replay-shim.js"));

for (const page of ["index.html", "company.html"]) {
  const path = join(out, page);
  const html = await readFile(path, "utf8");
  const inject = '    <script src="/replay-data.js"></script>\n    <script src="/replay-shim.js"></script>\n';
  await writeFile(path, html.replace(/(\s*<script src="\/(dashboard|company)\.js")/, `\n${inject}$1`));
}

await writeFile(join(out, "vercel.json"), JSON.stringify({
  cleanUrls: true,
  trailingSlash: false,
  headers: [{ source: "/files/(.*)", headers: [{ key: "Content-Type", value: "text/plain; charset=utf-8" }, { key: "X-Content-Type-Options", value: "nosniff" }] }],
}, null, 2) + "\n");
console.log(`Replay built in ${out}: ${runs.length} runs, ${Object.keys(files).length} files.`);
