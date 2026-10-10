import { describe, expect, it } from "vitest";
import { diffLines, hasChanges } from "./diff.ts";

describe("diffLines", () => {
  it("marks added and removed lines and folds unchanged runs", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].join("\n");
    const after = ["a", "b", "c", "d", "E", "f", "g", "h", "i", "j"].join("\n");
    expect(diffLines(before, after, 1)).toEqual([
      { kind: "skip", count: 3 },
      { kind: "same", text: "d" },
      { kind: "added", text: "E" },
      { kind: "removed", text: "e" },
      { kind: "same", text: "f" },
      { kind: "skip", count: 2 },
      { kind: "same", text: "i" },
      { kind: "added", text: "j" },
    ]);
  });

  it("says when nothing changed", () => {
    expect(hasChanges(diffLines("x\ny", "x\ny"))).toBe(false);
    expect(diffLines("", "new")).toEqual([{ kind: "added", text: "new" }]);
  });
});
