import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/i18n/locales";

const dir = path.resolve(import.meta.dirname, "../../messages");
type M = { [k: string]: string | M };
const load = (l: string) => JSON.parse(readFileSync(path.join(dir, `${l}.json`), "utf8")) as M;

function flatten(m: M, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === "string") out[prefix + k] = v;
    else Object.assign(out, flatten(v, `${prefix}${k}.`));
  }
  return out;
}

const placeholders = (s: string) =>
  [...s.matchAll(/\{([a-z_]\w*)(?:,|\})/g)].map((m) => m[1]).filter((x, i, a) => a.indexOf(x) === i).sort();

describe("translations", () => {
  const en = flatten(load("en"));
  it("has a file for every locale", () => {
    expect(readdirSync(dir).filter((f) => f.endsWith(".json")).sort()).toEqual(LOCALES.map((l) => `${l}.json`).sort());
  });
  for (const l of LOCALES) {
    it(`${l} has exactly the English keys and placeholders`, () => {
      const m = flatten(load(l));
      expect(Object.keys(m).sort()).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en)) {
        expect(placeholders(m[k]), `${l}:${k}`).toEqual(placeholders(en[k]));
        expect(m[k].trim(), `${l}:${k}`).not.toBe("");
      }
    });
  }
});
