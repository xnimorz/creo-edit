// ---------------------------------------------------------------------------
// Release the packages in this repository that have something to release.
//
//   bun run release                  work out what changed, ask how to bump it
//   bun run release --dry-run        the whole run, nothing uploaded or kept
//   bun run release --bump minor     bump every changed package the same way
//   bun run release --bump creo-edit=minor,creo-edit-mermaid-plugin=patch
//   bun run release --only creo-edit-mermaid-plugin
//
// Each package is in one of three states:
//
//   unpublished  its version is not on npm           → published as it is
//   changed      its version IS on npm, but what it  → needs a new version,
//                ships has changed since               which this run sets
//   unchanged    on npm, nothing new                 → left alone
//
// "Changed" is asked of git: the commit that last set the package's version
// is its release, and the package has changed if anything it ships differs
// from that commit. Looking only at whether the version number is on npm (as
// this script first did) called an editor with four changed source files
// "already published", and then refused to publish the plugin that needed
// them.
//
// The run is in two halves so that a failure cannot leave half a release on
// npm: first every package to go out is installed, type-checked, tested and
// built; only then, back to back, are they uploaded. The editor is first in
// both — the plugin's build checks its types against the editor's built
// declarations, and its users need an editor on npm that satisfies its range.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import {
  BUMP_LEVELS,
  bumpVersion,
  isBumpLevel,
  isVersion,
  manifestChanged,
  parseArgs,
  releaseChangelog,
  resolveBump,
  setManifestVersion,
  suggestBump,
  type Args,
} from "./release-lib";

const root = resolve(import.meta.dir, "..");

type Pkg = {
  /** Directory, relative to the repository root. */
  dir: string;
  /** What it ships is built from these, relative to `dir`. */
  sources: string[];
  /** Commands that must pass before it may be published, run in `dir`. */
  checks: string[][];
};

// Publish order. Add a package here when one is added to `packages/`.
const PACKAGES: Pkg[] = [
  {
    dir: ".",
    sources: ["src", "build.ts", "tsconfig.build.json"],
    checks: [
      ["bun", "install", "--frozen-lockfile"],
      ["bun", "run", "typecheck"],
      ["bun", "test", "src/"],
      ["bun", "run", "build"],
    ],
  },
  {
    dir: "packages/mermaid",
    sources: ["src", "build.ts", "tsconfig.build.json"],
    checks: [
      ["bun", "install", "--frozen-lockfile"],
      ["bun", "run", "typecheck"],
      ["bun", "test", "src/"],
      ["bun", "run", "build"],
    ],
  },
];

/** Tests are not shipped; a change to one is not a reason to release. */
const NOT_SHIPPED = [
  ":(exclude,glob)**/__tests__/**",
  ":(exclude,glob)**/__perf__/**",
  ":(exclude,glob)**/*.spec.ts",
];

// --- terminal --------------------------------------------------------------

const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;

/**
 * Files this run has rewritten (a version, a changelog heading) and what they
 * held before. Until the bump is committed they are put back on any exit, so
 * a failed check or a dry run leaves the working tree as it found it.
 */
const rewritten = new Map<string, string>();
function restore(): void {
  for (const [file, text] of rewritten) writeFileSync(file, text);
  rewritten.clear();
}

// Ctrl+C in the middle of the checks is an exit like any other.
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});

function die(message: string): never {
  const had = rewritten.size > 0;
  restore();
  console.error(`\n${red("✗")} ${message}`);
  if (had) console.error(dim("\n  The version bump was not kept: package.json is as it was."));
  console.error();
  process.exit(1);
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  die(`${(e as Error).message}  Try --help.`);
}

if (args.help) {
  console.log(`Release the packages that have something to release.

  A package is published when its version is not on npm yet, or when what it
  ships has changed since that version was released — in which case it needs a
  new version first, which this script sets.

  --dry-run          do everything except upload; put the working tree back
  --bump <how>       how to bump changed packages, instead of being asked:
                       minor                     every changed package
                       creo-edit=minor           one package (comma-separate more)
                       creo-edit=0.6.0           an exact version
  --only <name>      release just this package (by its npm name)
  --tag <tag>        npm dist-tag (default: latest)
  --otp <code>       one-time password for the first upload. Usually better
                     left out: npm asks for one when it uploads, by which
                     time a code typed at the start has expired.
  --skip-checks      do not typecheck / test first (still installs and builds)
  --no-commit        leave the version bump uncommitted
  --allow-dirty      run with uncommitted changes in the working tree
`);
  process.exit(0);
}

// --- running things --------------------------------------------------------

/** No step here should take this long. One that does is stuck, not slow. */
const STEP_TIMEOUT_MS = 15 * 60_000;

