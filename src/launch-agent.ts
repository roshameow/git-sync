import { dirname, resolve } from "node:path";
import type { AppPaths } from "./config.js";
import { loadHostIdentity } from "./host.js";

/** Render only. Installation/loading remains an explicit user/packaging action. */
export async function renderLaunchAgent(
  paths: AppPaths,
  cliEntrypoint: string,
  nodeExecutable: string,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const identity = await loadHostIdentity(paths);
  const label = launchAgentLabel(identity.id);
  const override = sourceEnvironment.GIT_SYNC_HOME?.trim();
  const pinnedEnvironment: Array<readonly [string, string]> = override !== undefined && override !== ""
    ? [["GIT_SYNC_HOME", dirname(paths.configFile)]]
    : [
        ["XDG_CONFIG_HOME", dirname(dirname(paths.configFile))],
        ["XDG_STATE_HOME", dirname(paths.stateDirectory)],
        ...(sourceEnvironment.HOME === undefined || sourceEnvironment.HOME.trim() === ""
          ? []
          : [["HOME", resolve(sourceEnvironment.HOME)] as const]),
      ];
  const installationId = sourceEnvironment.GIT_SYNC_LAUNCH_AGENT_RECEIPT?.trim();
  if (installationId !== undefined && installationId !== "") {
    pinnedEnvironment.push(["GIT_SYNC_LAUNCH_AGENT_RECEIPT", installationId]);
  }
  const environment = pinnedEnvironment.length === 0
    ? ""
    : `\n    <key>EnvironmentVariables</key>\n    <dict>${pinnedEnvironment.map(([key, value]) =>
      `\n      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`).join("")}\n    </dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodeExecutable)}</string>
    <string>${xml(cliEntrypoint)}</string>
    <string>daemon</string>
    <string>run</string>
  </array>${environment}
  <key>RunAtLoad</key>
  <true/>
  <!-- KeepAlive remains false until an explicit stale-lock recovery command exists. -->
  <key>KeepAlive</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

export function launchAgentLabel(hostId: string): string {
  return `com.git-sync.daemon.${hostId}`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
