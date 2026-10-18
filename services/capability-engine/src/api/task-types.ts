import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { rateLimit } from "@verdict/http-local";
import { canonical, sha256Hex } from "@verdict/protocol";
import { dirHashFromDisk } from "@verdict/protocol/node";
import type { FastifyInstance } from "fastify";
import {
  type Catalogue,
  DEFAULT_PACKAGES_ROOT,
  type PackageEntry,
  verifierLists,
} from "../catalogue.js";
import type { EventBus } from "../events.js";

export const ENTRY_RE = /^[a-z][a-z0-9-]{1,30}\.mjs$/;
export const INPUT_EXT_RE = /^\.[a-z0-9]{1,8}$/;
const INPUT_EXTS = [".txt", ".json", ".csv"];
const outExt = (d: Draft): string => (d.input_ext === ".json" ? ".json" : ".txt");
export const MAX_DRAFT_BYTES = 64 * 1024;
const MAX_CELL = 2048;

export interface Pair {
  input: string;
  expected: string;
}
export interface Assertions {
  output_keys_required?: string[];
  max_output_bytes?: number;
  numbers_subset_of_input?: boolean;
  required_tokens?: string[];
  forbidden_tokens?: string[];
}
/** The strict draft shape (same as the buyer agent's author schema). Output is .out.json for a .json input, else .out.txt. */
export interface Draft {
  feasibility: "cli" | "reframe";
  reason: string;
  reframe?: string;
  title: string;
  description: string;
  entry: string;
  input_ext: string;
  visible: Pair[];
  hidden: Pair[];
  assertions: Assertions;
}

/** A refusal with a sentence a non-technical person can read. */
export class DraftRejected extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const only = (o: Record<string, unknown>, allowed: readonly string[], what: string): void => {
  for (const k of Object.keys(o))
    if (!allowed.includes(k)) throw new DraftRejected(`${what} has an unexpected field "${k}".`);
};
const str = (v: unknown, what: string, min: number, max: number): string => {
  if (typeof v !== "string" || v.length < min || v.length > max)
    throw new DraftRejected(
      `${what} must be text of ${min === 0 ? "at most" : `${min} to`} ${max} characters.`,
    );
  return v;
};
const strList = (v: unknown, what: string): string[] => {
  if (
    !Array.isArray(v) ||
    v.length > 20 ||
    !v.every((x) => typeof x === "string" && x.length >= 1 && x.length <= 100)
  )
    throw new DraftRejected(`${what} must be a list of up to 20 short texts.`);
  return v as string[];
};

function pairs(v: unknown, what: string, min: number, max: number): Pair[] {
  if (!Array.isArray(v) || v.length < min || v.length > max)
    throw new DraftRejected(
      min === max
        ? `The test needs exactly ${min} ${what} examples.`
        : `The test needs ${min} to ${max} ${what} examples.`,
    );
  return v.map((p, i) => {
    if (!isObj(p))
      throw new DraftRejected(`The ${what} example ${i + 1} is not an input/output pair.`);
    only(p, ["input", "expected"], `The ${what} example ${i + 1}`);
    return {
      input: str(p.input, `The input of ${what} example ${i + 1}`, 1, MAX_CELL),
      expected: str(p.expected, `The expected output of ${what} example ${i + 1}`, 1, MAX_CELL),
    };
  });
}

function assertions(v: unknown): Assertions {
  if (!isObj(v)) throw new DraftRejected("The rules must be an object.");
  only(
    v,
    [
      "output_keys_required",
      "max_output_bytes",
      "numbers_subset_of_input",
      "required_tokens",
      "forbidden_tokens",
    ],
    "The rules",
  );
  const out: Assertions = {};
  if (v.output_keys_required !== undefined)
    out.output_keys_required = strList(v.output_keys_required, "output_keys_required");
  if (v.required_tokens !== undefined)
    out.required_tokens = strList(v.required_tokens, "required_tokens");
  if (v.forbidden_tokens !== undefined)
    out.forbidden_tokens = strList(v.forbidden_tokens, "forbidden_tokens");
  if (v.max_output_bytes !== undefined) {
    if (
      !Number.isInteger(v.max_output_bytes) ||
      (v.max_output_bytes as number) < 1 ||
      (v.max_output_bytes as number) > 1_048_576
    )
      throw new DraftRejected("max_output_bytes must be a whole number between 1 and 1048576.");
    out.max_output_bytes = v.max_output_bytes as number;
  }
  if (v.numbers_subset_of_input !== undefined) {
    if (typeof v.numbers_subset_of_input !== "boolean")
      throw new DraftRejected("numbers_subset_of_input must be true or false.");
    out.numbers_subset_of_input = v.numbers_subset_of_input;
  }
  return out;
}

