// ---------------------------------------------------------------------------
// The parts of the release script that are plain functions of their input —
// kept apart from `publish.ts` (which talks to git, npm and the terminal) so
// they can be tested. `src/__tests__/releaseScript.spec.ts` is that test.
// ---------------------------------------------------------------------------

export type BumpLevel = "patch" | "minor" | "major";
export const BUMP_LEVELS: readonly BumpLevel[] = ["patch", "minor", "major"];

export type Args = {
  dryRun: boolean;
  help: boolean;
  /** Publish just this package (by npm name). */
  only?: string;
  /** npm dist-tag. */
  tag?: string;
  /** One-time password for the first upload. */
  otp?: string;
  skipChecks: boolean;
  allowDirty: boolean;
  /** Leave the version bump uncommitted. */
  noCommit: boolean;
  /**
   * How to bump packages that have changed: a level or an exact version per
   * package name, and/or one under "*" for every changed package not named.
   */
  bump: Map<string, string>;
};

const BOOLEAN_FLAGS: Record<string, keyof Args> = {
  "dry-run": "dryRun",
  help: "help",
  "skip-checks": "skipChecks",
  "allow-dirty": "allowDirty",
  "no-commit": "noCommit",
};
const VALUE_FLAGS = new Set(["only", "tag", "otp", "bump"]);

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export const isVersion = (s: string): boolean => VERSION.test(s);
export const isBumpLevel = (s: string): s is BumpLevel =>
  (BUMP_LEVELS as readonly string[]).includes(s);

/**
 * Parse the command line. Both `--flag value` and `--flag=value` are
 * accepted, and anything not understood is an error rather than ignored:
 * the first version of this script read `--otp 123456` but not
 * `--otp=123456`, and quietly ran without the code it had been given.
 */
export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    dryRun: false,
    help: false,
    skipChecks: false,
    allowDirty: false,
    noCommit: false,
    bump: new Map(),
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === "-h") {
      args.help = true;
      continue;
    }
    if (!raw.startsWith("--")) throw new Error(`Unexpected argument "${raw}".`);
    const eq = raw.indexOf("=");
    const name = raw.slice(2, eq < 0 ? undefined : eq);
    const inline = eq < 0 ? undefined : raw.slice(eq + 1);

    const bool = BOOLEAN_FLAGS[name];
    if (bool) {
      if (inline !== undefined) throw new Error(`--${name} takes no value.`);
      (args[bool] as boolean) = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown option --${name}.`);

    let val = inline;
    if (val === undefined) {
      val = argv[++i];
      if (val === undefined || val.startsWith("--")) throw new Error(`--${name} needs a value.`);
    }
    if (val === "") throw new Error(`--${name} needs a value.`);

    if (name === "bump") {
      // `minor`, or `creo-edit=minor,other=0.2.0`; may be given more than once.
      for (const part of val.split(",")) {
        const at = part.lastIndexOf("=");
        const pkg = at < 0 ? "*" : part.slice(0, at);
        const how = at < 0 ? part : part.slice(at + 1);
        if (!pkg || !(isBumpLevel(how) || isVersion(how))) {
          throw new Error(
            `--bump ${val}: "${part}" is not patch, minor, major or a version (optionally as name=…).`,
          );
        }
        args.bump.set(pkg, how);
      }
    } else {
      args[name as "only" | "tag" | "otp"] = val;
    }
  }
  return args;
}

/** `0.5.0` + `minor` → `0.6.0`. A prerelease suffix is dropped. */
export function bumpVersion(version: string, level: BumpLevel): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) throw new Error(`"${version}" is not a version this script can bump.`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Turn a `--bump` answer (a level or an exact version) into a version. */
export function resolveBump(current: string, how: string): string {
  return isBumpLevel(how) ? bumpVersion(current, how) : how;
}

/**
 * The smallest bump whose result satisfies every range other packages in this
 * repository place on this one — so a plugin that asks for `creo-edit >=0.6.0`
 * makes "minor" the suggestion for an editor at 0.5.0. Patch when nothing
 * constrains it, or nothing satisfies.
 */
export function suggestBump(
  current: string,
  ranges: readonly string[],
  satisfies: (version: string, range: string) => boolean,
): BumpLevel {
  for (const level of BUMP_LEVELS) {
    const next = bumpVersion(current, level);
    if (ranges.every((r) => satisfies(next, r))) return level;
  }
  return "patch";
}

/** Replace the version in a package.json's text, leaving its formatting alone. */
export function setManifestVersion(text: string, version: string): string {
  let done = false;
  const out = text.replace(/("version"\s*:\s*")[^"]*(")/, (_, a: string, b: string) => {
    done = true;
    return `${a}${version}${b}`;
  });
  if (!done) throw new Error("package.json has no version field to bump.");
  return out;
}

/**
 * A changelog's `## Unreleased` heading becomes the version being released.
 * Returns null when there is no such heading (nothing to do).
 */
export function releaseChangelog(text: string, version: string): string | null {
  // Spaces and tabs only: `\s` would take the blank line after the heading too.
  const re = /^##[ \t]+Unreleased[ \t]*$/m;
  return re.test(text) ? text.replace(re, `## ${version}`) : null;
}

/** The fields of a package.json that end up mattering to whoever installs it. */
const SHIPPED_FIELDS = [
  "dependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "optionalDependencies",
  "exports",
  "main",
  "module",
  "types",
  "files",
  "bin",
  "sideEffects",
  "type",
] as const;

/**
 * Whether two versions of a package.json differ in a way a consumer would
 * see. A new entry under `scripts` is not a reason to release; a changed
 * dependency range is.
 */
export function manifestChanged(before: unknown, after: unknown): boolean {
  const a = (before ?? {}) as Record<string, unknown>;
  const b = (after ?? {}) as Record<string, unknown>;
  return SHIPPED_FIELDS.some((f) => JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null));
}
