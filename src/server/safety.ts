import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const allowedExtensions = new Set([".txt", ".md", ".json"]);

export function isAllowedCompanyUrl(candidate: string, companyUrl: string): boolean {
  try {
    const base = new URL(companyUrl);
    const url = new URL(candidate, base);
    const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    return url.protocol === "http:" && localHosts.has(url.hostname) && url.origin === base.origin &&
      (url.pathname === "/company" || url.pathname.startsWith("/company/"));
  } catch {
    return false;
  }
}

export function sandboxFilePath(root: string, requestedPath: string): string {
  if (isAbsolute(requestedPath) || requestedPath.includes("\0")) throw new Error("File path must be relative to the run workspace");
  const normalized = requestedPath.replaceAll("\\", "/");
  if (normalized.split("/").some((segment) => segment === ".." || segment === "")) throw new Error("File path contains an unsafe segment");
  if (!allowedExtensions.has(extname(normalized).toLowerCase())) throw new Error("Only .txt, .md, and .json files are allowed");
  const target = resolve(root, normalized);
  const rel = relative(resolve(root), target);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("File path escapes the run workspace");
  return target;
}

export async function writeSandboxFile(root: string, requestedPath: string, content: string): Promise<string> {
  const target = sandboxFilePath(root, requestedPath);
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  const parent = target.slice(0, target.lastIndexOf(sep)) || root;
  await mkdir(parent, { recursive: true });
  const canonicalParent = await realpath(parent);
  const parentRelative = relative(canonicalRoot, canonicalParent);
  if (parentRelative.startsWith(`..${sep}`) || parentRelative === ".." || isAbsolute(parentRelative)) {
    throw new Error("File path resolves outside the run workspace");
  }
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error("Symbolic links are not allowed in the run workspace");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
  return target;
}

export function normalizeComparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeComparable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, normalizeComparable(entry)]));
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (/^-?(?:\d+|\d*\.\d+)$/.test(text) && text !== "") {
      const number = Number(text);
      if (Number.isFinite(number)) return number;
    }
    return text;
  }
  return value;
}

export function comparableJson(value: unknown): string {
  return JSON.stringify(normalizeComparable(value));
}
