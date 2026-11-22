import { describe, expect, it } from "bun:test";
import {
  bumpVersion,
  manifestChanged,
  parseArgs,
  releaseChangelog,
  resolveBump,
  setManifestVersion,
  suggestBump,
} from "../../scripts/release-lib";

// The release script's decisions, apart from the git / npm / terminal it
// makes them with (`scripts/publish.ts`). No DOM here, so no `./setup`.

describe("release script — arguments", () => {
  it("reads a value given either way round", () => {
    // `--otp=366982` was how the script was first run for real, and the first
    // version only understood `--otp 366982`: the code was dropped silently.
    expect(parseArgs(["--otp=366982"]).otp).toBe("366982");
    expect(parseArgs(["--otp", "366982"]).otp).toBe("366982");
    expect(parseArgs(["--only=creo-edit", "--tag", "next"])).toMatchObject({ only: "creo-edit", tag: "next" });
  });

  it("refuses what it does not understand instead of ignoring it", () => {
    expect(() => parseArgs(["--opt=1"])).toThrow(/Unknown option --opt/);
    expect(() => parseArgs(["minor"])).toThrow(/Unexpected argument/);
    expect(() => parseArgs(["--otp"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--otp", "--dry-run"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--dry-run=yes"])).toThrow(/takes no value/);
  });

  it("flags default to off", () => {
    const a = parseArgs([]);
    expect([a.dryRun, a.skipChecks, a.allowDirty, a.noCommit, a.help]).toEqual([false, false, false, false, false]);
    expect(parseArgs(["--dry-run", "--no-commit", "-h"])).toMatchObject({ dryRun: true, noCommit: true, help: true });
  });

  it("--bump: one level for everything, or per package, or an exact version", () => {
    expect([...parseArgs(["--bump", "minor"]).bump]).toEqual([["*", "minor"]]);
    expect([...parseArgs(["--bump=creo-edit=minor,creo-edit-mermaid-plugin=0.2.0"]).bump]).toEqual([
      ["creo-edit", "minor"],
      ["creo-edit-mermaid-plugin", "0.2.0"],
    ]);
    // A scoped name has an `=`-free `@`, and the LAST `=` is the separator.
    expect([...parseArgs(["--bump", "@scope/pkg=patch"]).bump]).toEqual([["@scope/pkg", "patch"]]);
    expect(() => parseArgs(["--bump", "big"])).toThrow(/not patch, minor, major or a version/);
    expect(() => parseArgs(["--bump", "creo-edit=1.x"])).toThrow(/not patch, minor, major or a version/);
  });
});

describe("release script — versions", () => {
  it("bumps", () => {
    expect(bumpVersion("0.5.0", "patch")).toBe("0.5.1");
    expect(bumpVersion("0.5.3", "minor")).toBe("0.6.0");
    expect(bumpVersion("0.5.3", "major")).toBe("1.0.0");
    expect(bumpVersion("1.2.3-rc.1", "patch")).toBe("1.2.4");
    expect(() => bumpVersion("next", "patch")).toThrow();
  });

  it("an answer is a level or an exact version", () => {
    expect(resolveBump("0.5.0", "minor")).toBe("0.6.0");
    expect(resolveBump("0.5.0", "0.7.0")).toBe("0.7.0");
  });

  it("suggests the smallest bump that the other packages can live with", () => {
    const satisfies = (v: string, r: string): boolean => Bun.semver.satisfies(v, r);
    // The plugin asks for an editor >=0.6.0 and the editor is at 0.5.0: a
    // patch release would leave the plugin uninstallable.
    expect(suggestBump("0.5.0", [">=0.6.0"], satisfies)).toBe("minor");
    expect(suggestBump("0.6.0", [">=0.6.0"], satisfies)).toBe("patch");
    expect(suggestBump("0.5.0", [], satisfies)).toBe("patch");
    expect(suggestBump("0.5.0", [">=1.0.0"], satisfies)).toBe("major");
    // Nothing satisfies: say patch, and let the range check report the rest.
    expect(suggestBump("0.5.0", [">=3.0.0"], satisfies)).toBe("patch");
  });
});

describe("release script — the files a bump touches", () => {
  it("sets the version without reformatting package.json", () => {
    const text = '{\n  "name": "x",\n  "version": "0.5.0",\n  "dependencies": { "y": "0.5.0" }\n}\n';
    expect(setManifestVersion(text, "0.6.0")).toBe(
      '{\n  "name": "x",\n  "version": "0.6.0",\n  "dependencies": { "y": "0.5.0" }\n}\n',
    );
    expect(() => setManifestVersion('{ "name": "x" }', "1.0.0")).toThrow(/no version field/);
  });

  it("turns the changelog's Unreleased heading into the release's", () => {
    const log = "# Changelog\n\n## Unreleased\n\nNew things.\n\n## 0.5.0\n\nOld things.\n";
    expect(releaseChangelog(log, "0.6.0")).toBe("# Changelog\n\n## 0.6.0\n\nNew things.\n\n## 0.5.0\n\nOld things.\n");
    expect(releaseChangelog("# Changelog\n\n## 0.5.0\n", "0.6.0")).toBeNull();
    // A sentence that mentions the word is not the heading.
    expect(releaseChangelog("Unreleased work is listed below.\n", "0.6.0")).toBeNull();
  });

  it("a package.json change counts only if someone installing it would see it", () => {
    const base = { name: "x", version: "1.0.0", scripts: { a: "b" }, dependencies: { y: "^1" } };
    expect(manifestChanged(base, { ...base, scripts: { a: "b", release: "c" } })).toBe(false);
    expect(manifestChanged(base, { ...base, version: "1.0.1" })).toBe(false);
    expect(manifestChanged(base, { ...base, dependencies: { y: "^2" } })).toBe(true);
    expect(manifestChanged(base, { ...base, peerDependenciesMeta: { z: { optional: true } } })).toBe(true);
    expect(manifestChanged(base, { ...base, exports: { ".": "./dist/index.js" } })).toBe(true);
  });
});
