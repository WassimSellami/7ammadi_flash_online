import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CORE_SRC = join(process.cwd(), "packages", "core", "src");

function collect(path: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path)) {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) files.push(...collect(full));
    else if (full.endsWith(".ts")) files.push(full);
  }
  return files;
}

const BANNED: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /Math\.random\s*\(/, reason: "non-deterministic RNG" },
  { pattern: /Date\.now\s*\(/, reason: "wall clock" },
  { pattern: /performance\.now\s*\(/, reason: "wall clock" },
  { pattern: /\bsetTimeout\s*\(/, reason: "timers belong to adapters" },
  { pattern: /\bsetInterval\s*\(/, reason: "timers belong to adapters" },
  { pattern: /from\s+["']node:/, reason: "Node-only import in the shared core" },
  { pattern: /\bwindow\s*\./, reason: "browser globals in the shared core" },
  { pattern: /\bdocument\s*\./, reason: "browser globals in the shared core" },
  { pattern: /\blocalStorage\s*\./, reason: "storage belongs to adapters" },
];

describe("core purity", () => {
  it("does not reference clocks, randomness, storage or host globals", () => {
    const failures: string[] = [];
    for (const file of collect(CORE_SRC)) {
      const text = readFileSync(file, "utf8");
      for (const rule of BANNED) {
        if (rule.pattern.test(text)) {
          failures.push(`${file}: ${rule.reason} (${rule.pattern})`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
