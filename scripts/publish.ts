// ---------------------------------------------------------------------------
// Publish every package in this repository that npm does not have yet.
//
//   bun run release                 publish what is new
//   bun run release --dry-run       everything but the upload
//   bun run release --only creo-edit-mermaid-plugin
//   bun run release --tag next --otp 123456
//
// What "release" means here is deliberately small: the version in each
// package.json is the version to publish, and bumping it (with its changelog
// entry) stays a commit you make yourself, as "0.5.0" was. This script takes
// it from there — a version npm already has is skipped, so running it twice,
// or after bumping only one package, does the right thing.
//
// Order matters and is fixed: the editor first. The plugin's build checks its
// types against the editor's BUILT declarations, and a consumer installing
// the plugin needs an editor on npm that satisfies its peer range.
// ---------------------------------------------------------------------------

import { resolve } from "path";

const root = resolve(import.meta.dir, "..");

type Pkg = {
  /** Directory, relative to the repository root. */
  dir: string;
  /** Commands that must pass before it may be published, run in `dir`. */
  checks: string[][];
};

// Publish order. Add a package here when one is added to `packages/`.
const PACKAGES: Pkg[] = [
  {
    dir: ".",
    checks: [
      ["bun", "install", "--frozen-lockfile"],
      ["bun", "run", "typecheck"],
      ["bun", "test", "src/"],
      ["bun", "run", "build"],
    ],
  },
  {
    dir: "packages/mermaid",
    checks: [
      ["bun", "install", "--frozen-lockfile"],
      ["bun", "run", "typecheck"],
      ["bun", "test", "src/"],
      ["bun", "run", "build"],
    ],
  },
];

// --- arguments -------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (flag("help") || flag("h")) {
  console.log(`Publish every package npm does not have yet.

  --dry-run        run every check and \`npm publish --dry-run\`; upload nothing
  --only <name>    publish just this package (by its npm name)
  --tag <tag>      npm dist-tag (default: latest)
  --otp <code>     one-time password, if your npm account asks for one
  --skip-checks    do not typecheck / test before publishing (still builds)
  --allow-dirty    publish with uncommitted changes in the working tree
`);
  process.exit(0);
}

const DRY = flag("dry-run");
const ONLY = value("only");
const TAG = value("tag");
const OTP = value("otp");
const SKIP_CHECKS = flag("skip-checks");
const ALLOW_DIRTY = flag("allow-dirty");

// --- helpers ---------------------------------------------------------------

const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;

function die(message: string): never {
  console.error(`\n${red("✗")} ${message}\n`);
  process.exit(1);
}

/** No step here should take this long. One that does is stuck, not slow. */
const STEP_TIMEOUT_MS = 15 * 60_000;

/** Run a command with its output on the terminal. Stops everything if it fails. */
async function run(cmd: string[], cwd: string): Promise<void> {
  console.log(dim(`  $ ${cmd.join(" ")}`));
  const proc = Bun.spawn(cmd, { cwd, stdio: ["inherit", "inherit", "inherit"] });
  // A hung step must not look like a release in progress. (Bun 1.2.8 hangs
  // on `bun install` when a required peer cannot be resolved from npm — see
  // packages/mermaid/bunfig.toml for how this repository stays clear of it.)
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, STEP_TIMEOUT_MS);
  const code = await proc.exited;
  clearTimeout(timer);
  if (timedOut) die(`\`${cmd.join(" ")}\` in ${cwd} did not finish in ${STEP_TIMEOUT_MS / 60_000} minutes and was stopped. Nothing after it was run.`);
  if (code !== 0) die(`\`${cmd.join(" ")}\` failed in ${cwd} (exit ${code}). Nothing after it was run.`);
}

/** Run a command and hand back what it printed, without failing the script. */
async function capture(cmd: string[], cwd = root): Promise<{ ok: boolean; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}

type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  peerDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};

type Entry = Pkg & { abs: string; manifest: Manifest; published: boolean };

/**
 * Whether npm already has `name@version`. A version that is not there comes
 * back as E404; anything else that fails (offline, registry down) must not be
 * mistaken for "not published", or the script would try to publish over it.
 */
async function isPublished(name: string, version: string): Promise<boolean> {
  const r = await capture(["npm", "view", `${name}@${version}`, "version"]);
  if (r.ok) return r.out !== "";
  if (/E404|404 Not Found|is not in this registry/.test(r.err)) return false;
  die(`Could not ask npm about ${name}@${version}:\n${r.err}`);
}

/** The newest version of `name` on npm, or null if it has never been published. */
async function latestOnNpm(name: string): Promise<string | null> {
  const r = await capture(["npm", "view", name, "version"]);
  return r.ok && r.out ? r.out : null;
}

// --- plan ------------------------------------------------------------------