/** Line endings unified, each line trimmed, outer blank space dropped: what the judge compares. */
const norm = (t: string): string =>
  t
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();

/** First 8 hex of sha256 over the canonical draft: the suffix of the package id and directory name. */
export const draft8 = (d: Draft): string => sha256Hex(canonical(d)).slice(0, 8);

/** Strict validation of the draft shape plus the content rules. Throws DraftRejected with a plain sentence. */
export function validateDraft(raw: unknown): Draft {
  if (!isObj(raw)) throw new DraftRejected("The test draft is missing.");
  only(
    raw,
    [
      "feasibility",
      "reason",
      "reframe",
      "title",
      "description",
      "entry",
      "input_ext",
      "visible",
      "hidden",
      "assertions",
    ],
    "The draft",
  );
  if (raw.feasibility !== "cli" && raw.feasibility !== "reframe")
    throw new DraftRejected(
      "Only work a program can be tested on (it reads an input and prints an output) can be installed.",
    );
  const d: Draft = {
    feasibility: raw.feasibility,
    reason: str(raw.reason, "The reason", 1, 200),
    title: str(raw.title, "The title", 1, 60).trim(),
    description: str(raw.description, "The description", 1, 600),
    entry: str(raw.entry, "The program name", 1, 40),
    input_ext: str(raw.input_ext, "The input file extension", 1, 9),
    visible: pairs(raw.visible, "shown", 3, 3),
    hidden: pairs(raw.hidden, "hidden", 5, 8),
    assertions: assertions(raw.assertions),
  };
  if (raw.reframe !== undefined) d.reframe = str(raw.reframe, "The reframe sentence", 0, 300);
  if (d.title === "") throw new DraftRejected("The title is empty.");
  if (!ENTRY_RE.test(d.entry))
    throw new DraftRejected(
      "The program name must be lowercase letters, digits and dashes, ending in .mjs (for example sum-numbers.mjs).",
    );
  if (!INPUT_EXT_RE.test(d.input_ext) || !INPUT_EXTS.includes(d.input_ext))
    throw new DraftRejected("The input file extension must be .txt, .json or .csv.");
  const all = [...d.visible, ...d.hidden];
  if (new Set(all.map((p) => norm(p.input))).size !== all.length)
    throw new DraftRejected(
      "Two examples use the same input (ignoring spaces and line endings), so the test would check less than it claims. Give every example a different input.",
    );
  if (new Set(d.hidden.map((p) => norm(p.expected))).size < 2)
    throw new DraftRejected(
      "Every hidden example expects the same output, so a program that always prints that one answer would pass. Make the expected outputs differ.",
    );
  const changed = d.hidden.filter((p) => norm(p.expected) !== norm(p.input)).length;
  if (changed * 2 < d.hidden.length)
    throw new DraftRejected(
      "In most hidden examples the expected output is just the input, so a program that copies its input would be paid. Make the expected outputs differ from the inputs.",
    );
  const bytes = all.reduce(
    (n, p) => n + Buffer.byteLength(p.input) + Buffer.byteLength(p.expected),
    0,
  );
  if (bytes > MAX_DRAFT_BYTES)
    throw new DraftRejected("The examples are too large in total (the limit is 64 KiB).");
  return d;
}

/** Lowercase letters, digits and single dashes, at most 24 characters. */
export function slugOf(title: string): string {
  const s = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return s === "" ? "task" : s;
}

const BANNED_IMPORTS = [
  "net",
  "http",
  "https",
  "http2",
  "tls",
  "dgram",
  "dns",
  "child_process",
  "worker_threads",
  "cluster",
];
const BANNED_TOKENS = ["fetch", "import(", "XMLHttpRequest", "WebSocket", "eval"];

/** Manifest for a validated draft; same checks and profiles as json-normalise-v1, judge pinned by hash. */
export function buildManifest(d: Draft, name: string, judgeSha: string): Record<string, unknown> {
  const ext = outExt(d);
  const fx = { whitespace: "trim-lines", compare: "text" };
  return {
    format: 2,
    id: name,
    description: d.description,
    profile: "standard",
    entry: d.entry,
    cases_dir: "cases",
    visible_dir: "visible",
    input_ext: d.input_ext,
    expected_ext: `.expected${ext}`,
    output_ext: `.out${ext}`,
    case_timeout_seconds: 10,
    max_output_bytes: 1048576,
    judge_sha256: judgeSha,
    checks: [
      { id: "fixtures", kind: "fixtures", weight: 50, required: true, params: fx },
      {
        id: "visible",
        kind: "fixtures",
        weight: 10,
        required: false,
        params: { cases_dir: "visible", ...fx },
      },
      {
        id: "static",
        kind: "static",
        weight: 0,
        required: true,
        params: { banned_imports: BANNED_IMPORTS, banned_tokens: BANNED_TOKENS },
      },
      {
        id: "limits",
        kind: "limits",
        weight: 5,
        required: false,
        params: { max_source_bytes: 20000, max_lines: 300 },
      },
      {
        id: "spec",
        kind: "spec",
        weight: 10,
        required: true,
        params: { file: "spec/assertions.json" },
      },
    ],
    profiles: {
      strict: {
        min_score: 95,
        required_overrides: { visible: true },
        tolerances: {},
        determinism: "full",
      },
      standard: { min_score: 80, required_overrides: {}, tolerances: {}, determinism: "judge" },
      lenient: {
        min_score: 60,
        required_overrides: {},
        tolerances: { whitespace: "collapse" },
        determinism: "judge",
      },
    },
  };
}