/** A command as it may be printed: a one-time password is nobody's to read. */
const printable = (cmd: string[]): string =>
  cmd.map((c, i) => (cmd[i - 1] === "--otp" ? "••••••" : c)).join(" ");

/** Run a command with its output on the terminal. Stops everything if it fails. */
async function run(cmd: string[], cwd: string): Promise<void> {
  console.log(dim(`  $ ${printable(cmd)}`));
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
  if (timedOut) {
    die(`\`${printable(cmd)}\` in ${cwd} did not finish in ${STEP_TIMEOUT_MS / 60_000} minutes and was stopped.`);
  }
  if (code !== 0) die(`\`${printable(cmd)}\` failed in ${cwd} (exit ${code}). Nothing after it was run.`);
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

// --- npm -------------------------------------------------------------------

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

// --- git: what changed since a package's last release ----------------------

type Change = { files: string[]; commits: number; manifest: boolean; since: string };

/**
 * What a package ships that differs from its last release, or null if
 * nothing does. The release is the commit that last touched the version line
 * of its package.json — which is how releases are made here ("0.5.0").
 */
async function changedSinceRelease(pkg: Pkg): Promise<Change | null> {
  const manifestPath = pkg.dir === "." ? "package.json" : `${pkg.dir}/package.json`;
  const rel = await capture([
    "git", "log", "-1", "--format=%H %s", "-G", '"version"[[:space:]]*:', "--", manifestPath,
  ]);
  if (!rel.ok || rel.out === "") {
    // No history to go by (a shallow clone). Saying "unchanged" could skip a
    // real release; saying "changed" only asks a question.
    return { files: [], commits: 0, manifest: false, since: "an unknown commit (no git history for its version)" };
  }
  const [commit, ...subject] = rel.out.split(" ");
  const paths = pkg.sources.map((s) => (pkg.dir === "." ? s : `${pkg.dir}/${s}`));
  const spec = [...paths, ...NOT_SHIPPED];
  // Against the working tree, not HEAD: an uncommitted edit is a change too.
  const diff = await capture(["git", "diff", "--name-only", commit!, "--", ...spec]);
  const files = diff.out === "" ? [] : diff.out.split("\n");
  const log = await capture(["git", "rev-list", "--count", `${commit}..HEAD`, "--", ...spec]);

  const then = await capture(["git", "show", `${commit}:${manifestPath}`]);
  const now = JSON.parse(readFileSync(resolve(root, manifestPath), "utf8")) as unknown;
  const manifest = then.ok ? manifestChanged(JSON.parse(then.out), now) : false;

  if (files.length === 0 && !manifest) return null;
  return {
    files,
    commits: Number(log.out) || 0,
    manifest,
    since: `${commit!.slice(0, 7)} "${subject.join(" ")}"`,
  };
}

// --- plan ------------------------------------------------------------------

type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  peerDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};

type Entry = Pkg & {
  abs: string;
  manifest: Manifest;
  state: "unpublished" | "changed" | "unchanged";
  change: Change | null;
  /** The version this run will publish, or null if it publishes none. */
  release: string | null;
};

const entries: Entry[] = [];
for (const pkg of PACKAGES) {
  const abs = resolve(root, pkg.dir);
  const manifest = JSON.parse(readFileSync(resolve(abs, "package.json"), "utf8")) as Manifest;
  if (manifest.private) continue;
  const published = await isPublished(manifest.name, manifest.version);
  const change = published ? await changedSinceRelease(pkg) : null;
  entries.push({
    ...pkg,
    abs,
    manifest,
    state: !published ? "unpublished" : change ? "changed" : "unchanged",
    change,
    release: null,
  });
}

const names = entries.map((e) => e.manifest.name).join(", ");
if (args.only && !entries.some((e) => e.manifest.name === args.only)) {
  die(`--only ${args.only}: no such package. Known: ${names}`);
}
for (const name of args.bump.keys()) {
  if (name !== "*" && !entries.some((e) => e.manifest.name === name)) {
    die(`--bump ${name}=…: no such package. Known: ${names}`);
  }
}

const selected = (e: Entry): boolean => !args.only || e.manifest.name === args.only;

