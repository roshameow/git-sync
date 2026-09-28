import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const execute = promisify(execFile);
test("private local documentation/config patterns are ignored, public guidance remains includable", async t => {
  const directory = await mkdtemp(join(tmpdir(), "git-sync-public-boundary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await execute("/usr/bin/git", ["-C", directory, "init", "--quiet", "--template="]);
  await writeFile(join(directory, ".gitignore"), await readFile(join(root, ".gitignore")));
  const privatePaths = ["private/notes.md", "docs/private/notes.md", "docs/local/notes.md", "docs/device.local.md",
    "docs/deployment-local.md", "config.local.json", "workflow.local.json", ".env", ".env.local", "state/receipt.json"];
  for (const file of privatePaths) { await mkdir(dirname(join(directory, file)), { recursive: true }); await writeFile(join(directory, file), "fixture\n"); }
  const checked = (await execute("/usr/bin/git", ["-C", directory, "check-ignore", "--no-index", ...privatePaths])).stdout.trim().split("\n");
  assert.deepEqual(checked, privatePaths);
  for (const file of ["README.md", "docs/setup.md", "examples/workflow.example.json", ".env.example"]) {
    await assert.rejects(execute("/usr/bin/git", ["-C", directory, "check-ignore", "--no-index", file]),
      (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === 1);
  }
});
test("package exports only named public docs/examples and does not keep the retired controller", async () => {
  const p = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { files: string[]; pi: { extensions: string[]; skills: string[] } };
  assert.ok(p.files.includes("extensions/provenance.ts"));
  assert.ok(p.files.includes("skills/github-public-release/SKILL.md"));
  assert.deepEqual(p.pi.extensions, ["./extensions/provenance.ts"]);
  assert.ok(p.files.some(file => file === "docs/guardian-agent.md"));
  assert.ok(p.files.filter(file => /^(docs|examples)\//.test(file)).every(file => !/[\*?]/.test(file)));
  assert.ok(p.files.every(file => !/private\/|local\.md|local\.json|\.env|experiments\/|\.map$/.test(file)));
  await assert.rejects(readFile(join(root, "src/controller.ts")), { code: "ENOENT" });
});
