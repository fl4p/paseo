import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  areEquivalentPaths,
  createPathEquivalenceMatcher,
  createRealpathAwarePathMatcher,
  getRealpathAwareRelativePath,
  isPathInsideRoot,
  isSameRealDirectory,
} from "./path.js";

describe("path equivalence", () => {
  test.each([
    ["C:/Users/Administrator/GhostFactory", "C:\\Users\\Administrator\\GhostFactory"],
    ["d:\\Projects\\paseo", "D:\\Projects\\paseo"],
    ["C:\\Users\\Administrator\\GhostFactory\\", "C:\\Users\\Administrator\\GhostFactory"],
    [String.raw`\\?\C:\Users\Administrator\GhostFactory`, "C:\\Users\\Administrator\\GhostFactory"],
    [String.raw`\\?\UNC\server\share\GhostFactory`, String.raw`\\server\share\GhostFactory`],
  ])("matches Windows-equivalent cwd forms", (left, right) => {
    expect(areEquivalentPaths(left, right)).toBe(true);
    expect(createPathEquivalenceMatcher(left)(right)).toBe(true);
  });

  test("keeps POSIX path casing significant", () => {
    expect(
      areEquivalentPaths("/Users/Administrator/GhostFactory", "/users/administrator/ghostfactory"),
    ).toBe(false);
  });

  test("checks POSIX root containment without prefix false positives", () => {
    expect(isPathInsideRoot("/opt/paseo", "/opt/paseo/node_modules/@getpaseo/server")).toBe(true);
    expect(isPathInsideRoot("/opt/paseo", "/opt/paseo-other")).toBe(false);
  });

  test("checks Windows root containment case-insensitively", () => {
    expect(
      isPathInsideRoot("C:\\Paseo\\node_modules", "c:/paseo/node_modules/@getpaseo/server"),
    ).toBe(true);
    expect(isPathInsideRoot("C:\\Paseo\\node_modules", "C:\\Paseo\\node_modules-other")).toBe(
      false,
    );
  });

  test("preserves the casing of Windows relative suffixes", () => {
    expect(getRealpathAwareRelativePath("C:\\Repo\\.git", "c:\\repo\\.git\\HEAD")).toBe("HEAD");
    expect(
      getRealpathAwareRelativePath("C:\\Repo\\.git", "c:\\repo\\.git\\refs\\heads\\FeatureCase"),
    ).toBe("refs\\heads\\FeatureCase");
  });

  test.skipIf(process.platform === "win32")(
    "derives the contained suffix from a realpath-equivalent root",
    () => {
      const tempDir = mkdtempSync(join(tmpdir(), "paseo-path-"));
      try {
        const realRoot = join(tempDir, "real-root");
        const nestedPath = join(realRoot, "packages", "app");
        const aliasRoot = join(tempDir, "root-alias");
        mkdirSync(nestedPath, { recursive: true });
        symlinkSync(realRoot, aliasRoot, "dir");

        expect(getRealpathAwareRelativePath(aliasRoot, nestedPath)).toBe(join("packages", "app"));
        expect(getRealpathAwareRelativePath(aliasRoot, tempDir)).toBeNull();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});

describe("strict directory identity", () => {
  const withTempDir = (run: (tempDir: string) => void): void => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "paseo-identity-")));
    try {
      run(tempDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  };

  test.skipIf(process.platform === "win32")(
    "refuses a path whose real directory escapes through a symlink",
    () => {
      withTempDir((tempDir) => {
        const source = join(tempDir, "source");
        const other = join(tempDir, "other", "child");
        mkdirSync(source, { recursive: true });
        mkdirSync(other, { recursive: true });
        symlinkSync(other, join(source, "link"), "dir");

        // Built as a string on purpose: `join` would collapse `link/..`
        // lexically and destroy the case under test.
        const escaped = `${source}/link/..`;
        // The permissive matcher used for cwd filtering accepts this, because
        // the LEXICAL spelling of the candidate normalizes to `source`.
        expect(createRealpathAwarePathMatcher(source)(escaped)).toBe(true);
        // Its real directory is `tempDir/other`, so strict identity refuses it.
        // (`realpathSync.native` is the honest resolver here: node's JS
        // realpath resolves `path.resolve` first, so it collapses `link/..`
        // lexically and answers `source` — the same mistake being fixed.)
        expect(realpathSync.native(escaped)).toBe(join(tempDir, "other"));
        expect(isSameRealDirectory(source, escaped)).toBe(false);
      });
    },
  );

  test.skipIf(process.platform === "win32")("accepts the spellings that really are equal", () => {
    withTempDir((tempDir) => {
      const source = join(tempDir, "source");
      mkdirSync(source, { recursive: true });
      const alias = join(tempDir, "alias");
      symlinkSync(source, alias, "dir");

      expect(isSameRealDirectory(source, `${source}/`)).toBe(true);
      expect(isSameRealDirectory(source, `${source}/./`)).toBe(true);
      expect(isSameRealDirectory(source, `${source}/../source`)).toBe(true);
      expect(isSameRealDirectory(source, alias)).toBe(true);

      const swappedCase = join(tempDir, "SOURCE");
      if (existsSync(swappedCase)) {
        // Only meaningful where the filesystem folds case; elsewhere this
        // really is a different (missing) directory.
        expect(isSameRealDirectory(source, swappedCase)).toBe(true);
      }
    });
  });

  test("refuses a directory that cannot be resolved, including against itself", () => {
    withTempDir((tempDir) => {
      const missing = join(tempDir, "gone");
      expect(isSameRealDirectory(missing, missing)).toBe(false);
      expect(isSameRealDirectory(tempDir, missing)).toBe(false);
    });
  });

  test.skipIf(process.platform === "win32")("keeps a second worktree distinct", () => {
    withTempDir((tempDir) => {
      const main = join(tempDir, "repo");
      const worktree = join(tempDir, "repo-worktree");
      mkdirSync(main, { recursive: true });
      mkdirSync(worktree, { recursive: true });
      expect(isSameRealDirectory(main, worktree)).toBe(false);
    });
  });
});