console.log(bold(`\n${args.dryRun ? "Dry run — nothing will be uploaded, nothing kept" : "Release"}\n`));
for (const e of entries) {
  const id = `${e.manifest.name}@${e.manifest.version}`.padEnd(38);
  if (e.state === "unpublished") {
    console.log(`  ${id} ${green("not on npm yet")}`);
  } else if (e.state === "unchanged") {
    console.log(`  ${id} ${dim("on npm, nothing new — skipped")}`);
  } else {
    const c = e.change!;
    const what =
      c.files.length > 0
        ? `${c.files.length} file${c.files.length === 1 ? "" : "s"} in ${c.commits} commit${c.commits === 1 ? "" : "s"}`
        : "its package.json";
    console.log(`  ${id} ${yellow("on npm, but changed since")}`);
    console.log(dim(`      ${what} since ${c.since}`));
    for (const f of c.files.slice(0, 8)) console.log(dim(`      ${f}`));
    if (c.files.length > 8) console.log(dim(`      … and ${c.files.length - 8} more`));
    if (c.manifest) console.log(dim("      package.json: dependencies / exports / files"));
  }
}
console.log();

// --- a clean tree, before this run starts writing to it ---------------------

if (!args.allowDirty) {
  const status = await capture(["git", "status", "--porcelain"]);
  if (status.out !== "") {
    const list = status.out
      .split("\n")
      .slice(0, 12)
      .map((l) => `    ${l}`)
      .join("\n");
    // A rehearsal on a dirty tree is what a rehearsal is for.
    if (args.dryRun) console.log(`${dim("note:")} the working tree has uncommitted changes:\n${list}\n`);
    else {
      die(
        `The working tree has uncommitted changes:\n\n${list}\n\n` +
          "  What gets published should be what is committed. Commit or stash, or pass --allow-dirty.",
      );
    }
  }
}

// --- new versions for what changed -----------------------------------------

/** Ranges that other packages here place on `name`. */
const rangesOn = (name: string): string[] =>
  entries
    .filter((o) => o.manifest.name !== name)
    .map((o) => ({ ...o.manifest.peerDependencies, ...o.manifest.dependencies })[name])
    .filter((r): r is string => !!r);

for (const e of entries) {
  if (!selected(e)) continue;
  if (e.state === "unpublished") {
    e.release = e.manifest.version;
    continue;
  }
  if (e.state !== "changed") continue;

  const { name, version } = e.manifest;
  const ranges = rangesOn(name);
  const suggested = suggestBump(version, ranges, (v, r) => Bun.semver.satisfies(v, r));
  let how = args.bump.get(name) ?? args.bump.get("*");

  if (how === undefined) {
    if (!process.stdin.isTTY) {
      die(
        `${name}@${version} has changed since it was released, so it needs a new version.\n\n` +
          `  Say which, for example:  --bump ${name}=${suggested}` +
          `   (${suggested} → ${bumpVersion(version, suggested)})\n` +
          "  or run this in a terminal to be asked.",
      );
    }
    console.log(bold(`${name} ${version} → ?`));
    for (const level of BUMP_LEVELS) {
      const mark = level === suggested ? green("  ← suggested") : "";
      console.log(`  ${level.padEnd(6)} ${bumpVersion(version, level)}${mark}`);
    }
    if (ranges.length > 0) console.log(dim(`  (other packages here need ${name} ${ranges.join(", ")})`));
    for (;;) {
      const typed = prompt(`  patch / minor / major, a version, or skip [${suggested}]:`);
      const answer = (typed ?? "").trim() || suggested;
      if (answer === "skip" || isBumpLevel(answer) || isVersion(answer)) {
        how = answer;
        break;
      }
      console.log(red(`  "${answer}" is not one of those.`));
    }
    console.log();
    if (how === "skip") continue;
  }

  const next = resolveBump(version, how);
  if (!isVersion(next) || Bun.semver.order(next, version) <= 0) {
    die(`${name}: ${next} is not newer than ${version}.`);
  }
  if (await isPublished(name, next)) die(`${name}@${next} is already on npm. Pick a higher version.`);
  e.release = next;
}

const todo = entries.filter((e) => e.release !== null);
if (todo.length === 0) {
  console.log("Nothing to release: npm has every package here as it stands.\n");
  process.exit(0);
}

// A package here that depends on another one here: the range has to be
// satisfiable by what will be on npm when this run is done — the version
// going out now, or the newest already there. Otherwise it installs for
// nobody.
for (const e of todo) {
  const needs = { ...e.manifest.peerDependencies, ...e.manifest.dependencies };
  for (const other of entries) {
    const range = needs[other.manifest.name];
    if (!range) continue;
    const remote = await latestOnNpm(other.manifest.name);
    const candidates = [other.release, remote].filter((v): v is string => !!v);
    if (candidates.some((v) => Bun.semver.satisfies(v, range))) continue;
    const held = other.state === "changed" && other.release === null;
    die(
      `${e.manifest.name}@${e.release} needs ${other.manifest.name} ${range}, but npm's newest is ${remote ?? "nothing"}` +
        (held
          ? `,\n    and ${other.manifest.name} — which has unreleased changes — is not being released in this run` +
            (args.only ? " (--only)." : " (skipped).")
          : other.release
            ? `\n    and this run would publish ${other.manifest.name}@${other.release}.`
            : ".") +
        `\n\n  Release a ${other.manifest.name} that satisfies ${range} in the same run` +
        (args.only ? " (drop --only)" : "") +
        `, or change the range in ${e.dir}/package.json.`,
    );
  }
}

