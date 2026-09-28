# Daemon and ordinary Pi Guardian

Complete [setup](setup.md) first. Commands below use its absolute `$NODE`,
`$CLI`, `$SOURCE` and external config/state environment.

## Run the background workflow

For a bounded first pass and inspection:

```sh
"$NODE" "$CLI" daemon once
"$NODE" "$CLI" sync status
"$NODE" "$CLI" daemon status
```

`daemon once` consumes bridge events, scans refs, and runs configured sync. Its
output is the local observer result; consult `sync status` for transfer/apply
results. It is not the resident monitor/notification loop.

Run the resident service in your terminal:

```sh
"$NODE" "$CLI" daemon run
```

This is a **long-running foreground command**, not a one-shot probe. Stop with
Ctrl-C/SIGTERM; do not start another instance while it owns the daemon lock.
In another shell with the same configuration environment:

```sh
"$NODE" "$CLI" daemon status
"$NODE" "$CLI" daemon wake
"$NODE" "$CLI" incidents list
```

The resident daemon observes local refs and bridge events, performs configured
sync passes, and routes attention to the configured Guardian. Normal successful
work requires no Pi session or model tokens. Configurations are read during
passes; a wake requests work under current settings, never an apply override.
Filesystem events are hints; a five-second metadata check catches coalesced
wake/config writes, including when the daemon is otherwise local-only.

On the configured primary, one workflow peer enables peer-upstream monitoring
without direct-sync enrollment or a local copy of those projects. With neither
local direct nor upstream config, this is `guardian-monitor` mode. Initialize
and discover an existing empty private directory if this host has no local
repositories. The peer still needs its own initialized upstream setup. Primary
monitoring reads bounded cached status over pinned SSH; it does not clone the
peer's projects or grant authority to modify them. For a new monitor-only primary,
with external app paths already selected:

```sh
mkdir -p "$HOME/.local/share/git-sync-observe"
"$NODE" "$CLI" init --host-id host-a --root "$HOME/.local/share/git-sync-observe"
"$NODE" "$CLI" discover
```

Configure its one peer in `workflow.json`, then `daemon run`; no `repo enable`
or local direct/upstream config is needed for monitoring alone.

### macOS LaunchAgent (optional)

Stop a foreground instance first. Use the actual stable Node/CLI paths:

```sh
"$NODE" "$CLI" daemon launch-agent    # render plist only
"$NODE" "$CLI" daemon install
"$NODE" "$CLI" daemon install-status
"$NODE" "$CLI" daemon status
# To remove this owned installation later:
"$NODE" "$CLI" daemon uninstall
```

Installation is for the current non-root macOS GUI user. It pins executable
paths and the app-path environment, writes an ownership receipt, and refuses
unowned or changed same-label jobs/plists. Uninstall preserves a quarantined
plist and receipt; it does not erase sync state. `RunAtLoad` is enabled,
`KeepAlive` is false: this is not an unconditional crash-restart loop. The
rendered job sends stdout/stderr to `/dev/null`; inspect persisted status and
incidents. Shell-only environment customization is not automatically inherited.

On other POSIX hosts use foreground `daemon run`, or configure your own
supervisor with the same user and absolute executable/app paths. No non-macOS
service installer or launchd compatibility is promised.

## Install the public Pi integrations

Use a current normal Pi CLI with your own model/provider configuration; no
custom SDK runtime, model selection, or special tool whitelist is required.
If Pi is not installed, with Node 22.19+:

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Use Pi's ordinary `/login` flow for your provider when needed. See the public
dependency READMEs for supported versions:

