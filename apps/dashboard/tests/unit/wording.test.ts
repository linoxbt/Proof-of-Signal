// Hard design rule: certain accusatory words never appear in the UI. The
// pattern is assembled from pieces so this file does not contain them.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const BANNED = new RegExp(["rig" + "ging", "fra" + "ud", "suspi" + "cious"].join("|"), "i");
const root = path.resolve(import.meta.dirname, "../..");

function files(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, exts));
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

function offenders(paths: string[]): string[] {
  return paths.filter((p) => BANNED.test(readFileSync(p, "utf8"))).map((p) => path.relative(root, p));
}

describe("banned words", () => {
  it("are not in any message file", () => {
    expect(offenders(files(path.join(root, "messages"), [".json"]))).toEqual([]);
  });

  it("are not in the source", () => {
    expect(offenders(files(path.join(root, "src"), [".ts", ".tsx", ".css"]))).toEqual([]);
  });

  it("are not in the built output (run after `npm run build`)", () => {
    const next = path.join(root, ".next");
    if (!existsSync(next)) return; // build not run yet
    // Everything shipped to browsers (static JS/CSS) and the server-rendered
    // app output. Source maps are excluded: they carry third-party lint
    // comments, never UI text.
    const shipped = [
      ...files(path.join(next, "static"), [".js", ".css", ".html"]),
      ...files(path.join(next, "server", "app"), [".js", ".html", ".rsc", ".body"]),
    ];
    expect(shipped.length).toBeGreaterThan(0);
    expect(offenders(shipped)).toEqual([]);
  });
});
