import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ./gradlew must run from any clone: executable, and LF even where the
// system git has core.autocrlf=true (this Windows machine does).
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const GRADLEW = "app/android/gradlew";

function git(...args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  } catch {
    return null;
  }
}

const entry = git("ls-files", "-s", "--", GRADLEW);

describe.skipIf(!entry)("gradlew in git", () => {
  it("is executable", () => {
    expect(entry).toMatch(/^100755 /);
  });

  it("is checked out with LF line endings on every OS", () => {
    expect(git("check-attr", "eol", "--", GRADLEW)).toContain(`${GRADLEW}: eol: lf`);
  });
});