const entries: Entry[] = [];
for (const pkg of PACKAGES) {
  const abs = resolve(root, pkg.dir);
  const manifest = (await Bun.file(resolve(abs, "package.json")).json()) as Manifest;
  if (manifest.private) continue;
  entries.push({
    ...pkg,
    abs,
    manifest,
    published: await isPublished(manifest.name, manifest.version),
  });
}

if (ONLY && !entries.some((e) => e.manifest.name === ONLY)) {
  die(`--only ${ONLY}: no such package. Known: ${entries.map((e) => e.manifest.name).join(", ")}`);
}

const selected = (e: Entry): boolean => !ONLY || e.manifest.name === ONLY;
const todo = entries.filter((e) => selected(e) && !e.published);

console.log(bold(`\n${DRY ? "Dry run — nothing will be uploaded" : "Publishing to npm"}\n`));
for (const e of entries) {
  const id = `${e.manifest.name}@${e.manifest.version}`.padEnd(40);
  const what = e.published
    ? dim("already on npm — skipped")
    : selected(e)
      ? green("to publish")
      : dim("not selected (--only)");
  console.log(`  ${id} ${what}`);
}
console.log();

if (todo.length === 0) {
  console.log("Nothing to publish: npm has every version in this repository.");
  console.log(dim("Bump a package's version (and its changelog) to release it.\n"));
  process.exit(0);
}

// --- checks that need no building ------------------------------------------

// A package here that depends on another one here: the range has to be
// satisfiable by what will be on npm when this run is done — either the
// version going out now, or the newest one already there. Otherwise the
// package installs for nobody. (The plugin naming an editor version that has
// not been released yet is the mistake this catches.)
for (const e of todo) {
  const needs = { ...e.manifest.peerDependencies, ...e.manifest.dependencies };
  for (const other of entries) {
    const range = needs[other.manifest.name];
    if (!range) continue;
    const goingOut = todo.includes(other) || other.published;
    const local = goingOut ? other.manifest.version : null;
    const remote = await latestOnNpm(other.manifest.name);
    const candidates = [local, remote].filter((v): v is string => !!v);
    if (candidates.some((v) => Bun.semver.satisfies(v, range))) continue;
    die(
      `${e.manifest.name}@${e.manifest.version} needs ${other.manifest.name} ${range}, but\n` +
        `    this repository has ${other.manifest.name}@${other.manifest.version}` +
        (ONLY && !todo.includes(other) && !other.published ? " (not being published in this run)" : "") +
        `\n    and npm's newest is ${remote ?? "nothing"}.\n\n` +
        `  Release a ${other.manifest.name} that satisfies ${range} — bump its version and run this again —\n` +
        `  or change the range in ${e.dir}/package.json.`,
    );
  }
}

if (!ALLOW_DIRTY) {
  const status = await capture(["git", "status", "--porcelain"]);
  if (status.out !== "") {
    const msg =
      "The working tree has uncommitted changes:\n\n" +
      status.out
        .split("\n")
        .slice(0, 12)
        .map((l) => `    ${l}`)
        .join("\n") +
      "\n\n  What gets published should be what is committed. Commit or stash, or pass --allow-dirty.";
    // A rehearsal on a dirty tree is what a rehearsal is for.
    if (DRY) console.log(`${dim("note:")} ${msg.replace(/\n\n  What gets[\s\S]*$/, "")}\n`);
    else die(msg);
  }
}

if (!DRY) {
  const who = await capture(["npm", "whoami"]);
  if (!who.ok) die("Not logged in to npm. Run `npm login` first.");
  console.log(`Logged in to npm as ${bold(who.out)}.\n`);
}

// --- build, check, publish — one package at a time, in order ---------------

const done: string[] = [];
for (const e of entries) {
  const id = `${e.manifest.name}@${e.manifest.version}`;
  const publishing = todo.includes(e);
  // A package that is not going out may still have to be BUILT: a later one
  // (the plugin) type-checks against its output.
  const neededLater = entries.slice(entries.indexOf(e) + 1).some((later) => todo.includes(later));
  if (!publishing && !neededLater) continue;

  console.log(bold(`\n— ${id}${publishing ? "" : dim("  (building only: a later package needs it)")}`));
  const steps = publishing && !SKIP_CHECKS ? e.checks : e.checks.filter((c) => c.includes("install") || c.includes("build"));
  for (const step of steps) await run(step, e.abs);
  if (!publishing) continue;

  const publish = ["npm", "publish", "--access", "public"];
  if (DRY) publish.push("--dry-run");
  if (TAG) publish.push("--tag", TAG);
  if (OTP) publish.push("--otp", OTP);
  await run(publish, e.abs);
  done.push(id);
}

console.log(
  `\n${green("✓")} ${DRY ? "Dry run complete. Would have published" : "Published"}: ${done.join(", ")}\n`,
);