- [pi-agent-notify](https://github.com/roshameow/pi-agent-notify): exact-session events.
- [pi-subagent-durable](https://github.com/roshameow/pi-subagent-durable): normal
  runtime registration and optional isolated resolver workers.
- [pi-session-viewer](https://github.com/roshameow/pi-session-viewer): optional
  Desktop UI for the same ordinary Pi sessions, not a second Guardian writer.

For a new installation, these commands place the public notify package at a
known absolute location, so its sender is not borrowed from a private checkout:

```sh
NOTIFY_ROOT="$HOME/.local/share/pi-packages/pi-agent-notify"
mkdir -p "$HOME/.local/share/pi-packages"
git clone https://github.com/roshameow/pi-agent-notify.git "$NOTIFY_ROOT"
pi install "$NOTIFY_ROOT"
pi install git:github.com/roshameow/pi-subagent-durable
SENDER="$NOTIFY_ROOT/scripts/notify_agent.py"
chmod u+x,go-w "$SENDER"
```

If already installed through `pi install git:github.com/roshameow/pi-agent-notify`,
reuse that installation and set `SENDER` to its actual absolute
`scripts/notify_agent.py` path instead. Do not guess a maintainer's path. The
sender must be an owner-controlled executable regular file, not a link;
configuration copies and hashes its bytes into private app state. Reconfigure
routing to adopt an updated sender. Set `workflow.executables.python` to your
actual Python 3.9+ executable.

## Start and register the existing interactive session

In an existing ordinary RMUX/desktop terminal chosen by the user:

```sh
GUARDIAN_CWD="$HOME/.local/share/git-sync-guardian"
umask 077
mkdir -p "$GUARDIAN_CWD"
cp -n "$SOURCE/docs/guardian-agent.md" "$GUARDIAN_CWD/AGENTS.md"
export NODE CLI
cd "$GUARDIAN_CWD"
pi
```

Keep this cwd private, outside the public checkout and watched repositories.
Review/adapt the template privately; retain your normal Pi tools and settings.
In Pi, run `/session` and record its **exact UUID**. Use the existing pane target
reported by your ordinary RMUX/durable/UI setup (the pane running this Pi).
Do not invent either identifier, start a second writer, manufacture runtime
records, or pass a friendly session name instead of the UUID.

In another shell, restore the same app-path environment and variables, then:

```sh
SESSION_ID='REPLACE_WITH_EXACT_LIVE_PI_UUID'
RMUX_TARGET='REPLACE_WITH_EXISTING_SESSION:WINDOW.PANE'
"$NODE" "$CLI" guardian register "$SESSION_ID" --rmux-target "$RMUX_TARGET"
"$NODE" "$CLI" guardian candidates
"$NODE" "$CLI" guardian configure --session-id "$SESSION_ID" --sender "$SENDER"
"$NODE" "$CLI" guardian status
"$NODE" "$CLI" guardian dispatch
```

Both registration and routing configuration must run on `primaryHostId`.
The CLI requires the `--rmux-target` argument. Registration validates a live
normal Pi runtime record under `~/.pi/agent/runtime/<pid>.jsonl` against the
owner-controlled session header (exact UUID, cwd, process). Normal Pi transcript
mode `0644` is supported for read-only header inspection; runtime/routing records
still require `0600`. Do not chmod or rewrite a session merely to register it. Use the default Pi
agent directory for this flow. If the runtime has no target field, the supplied
target is your attestation of the existing pane; it is not a pane-creation API.
Registration writes only a pointer, never the transcript or a new agent runtime.

If no matching live session exists, check that durable loaded in that Pi,
that `/session` identifies the current persisted session, and that runtime and
session files meet ownership/privacy requirements. Do not forge them. When Pi
exits or changes sessions, verify its new identity and register/configure again.

With a desktop pointer configured, `guardian status` reports interactive-session
liveness; it is not a complete notification-delivery health check. `configure`
validates/pins the sender; `dispatch` sends eligible pending incidents with
receipts/deduplication. No pending incident means no message is expected. A
sender receipt is not proof the model resolved a problem: inspect authoritative
state after each meaningful notification.

## Inspect, request, resolve

```sh
"$NODE" "$CLI" guardian inspect github.com/REPLACE_OWNER/REPLACE_REPOSITORY
"$NODE" "$CLI" guardian local-inspect
"$NODE" "$CLI" guardian request-sync
"$NODE" "$CLI" incidents show REPLACE_INCIDENT_ID
```

For a configured **direct-peer** repository, `inspect` combines local checkout
inspection with a bounded pinned-SSH `guardian local-inspect` on the peer.
It also includes persisted transfer evidence. These are sequential observations,
not an atomic two-host snapshot; unavailable peers remain unknown. For an
**upstream-only** canonical GitHub repository, `inspect` reads local/peer cached
upstream config/status and reports `cachedOnly: true`, `live: false`. A live SSH
request for that status does not make the cached checkout or GitHub evidence
live. `fresh` measures status age only. Inspect the owner checkout and upstream
before acting; no copy is required on the primary.

`request-sync` requests local and peer daemon wakes, reporting
`requested-not-applied`/`applied: false`. On a single host use `sync wake` for a
local wake; lack of a peer is not an upstream sync blocker.

For direct-peer committed-history divergence only:

```sh
"$NODE" "$CLI" guardian preview github.com/REPLACE_OWNER/REPLACE_REPOSITORY
```

Preview uses the verified receipt and current local HEAD in isolated private
storage. It returns a Git-level proposal, **not** a tested semantic merge, user
approval, or application (`approved: false`, `applied: false`). It does not
resolve conflicts and is not an upstream-preview interface.

Use ordinary Pi tools (and normal durable delegation if useful) to create one
isolated resolver worktree per task on the owner host. Pin both input commits,
review changes and conflicts, run the project's appropriate tests/typechecks,
and explain the candidate and remaining risks. Recheck inputs and user authority
before applying; check actual HEAD/files afterward and both hosts when relevant.
There is no active `autoSemanticMerge` policy engine or automatic resolver/apply
CLI. Acknowledging an incident (`incidents acknowledge ID`) records attention,
not repair. Follow the [template](guardian-agent.md) and [safety rules](safety.md).
