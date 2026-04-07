import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const skillPath = resolve(__dirname, "../skills/clerk-manage/SKILL.md");

describe("clerk-manage skill", () => {
  const content = readFileSync(skillPath, "utf-8");

  it("exists and is readable", () => {
    expect(content).toBeTruthy();
  });

  it("has valid frontmatter with name field", () => {
    expect(content).toMatch(/^---\n[\s\S]*?name:\s*clerk-manage[\s\S]*?---/);
  });

  it("has valid frontmatter with description field", () => {
    expect(content).toMatch(
      /^---\n[\s\S]*?description:\s*.+[\s\S]*?---/
    );
  });

  it("references clerk agent list command", () => {
    expect(content).toContain("clerk agent list");
  });

  it("references clerk agent start command", () => {
    expect(content).toContain("clerk agent start");
  });

  it("references clerk agent stop command", () => {
    expect(content).toContain("clerk agent stop");
  });

  it("references clerk agent restart command", () => {
    expect(content).toContain("clerk agent restart");
  });

  it("references clerk memory search command", () => {
    expect(content).toContain("clerk memory search");
  });

  it("references clerk vault list command", () => {
    expect(content).toContain("clerk vault list");
  });

  it("references clerk topics list command", () => {
    expect(content).toContain("clerk topics list");
  });
});
