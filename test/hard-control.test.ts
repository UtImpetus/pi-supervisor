import { describe, expect, it } from "vitest";
import {
  evaluateToolCallAgainstConstraints,
  extractHardConstraints,
  formatActiveConstraints,
  mergeHardConstraints,
} from "../src/hard-control.js";

describe("hard supervisor constraints", () => {
  it("extracts forbidden paths, allowed scopes, and git-state bans from user text", () => {
    const constraints = extractHardConstraints(
      "Do not touch web_common/. Only edit web/src/main.rs. Do not use git stash or checkout.",
      123,
    );

    expect(constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "forbid-path", pattern: "web_common/" }),
        expect.objectContaining({ kind: "allow-only-path", pattern: "web/src/main.rs" }),
        expect.objectContaining({ kind: "forbid-git" }),
      ]),
    );
  });

  it("blocks edits to a forbidden path", () => {
    const constraints = extractHardConstraints("Do not touch web_common/.");
    const decision = evaluateToolCallAgainstConstraints(
      "edit",
      { path: "web_common/src/webdav_service.rs", edits: [] },
      constraints,
      "/repo",
    );

    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("web_common/");
  });

  it("blocks writes outside an allow-only path", () => {
    const constraints = extractHardConstraints("Only edit web/src/main.rs.");
    const decision = evaluateToolCallAgainstConstraints(
      "write",
      { path: "web_common/src/webdav_service.rs", content: "x" },
      constraints,
      "/repo",
    );

    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("web/src/main.rs");
  });

  it("allows writes inside an allow-only directory", () => {
    const constraints = extractHardConstraints("Only edit web/src/.");
    const decision = evaluateToolCallAgainstConstraints(
      "edit",
      { path: "web/src/main.rs", edits: [] },
      constraints,
      "/repo",
    );

    expect(decision).toBeNull();
  });

  it("blocks dangerous git state mutations", () => {
    const constraints = extractHardConstraints("Do not use git stash or checkout.");
    const decision = evaluateToolCallAgainstConstraints(
      "bash",
      { command: "git stash && cargo test" },
      constraints,
      "/repo",
    );

    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("git state mutation");
  });

  it("blocks git history and remote mutations under git-state bans", () => {
    const constraints = extractHardConstraints("Do not use git stash or checkout.");

    for (const command of ["git add .", "git commit -m test", "git push", "git rebase main"]) {
      const decision = evaluateToolCallAgainstConstraints("bash", { command }, constraints, "/repo");
      expect(decision?.block, command).toBe(true);
    }
  });

  it("formats active constraints for prompt injection", () => {
    const constraints = mergeHardConstraints([], extractHardConstraints("Do not touch web_common/."));
    const formatted = formatActiveConstraints(constraints);

    expect(formatted).toContain("ACTIVE SUPERVISOR HARD CONSTRAINTS");
    expect(formatted).toContain("Forbidden path: web_common/");
  });
});
