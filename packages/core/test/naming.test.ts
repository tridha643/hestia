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
  test("always includes a collision-safe identity hash", () => {
    expect(projectName("repo-a", "modem", "salem", "/wt/salem"))
      .toMatch(/^modem-salem-[0-9a-f]{10}$/);
  });

  test("is deterministic for the same worktree", () => {
    const a = projectName("repo-a", "modem", "feat/auth", "/wt/a");
    const b = projectName("repo-a", "modem", "feat/auth", "/wt/a");
    expect(a).toBe(b);
    expect(a).toMatch(/^modem-feat-auth-[0-9a-f]{10}$/);
  });

  test("distinct branches of one repo do not collide", () => {
    const a = projectName("repo-a", "modem", "branch-a", "/wt/a");
    const b = projectName("repo-a", "modem", "branch-b", "/wt/b");
    expect(a).not.toBe(b);
  });

  test("keeps the readable prefix bounded", () => {
    const long = "this-is-a-very-long-branch-name-that-exceeds-the-cap";
    const name = projectName("repo-a", "modem", long, "/wt/x");
    expect(name.startsWith("modem-this-is-a-very-long-bran")).toBe(true);
    expect(name).toMatch(/-[0-9a-f]{10}$/);
    // stable across calls
    expect(projectName("repo-a", "modem", long, "/wt/x")).toBe(name);
    // different worktree with the same truncated name -> different hash
    expect(projectName("repo-a", "modem", long, "/wt/y")).not.toBe(name);
  });

  test("separates same-name clones and normalized branch collisions", () => {
    expect(projectName("repo-a", "modem", "feat/a", "/wt/a"))
      .not.toBe(projectName("repo-b", "modem", "feat/a", "/wt/a"));
    expect(projectName("repo-a", "modem", "feat/a", "/wt/a"))
      .not.toBe(projectName("repo-a", "modem", "feat-a", "/wt/a"));
  });

  test("result always matches the compose project regex", () => {
    const name = projectName("repo-a", "Weird Repo!", "feature/#42", "/wt/z");
    expect(name).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
  });
});