console.log(bold("This run:"));
for (const e of todo) {
  const from = e.release === e.manifest.version ? "" : dim(`  (was ${e.manifest.version})`);
  console.log(`  ${green("publish")} ${e.manifest.name}@${e.release}${from}`);
}
console.log();

if (!args.dryRun) {
  const who = await capture(["npm", "whoami"]);
  if (!who.ok) die("Not logged in to npm. Run `npm login` first.");
  console.log(`Logged in to npm as ${bold(who.out)}.\n`);
}

// --- write the new versions -------------------------------------------------

const rewrite = (file: string, next: string): void => {
  if (!rewritten.has(file)) rewritten.set(file, readFileSync(file, "utf8"));
  writeFileSync(file, next);
};

const bumped = todo.filter((e) => e.release !== e.manifest.version);
for (const e of bumped) {
  const manifestFile = resolve(e.abs, "package.json");
  rewrite(manifestFile, setManifestVersion(readFileSync(manifestFile, "utf8"), e.release!));
  // The changelog's "Unreleased" section is this release's.
  const changelog = resolve(e.abs, "CHANGELOG.md");
  if (existsSync(changelog)) {
    const next = releaseChangelog(readFileSync(changelog, "utf8"), e.release!);
    if (next !== null) rewrite(changelog, next);
  }
}
const bumpFiles = [...rewritten.keys()];

// --- half one: everything is checked and built before anything is uploaded --

for (const e of entries) {
  const publishing = todo.includes(e);
  // A package that is not going out may still have to be BUILT: a later one
  // (the plugin) type-checks against its output.
  const neededLater = entries.slice(entries.indexOf(e) + 1).some((later) => todo.includes(later));
  if (!publishing && !neededLater) continue;

  console.log(
    bold(`\n— check ${e.manifest.name}@${e.release ?? e.manifest.version}`) +
      (publishing ? "" : dim("  (building only: a later package needs it)")),
  );
  const steps =
    publishing && !args.skipChecks
      ? e.checks
      : e.checks.filter((c) => c.includes("install") || c.includes("build"));
  for (const step of steps) await run(step, e.abs);
}

// --- the bump becomes a commit ----------------------------------------------

// Before the upload, so that what is on npm is what is committed. If an
// upload then fails, the commit stands and running this again publishes it:
// the version is in package.json and not on npm, which is "unpublished".
let committed: string | null = null;
if (!args.dryRun && bumped.length > 0) {
  if (args.noCommit) {
    // Kept in the working tree, as asked — not something to put back.
    rewritten.clear();
  } else {
    // One package, and it is the editor: its version alone, as "0.5.0" was.
    const message =
      bumped.length === 1 && bumped[0]!.dir === "."
        ? bumped[0]!.release!
        : bumped.map((e) => `${e.manifest.name}@${e.release}`).join(", ");
    console.log(bold(`\n— commit "${message}"`));
    await run(["git", "add", "--", ...bumpFiles], root);
    await run(["git", "commit", "-m", message, "--", ...bumpFiles], root);
    committed = message;
    // From here the bump is history.
    rewritten.clear();
  }
}

// --- half two: upload, back to back -----------------------------------------

const done: string[] = [];
let otp = args.otp;
for (const e of todo) {
  console.log(bold(`\n— publish ${e.manifest.name}@${e.release}`));
  const publish = ["npm", "publish", "--access", "public"];
  if (args.dryRun) publish.push("--dry-run");
  if (args.tag) publish.push("--tag", args.tag);
  // A code is good for one upload's worth of seconds. It goes to the first;
  // for the rest npm asks, as it does when none was given at all.
  if (otp && !args.dryRun) {
    publish.push("--otp", otp);
    otp = undefined;
  }
  await run(publish, e.abs);
  done.push(`${e.manifest.name}@${e.release}`);
}

restore();

console.log(
  `\n${green("✓")} ${args.dryRun ? "Dry run complete. Would have published" : "Published"}: ${done.join(", ")}`,
);
if (args.dryRun && bumped.length > 0) {
  console.log(dim("  The version bump was for the rehearsal only; package.json is as it was."));
}
if (committed) console.log(`  The bump is committed as "${committed}". Push it when you are ready: git push`);
if (!args.dryRun && args.noCommit && bumped.length > 0) {
  console.log(yellow("  The version bump is in the working tree, uncommitted (--no-commit)."));
}
console.log();
