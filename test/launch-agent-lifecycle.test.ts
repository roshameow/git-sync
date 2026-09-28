import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveAppPaths } from "../src/config.js";
import { createHostIdentity, saveHostIdentity } from "../src/host.js";
import {
  installLaunchAgent,
  launchAgentStatus,
  uninstallLaunchAgent,
  type LaunchAgentLifecycleOptions,
} from "../src/launch-agent-lifecycle.js";
import { pathExists } from "../src/storage.js";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

test("LaunchAgent lifecycle uses receipt/hash ownership and only fake launchctl", async (context) => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "git-sync-launch-agent-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const appHome = resolve(sandbox, "app");
  const userHome = resolve(sandbox, "home");
  const launchctl = resolve(sandbox, "launchctl");
  const launchState = resolve(sandbox, "launchctl.loaded");
  const launchLog = resolve(sandbox, "launchctl.log");
  await mkdir(userHome);
  await writeFile(launchctl, `#!/bin/sh
printf '%s\\n' "$*" >> ${shellQuote(launchLog)}
case "$1" in
  print) [ -e ${shellQuote(launchState)} ] && cat ${shellQuote(launchState)} ;;
  bootstrap) cp "$3" ${shellQuote(launchState)} ;;
  bootout) rm -f ${shellQuote(launchState)} ;;
  *) exit 91 ;;
esac
`, { mode: 0o700 });
  await chmod(launchctl, 0o700);

  const paths = resolveAppPaths({ GIT_SYNC_HOME: appHome });
  await saveHostIdentity(paths, createHostIdentity("host-a"));
  const options: LaunchAgentLifecycleOptions = {
    platform: "darwin",
    uid: process.getuid?.() ?? 501,
    userHome,
    launchctlExecutable: launchctl,
    sourceEnvironment: { GIT_SYNC_HOME: appHome, HOME: userHome },
  };

  const before = await launchAgentStatus(paths, cli, process.execPath, options);
  assert.equal(before.installed, false);
  assert.equal(before.loaded, false);
  assert.equal(before.plistPresent, false);

  const installed = await installLaunchAgent(paths, cli, process.execPath, options);
  assert.equal(installed.status, "loaded");
  assert.equal(await pathExists(installed.plistPath), true);
  assert.equal(await pathExists(paths.launchAgentReceiptFile), true);
  const plist = await readFile(installed.plistPath, "utf8");
  assert.match(plist, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
  const commandsAfterInstall = (await readFile(launchLog, "utf8")).trim().split("\n");
  assert.deepEqual(commandsAfterInstall.map((line) => line.split(" ")[0]), ["print", "print", "print", "bootstrap"]);

  const repeated = await installLaunchAgent(paths, cli, process.execPath, options);
  assert.equal(repeated.plistSha256, installed.plistSha256);
  assert.deepEqual(
    (await readFile(launchLog, "utf8")).trim().split("\n").map((line) => line.split(" ")[0]),
    [...commandsAfterInstall.map((line) => line.split(" ")[0]), "print"],
  );
  const active = await launchAgentStatus(paths, cli, process.execPath, options);
  assert.equal(active.installed, true);
  assert.equal(active.ownershipVerified, true);
  assert.equal(active.loadedJobOwned, true);
  assert.equal(active.plistIntegrity, "verified");

  await writeFile(launchState, "foreign same-label job\n");
  await assert.rejects(
    installLaunchAgent(paths, cli, process.execPath, options),
    /does not match the ownership receipt/,
  );
  await assert.rejects(
    uninstallLaunchAgent(paths, cli, process.execPath, options),
    /same-label LaunchAgent not owned/,
  );
  await writeFile(launchState, plist);

  const receiptRaw = JSON.parse(await readFile(paths.launchAgentReceiptFile, "utf8")) as Record<string, unknown>;
  await writeFile(paths.launchAgentReceiptFile, `${JSON.stringify({
    ...receiptRaw,
    cliEntrypoint: "/tmp/foreign-cli.js",
  })}\n`);
  const mismatchedReceiptStatus = await launchAgentStatus(paths, cli, process.execPath, options);
  assert.equal(mismatchedReceiptStatus.installed, false);
  assert.equal(mismatchedReceiptStatus.ownershipVerified, false);
  await writeFile(paths.launchAgentReceiptFile, `${JSON.stringify(receiptRaw)}\n`);

  await writeFile(installed.plistPath, `${plist}\n<!-- tampered -->\n`);
  const tampered = await launchAgentStatus(paths, cli, process.execPath, options);
  assert.equal(tampered.installed, false);
  assert.equal(tampered.plistIntegrity, "mismatch");
  await assert.rejects(
    uninstallLaunchAgent(paths, cli, process.execPath, options),
    /hash does not match/,
  );
  assert.equal(await pathExists(launchState), true);
  await writeFile(installed.plistPath, plist, { mode: 0o600 });

  const unloaded = await uninstallLaunchAgent(paths, cli, process.execPath, options);
  assert.equal(unloaded.status, "unloaded");
  assert.equal(await pathExists(installed.plistPath), false);
  assert.equal(await pathExists(unloaded.quarantinedPlistPath as string), true);
  assert.equal(await pathExists(launchState), false);
  assert.equal((await uninstallLaunchAgent(paths, cli, process.execPath, options)).status, "unloaded");

  const unloadedRaw = JSON.parse(await readFile(paths.launchAgentReceiptFile, "utf8")) as Record<string, unknown>;
  await writeFile(paths.launchAgentReceiptFile, `${JSON.stringify({
    ...unloadedRaw,
    status: "prepared",
    quarantinedPlistPath: null,
  })}\n`);
  const recoveredPrepared = await installLaunchAgent(paths, cli, process.execPath, options);
  assert.equal(recoveredPrepared.status, "loaded");
  assert.equal(await pathExists(recoveredPrepared.plistPath), true);
  assert.equal((await uninstallLaunchAgent(paths, cli, process.execPath, options)).status, "unloaded");
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
