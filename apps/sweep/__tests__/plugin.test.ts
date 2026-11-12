// The ABI-split config plugin edits app/build.gradle idempotently.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addSplits } = require("../plugins/withAbiSplits") as { addSplits: (g: string) => string };

const gradle = `apply plugin: "com.android.application"\n\nandroid {\n    ndkVersion rootProject.ext.ndkVersion\n}\n`;

test("adds an arm-only abi split block once", () => {
  const once = addSplits(gradle);
  expect(once).toContain('include "armeabi-v7a", "arm64-v8a"');
  expect(once).toContain("universalApk false");
  expect(addSplits(once)).toBe(once);
});
