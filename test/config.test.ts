import assert from "node:assert/strict";
import test from "node:test";
import { createConfig } from "../src/config.js";
import { isAppConfig } from "../src/validation.js";

test("configuration expands the current user's home without treating ~ as a literal directory", () => {
  const config = createConfig(
    ["~", "~/Projects", "relative"],
    ["node_modules", "~/.cache"],
    "/work",
    "/Users/example",
  );

  assert.deepEqual(config.roots, [
    "/Users/example",
    "/Users/example/Projects",
    "/work/relative",
  ]);
  assert.deepEqual(config.excludedDirectories, ["/Users/example/.cache", "node_modules"]);
  assert.throws(
    () => createConfig(["~another-user/repo"], [], "/work", "/Users/example"),
    /Unsupported home path/,
  );
  assert.equal(isAppConfig({ ...config, unexpected: true }), false);
});
