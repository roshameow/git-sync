# Setup and repository selection

## 1. Build and choose external paths

Build as described in the README. In the shell where you run commands, set:

```sh
SOURCE='/REPLACE_WITH_ABSOLUTE_PUBLIC_CHECKOUT'
NODE="$(node -p 'process.execPath')"
CLI="$SOURCE/dist/src/cli.js"
```

Every `REPLACE_WITH` value in these docs/examples is a placeholder, **invalid
for deployment until filled**. Use real absolute, normalized paths (no `~` in
JSON), actual repository identities/branches, and verified trust material.
Examples are not live configuration. Do not copy them over an existing setup.

`resolveAppPaths` (`src/config.ts`) resolves:

| Data | Default |
| --- | --- |
| Discovery config | `${XDG_CONFIG_HOME:-$HOME/.config}/git-sync/config.json` |
| Runtime state | `${XDG_STATE_HOME:-$HOME/.local/state}/git-sync/` |
| Workflow config | `workflow.json` beside `config.json` |
| Bridge producer outbox | `bridge-outbox/` beside `config.json` |
| Sync selections | `direct-sync.json`, `upstream-sync.json` **inside state** |

Alternatively, `export GIT_SYNC_HOME='/absolute/private/git-sync-home'` puts
config at `$GIT_SYNC_HOME/config.json` and state at `$GIT_SYNC_HOME/state`.
Use the same environment for the CLI, daemon, and provenance-producing Pi.
All app paths must stay outside Git worktrees and Git storage. Keep directories
owner-private (`0700`) and configuration files owner-owned regular `0600`
files, not symlinks/hardlinks. Do not repair unknown unsafe paths blindly.

For the following commands, derive the selected locations:

```sh
if [ -n "${GIT_SYNC_HOME:-}" ]; then
  CONFIG_DIR="$GIT_SYNC_HOME"
  STATE_DIR="$GIT_SYNC_HOME/state"
else
  CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/git-sync"
  STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/git-sync"
fi
umask 077
mkdir -p "$CONFIG_DIR" "$STATE_DIR"
```

## 2. Initialize, discover, enroll

Use an existing directory of your own repositories. Discovery never clones or
changes a checkout. Run once per installation:

```sh
"$NODE" "$CLI" init --host-id host-a --root /REPLACE_WITH_REPOSITORY_ROOT
"$NODE" "$CLI" discover
"$NODE" "$CLI" registry status
"$NODE" "$CLI" repo enable /REPLACE_WITH_EXISTING_CHECKOUT
```

Host IDs are arbitrary stable identifiers (`host-a`/`host-b` here), not machine
names or SSH addresses. `init` writes discovery `config.json` with
`schemaVersion`, `roots`, and `excludedDirectories`, plus the host identity and
initial registry in state. It refuses an existing initialization. To add roots:

```sh
"$NODE" "$CLI" discover --root /REPLACE_WITH_ADDITIONAL_ROOT
```

This is additive: it preserves prior roots, exclusions, and repository
selections. Invalid/unreadable new roots do not replace the saved inventory.
`init --exclude NAME_OR_PATH` is repeatable; explicit exclusions replace the
default exclusion list, so supply every exclusion you want at initialization.

Enrollment uses a normalized remote identity, e.g. `github.com/example/project`,
not credentials or a transport URL. `repo enable` also accepts that identity
instead of a checkout path. `repo disable` and `repo ignore` use the same syntax.
Discovery alone never grants synchronization authority; enrollment alone never
selects a transport. Duplicate checkouts for one identity block sync selection.

## 3A. Start with one host and GitHub (no peer)

Copy [workflow.single-host.example.json](../examples/workflow.single-host.example.json)
to `$CONFIG_DIR/workflow.json`, fill the executable paths, and set mode `0600`.
For a new destination only:

```sh
cp -n "$SOURCE/examples/workflow.single-host.example.json" "$CONFIG_DIR/workflow.json"
# Edit the external copy now; use absolute paths from your own installation.
chmod 600 "$CONFIG_DIR/workflow.json"
```

Keep `primaryHostId` equal to your initialized host ID and `peers` empty. With
no workflow file, defaults are the local host as primary, no peers,
`/usr/bin/gh`, and `/usr/bin/python3`; override paths when these do not exist.

Authenticate your configured GitHub CLI as the same OS user running the daemon
(`gh auth login`, then `gh auth status`, using that executable). Credentials stay
in your existing gh login, never in git-sync JSON. Receive uses a constructed
`https://github.com/OWNER/REPOSITORY.git` endpoint and the fixed helper
`<githubCli> auth git-credential`, not arbitrary configured shell commands or
checkout credential helpers. It does not forward arbitrary token environment
variables; verify the noninteractive user's saved login.

