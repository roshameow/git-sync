#!/usr/bin/env node
import { setTimeout } from "node:timers/promises";
import { loadConfig } from "./config.js";
import { once, status } from "./controller.js";

const args = process.argv.slice(2);
const [command, flag, path] = args;
const cancellation = new AbortController();
process.once("SIGINT", () => cancellation.abort());
process.once("SIGTERM", () => cancellation.abort());
try {
  if (!["once", "status", "run"].includes(command ?? "") ||
    !(args.length === 1 || (args.length === 3 && flag === "--config" && path))) {
    throw new Error("Usage: git-sync <once|status|run> [--config /absolute/path/config.json]");
  }
  if (path && !path.startsWith("/")) throw new Error("Config path must be absolute");
  const config = await loadConfig(path);
  if (command === "status") console.log(JSON.stringify(await status(config), null, 2));
  else do {
    try {
      const results = await once(config, cancellation.signal);
      console.log(JSON.stringify(results, null, 2));
      if (command === "once" && results.some(r => /^(error|needs-recovery|blocked-)/.test(String(r.status)))) process.exitCode = 1;
    } catch (e) {
      if (cancellation.signal.aborted) break;
      if (command === "once") throw e;
      console.error(e instanceof Error ? e.message : "Sync failed");
    }
    if (command !== "run" || cancellation.signal.aborted) break;
    try { await setTimeout(config.pollSeconds * 1000, undefined, { signal: cancellation.signal }); }
    catch { break; }
  } while (!cancellation.signal.aborted);
  if (command === "once" && cancellation.signal.aborted) process.exitCode = 1;
} catch (e) {
  console.error(e instanceof Error ? e.message : "Sync failed");
  process.exitCode = 1;
}