export type InstallError = {
  status: 422 | 503 | 500;
  code: string;
  message: string;
  /** The underlying exception (500 only); logged by the route, never sent to the caller. */
  cause?: unknown;
};

export interface InstallDeps {
  root: string;
  catalogue: Catalogue;
  now: () => Date;
  verifierUrl?: string;
  verifierFetch?: typeof fetch;
  verifierWaitMs?: number;
  /** Where _judge and json-normalise-v1 are read from (default: the repository's verifier-packages). */
  templateRoot?: string;
}

function writeTree(tmp: string, d: Draft, name: string, date: string, tpl: string): void {
  const ext = outExt(d);
  const put = (rel: string, data: string): void => {
    const f = join(tmp, rel);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, data);
  };
  const judge = join(tpl, "_judge", "verify.mjs");
  const base = join(tpl, "json-normalise-v1");
  copyFileSync(judge, join(tmp, "verify.mjs"));
  copyFileSync(join(base, "verify.sh"), join(tmp, "verify.sh"));
  copyFileSync(join(base, "execute.mjs"), join(tmp, "execute.mjs"));
  const judgeSha = sha256Hex(new Uint8Array(readFileSync(join(tmp, "verify.mjs"))));
  put("manifest.json", `${canonical(buildManifest(d, name, judgeSha))}\n`);
  d.hidden.forEach((p, i) => {
    put(`cases/h${i + 1}${d.input_ext}`, p.input);
    put(`cases/h${i + 1}.expected${ext}`, p.expected);
  });
  d.visible.forEach((p, i) => {
    put(`visible/v${i + 1}${d.input_ext}`, p.input);
    put(`visible/v${i + 1}.expected${ext}`, p.expected);
  });
  put("spec/assertions.json", `${canonical(d.assertions)}\n`);
  put(
    "README.md",
    `# ${d.title}\n\n${d.description}\n\nAuthored by the buyer agent from the request on ${date}, reviewed by the principal.\n`,
  );
}