After discovery identifies the unique existing checkout and you have selected
its actual branch:

```sh
"$NODE" "$CLI" sync upstream enable github.com/REPLACE_OWNER/REPLACE_REPOSITORY REPLACE_BRANCH
"$NODE" "$CLI" sync upstream once
"$NODE" "$CLI" sync upstream status
```

**`upstream enable` explicitly opts into clean fast-forward**, also enabling the
local registry entry. It writes state and requests a wake; its `applied: false`
output means registration, not a completed pull. To pause this transport:

```sh
"$NODE" "$CLI" sync upstream disable github.com/REPLACE_OWNER/REPLACE_REPOSITORY
```

Disabling preserves the branch and does not revoke other registry selections.
The generated `upstream-sync.json` has `schemaVersion`, `hostId`,
`intervalSeconds` (30–900; default 60), and `repositories` rows with
`canonicalRemote`, `branch`, `enabled`, and `applyCleanFastForward`.
Setting the latter to `false` in the external file selects receipt without apply;
running `upstream enable` again sets it back to `true`.

## 3B. Optional two-host direct receipt

On each host, build/install this CLI, initialize with distinct IDs, discover its
existing checkout, and `repo enable` that repository. Do not enable upstream
and direct-peer sync for the same canonical repository at the same time.
Different repositories may use different modes.

On host-a, use [workflow.example.json](../examples/workflow.example.json):
`primaryHostId: host-a`, one `peers.host-b` entry. Its host/user identify the SSH
destination, its `nodeExecutable`/`cliEntrypoint` are **absolute paths on host-b**,
and its `knownHosts` is a **local file on host-a**. `executables.githubCli` and
`executables.python` are local executables. On host-b, keep `primaryHostId` as
host-a but configure only `peers.host-a` with the reverse endpoint and pin.
Do not put both peers in either file; zero or one peer is supported.

Verify the peer's Ed25519 host key/fingerprint out of band. Put its exact
hostname and verified key in your owner-controlled known-hosts file; a
`ssh-keyscan` result alone is not verification. Use an unambiguous plain entry,
not hashed/wildcard/CA entries. A private `0600` known-hosts file is recommended;
group/other-writable files are rejected. Fingerprint must be canonical
`SHA256:` base64, not an example value.

SSH uses port 22, strict Ed25519 pinning, batch mode, and `-F /dev/null`.
User/system SSH configuration, aliases, ProxyCommand/ProxyJump, and arbitrary
SSH options are not used. Set up noninteractive authentication with the user's
standard key files; the sanitized subprocess environment does not pass
`SSH_AUTH_SOCK`. A key requiring an unavailable interactive passphrase will fail.
The SSH account must permit Git upload-pack for the selected peer path and the
fixed Node/CLI diagnostic commands; a Git-only forced-command key may not support
Guardian inspection.

Peer diagnostic commands do **not** forward the local `GIT_SYNC_HOME`/XDG
settings. The remote Node/CLI is invoked in the SSH account's environment.
For initial onboarding, use default app locations on peers; a custom location
must also resolve correctly in that noninteractive remote environment. An
interactive shell-only export is not proof of remote configuration.

Copy [direct-sync.example.json](../examples/direct-sync.example.json) to
`$STATE_DIR/direct-sync.json`, fill it, and protect it as `0600`:

```sh
cp -n "$SOURCE/examples/workflow.example.json" "$CONFIG_DIR/workflow.json"
cp -n "$SOURCE/examples/direct-sync.example.json" "$STATE_DIR/direct-sync.json"
# Fill both external files before running any sync command.
chmod 600 "$CONFIG_DIR/workflow.json" "$STATE_DIR/direct-sync.json"
"$NODE" "$CLI" sync once
"$NODE" "$CLI" sync status
```

`cp -n` will not replace a single-host workflow already present: deliberately
edit that existing file when adding a peer. Direct config requires `hostId`,
`peerHostId`, an explicit `applyCleanFastForward` boolean, `intervalSeconds`
(30–900), and nonempty `repositories`. Each row needs `canonicalRemote`,
**`localPath`**, `peerPath`, `branch`, and `enabled`; disabled rows also need a
nonempty `reason`. `localPath` must exactly match the unique discovered local
checkout. `peerPath` is the peer's existing absolute checkout path.

Start with `applyCleanFastForward: false` to verify receipt. Set it to `true`
only to authorize safe updates. Reverse IDs and local/peer path bindings in
host-b's direct config for reciprocal receipt; one instance never pushes.
Next: [daemon and Guardian](guardian.md).
