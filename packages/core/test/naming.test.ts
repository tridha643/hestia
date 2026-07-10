import { expect, test, describe } from "bun:test";
import { slug, projectName } from "../src/naming.ts";

describe("slug", () => {
  test("lowercases and dashes non-alphanumerics", () => {
    expect(slug("feat/foo_bar")).toBe("feat-foo-bar");
    expect(slug("Salem")).toBe("salem");
  });

  test("collapses runs and trims edge dashes", () => {
    expect(slug("--a//__b--")).toBe("a-b");
    expect(slug("a   b")).toBe("a-b");
  });

  test("guarantees a leading alphanumeric", () => {
    expect(slug("/leading")).toBe("leading"); // leading separator trimmed
    expect(slug("")).toBe("x"); // empty gets a safe prefix
    expect(slug("!!!")).toBe("x"); // all-symbol collapses to empty then prefixed
    expect(slug("123")).toBe("123");
  });
});

describe("projectName", () => {
  test("is repo-branch for short names, no hash", () => {
    expect(projectName("modem", "salem", "/wt/salem")).toBe("modem-salem");
  });

  test("is deterministic for the same worktree", () => {
    const a = projectName("modem", "feat/auth", "/wt/a");
    const b = projectName("modem", "feat/auth", "/wt/a");
    expect(a).toBe(b);
    expect(a).toBe("modem-feat-auth");
  });

  test("distinct branches of one repo do not collide", () => {
    const a = projectName("modem", "branch-a", "/wt/a");
    const b = projectName("modem", "branch-b", "/wt/b");
    expect(a).not.toBe(b);
  });

  test("appends a stable hash when a name is truncated", () => {
    const long = "this-is-a-very-long-branch-name-that-exceeds-the-cap";
    const name = projectName("modem", long, "/wt/x");
    expect(name.startsWith("modem-this-is-a-very-long-bran")).toBe(true);
    expect(name).toMatch(/-[0-9a-f]{6}$/);
    // stable across calls
    expect(projectName("modem", long, "/wt/x")).toBe(name);
    // different worktree with the same truncated name -> different hash
    expect(projectName("modem", long, "/wt/y")).not.toBe(name);
  });

  test("result always matches the compose project regex", () => {
    const name = projectName("Weird Repo!", "feature/#42", "/wt/z");
    expect(name).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
  });
});