/** Writes, hashes, renames and registers a custom package. The verifier check is the caller's. */
export async function writePackage(
  d: Draft,
  deps: Pick<InstallDeps, "root" | "now" | "templateRoot">,
): Promise<{ entry: PackageEntry; created: boolean }> {
  const tpl = deps.templateRoot ?? DEFAULT_PACKAGES_ROOT;
  mkdirSync(deps.root, { recursive: true });
  const tmp = join(deps.root, `.tmp-custom-${randomBytes(6).toString("hex")}`);
  try {
    mkdirSync(tmp);
    const name = `custom-${slugOf(d.title)}-${draft8(d)}`;
    const dir = join(deps.root, name);
    if (existsSync(dir)) {
      // Same draft already installed (its README date may differ): reuse what is on disk, byte for byte.
      const entry: PackageEntry = {
        id: name,
        dir,
        hash: await dirHashFromDisk(dir),
        format: 2,
        title: d.title.slice(0, 60),
        description: d.description,
      };
      rmSync(tmp, { recursive: true, force: true });
      return { entry, created: false };
    }
    writeTree(tmp, d, name, deps.now().toISOString().slice(0, 10), tpl);
    const hash = await dirHashFromDisk(tmp);
    const entry: PackageEntry = {
      id: name,
      dir,
      hash,
      format: 2,
      title: d.title.slice(0, 60),
      description: d.description,
    };
    renameSync(tmp, dir);
    return { entry, created: true };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

const locks = new Map<string, Promise<unknown>>();
/** Runs `fn` after every earlier job with the same key has finished (same package name installs one at a time). */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export async function installDraft(
  raw: unknown,
  deps: InstallDeps,
): Promise<{ ok: true; entry: PackageEntry } | ({ ok: false } & InstallError)> {
  let key: string;
  try {
    const d = validateDraft(raw);
    key = `${deps.root}\0${slugOf(d.title)}-${draft8(d)}`;
  } catch {
    return installLocked(raw, deps);
  }
  return withLock(key, () => installLocked(raw, deps));
}

async function installLocked(
  raw: unknown,
  deps: InstallDeps,
): Promise<{ ok: true; entry: PackageEntry } | ({ ok: false } & InstallError)> {
  let d: Draft;
  try {
    d = validateDraft(raw);
  } catch (e) {
    if (e instanceof DraftRejected)
      return { ok: false, status: 422, code: "DRAFT_REJECTED", message: e.message };
    throw e;
  }
  let written: { entry: PackageEntry; created: boolean };
  try {
    written = await writePackage(d, deps);
  } catch (e) {
    if (e instanceof DraftRejected)
      return { ok: false, status: 422, code: "DRAFT_REJECTED", message: e.message };
    return {
      ok: false,
      status: 500,
      code: "INSTALL_FAILED",
      message: "The test could not be written to disk. Nothing was installed.",
      cause: e,
    };
  }
  const listed = await verifierLists(
    deps.verifierUrl,
    written.entry.hash,
    deps.verifierFetch,
    deps.verifierWaitMs ?? 3000,
  );
  if (!listed) {
    if (written.created) rmSync(written.entry.dir, { recursive: true, force: true });
    return {
      ok: false,
      status: 503,
      code: "VERIFIER_PACKAGE_UNAVAILABLE",
      message:
        "The verifier did not accept this test within 3 seconds, so no payment could be released against it. Nothing was installed.",
    };
  }
  try {
    deps.catalogue.add(written.entry);
  } catch {
    return {
      ok: false,
      status: 422,
      code: "DRAFT_REJECTED",
      message: "A different test is already installed under this name.",
    };
  }
  return { ok: true, entry: written.entry };
}

/** How many checks the draft's assertions switch on (shown in the dialog). */
function countRules(a: Assertions): number {
  let n = 0;
  if (a.output_keys_required?.length) n++;
  if (a.max_output_bytes !== undefined) n++;
  if (a.numbers_subset_of_input) n++;
  if (a.required_tokens?.length) n++;
  if (a.forbidden_tokens?.length) n++;
  return n;
}

function safeSlug(draft: unknown): string | undefined {
  return isObj(draft) && typeof draft.title === "string" ? slugOf(draft.title) : undefined;
}

export interface TaskTypeRouteDeps extends InstallDeps {
  bus: EventBus;
  rateLimit?: { max: number; windowMs: number };
}

/**
 * POST /api/task-types { draft } ->
 *   200 { ok: true, id, package_sha256, title }   (and a UI event TASK_TYPE_ADDED { id, title, package_sha256 })
 *   422 { ok: false, code: "DRAFT_REJECTED", message }
 *   503 { ok: false, code: "VERIFIER_PACKAGE_UNAVAILABLE", message }   (directory removed)
 */
export function registerTaskTypeInstall(app: FastifyInstance, d: TaskTypeRouteDeps): void {
  const limiter = rateLimit(d.rateLimit ?? { max: 10, windowMs: 60_000 });
  app.post("/api/task-types", { preHandler: limiter }, async (req, reply) => {
    const body: unknown = req.body;
    const draft = isObj(body) ? body.draft : undefined;
    try {
      const r = await installDraft(draft, d);
      if (!r.ok) {
        // Never the draft or the request text: only the code, the (slug of the) title when it is a string, the message.
        if (r.cause !== undefined)
          app.log.error(
            { code: r.code, err: r.cause instanceof Error ? r.cause.stack : String(r.cause) },
            r.message,
          );
        else app.log.warn({ code: r.code, slug: safeSlug(draft) }, r.message);
        reply.code(r.status);
        return { ok: false, code: r.code, message: r.message };
      }
      const known = d.catalogue.byId(r.entry.id);
      if (known)
        d.bus.publish(
          {
            type: "TASK_TYPE_ADDED",
            data: { id: r.entry.id, title: r.entry.title, package_sha256: r.entry.hash },
          },
          d.now(),
        );
      const dr = draft as Draft;
      return {
        ok: true,
        id: r.entry.id,
        package_sha256: r.entry.hash,
        title: r.entry.title,
        hidden_cases: dr.hidden.length,
        visible_cases: dr.visible.length,
        rules: countRules(dr.assertions),
      };
    } catch (err) {
      app.log.error(
        { code: "INSTALL_FAILED", err: err instanceof Error ? err.stack : String(err) },
        "task type install failed",
      );
      reply.code(500);
      return {
        ok: false,
        code: "INSTALL_FAILED",
        message: "The test could not be installed. Nothing was installed.",
      };
    }
  });
}
