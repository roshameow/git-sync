# git-sync

Explicit, one-way committed-history receipt over SSH, with **opt-in clean-only
fast-forward** of an existing local checkout. No discovery, push, merge commits,
conflict resolution, stash, reset, clean, project checks, or service installer.
This public edition contains only the configurable synchronization core.
Personal deployments, credentials, operational records and earlier private Git
history are not included. No AI Guardian or service installer is bundled.

## Requirements and setup

- Node.js **20.10+**, Git at `/usr/bin/git`, OpenSSH at `/usr/bin/ssh`, and a
  POSIX filesystem with owner/mode checks (macOS/Linux; not Windows).
- Your own existing, trusted SHA-1 Git repositories on both hosts. The local
  path must be the exact canonical worktree root. No automatic clone/init of
  user repositories. The app initializes only its own private bare receipt store.
- Your own SSH account and noninteractive public-key authentication. The peer
  must permit Git upload-pack for the configured absolute repository path.
  Remote committed contents are trusted input, not sandboxed hostile uploads.
- Verify the peer's **Ed25519 host key out of band**. A key obtained by an
  unauthenticated key scan alone is not verification.

For a normal source build, install the development dependencies with `npm ci`,
then run `npm test`. Runtime has **zero npm dependencies**. The local candidate
verification used existing development dependencies offline; it did not run
`npm ci` or contact a registry. Build output is under `dist/`.

Copy `config.example.json` to `~/.config/git-sync/config.json` yourself, outside
this source tree. Replace **all** placeholders; the example is intentionally
invalid until edited. Protect the containing directory (`0700`) and configuration
file (`0600`, owned by the current user, regular file, no symlink/hardlinks).
Nothing creates or guesses a default configuration.

Required fields:

- `peer.host`: DNS hostname or IPv4 address (no port, IPv6, SSH alias syntax,
  whitespace, or options); connection uses port 22.
- `peer.user`: explicit SSH account name.
- `peer.hostKey`: exactly one of:
  - `{ "wire": "ssh-ed25519 REPLACE_WITH_VERIFIED_PUBLIC_KEY_BASE64" }`, a
    complete Ed25519 wire public key, without trailing comment; or
  - `{ "knownHosts": "/absolute/path/to/known_hosts", "fingerprint":
    "SHA256:REPLACE_WITH_VERIFIED_FINGERPRINT" }`. The file must be owner `0600`
    and contain exactly one entry matching `peer.host`, with that Ed25519 key.
    Only a plain exact hostname entry is supported, not hashed hosts,
    comma-separated aliases, wildcard/CA entries, or nondefault ports.
    Unrelated entries are ignored. The matching key's fingerprint is verified,
    then only that key is written to app-owned pinned host storage.
- `repos`: explicit nonempty array of `{id, localPath, peerPath, branch}`.
  IDs and local paths must be unique. Paths must be absolute and normalized,
  with no control characters; branch names use a conservative Git-compatible
  alphabet. No repository allowlist or runtime account identity is built in.

Optional fields:

- `applyCleanFastForward`: **false** by default. Receipt alone does not update
  the local checkout, refs, or index. Set to `true` only when you want eligible
  local branches updated.
- `pollSeconds`: integer **30–900**, default **60**. Delay after a completed pass;
  passes are sequential, never overlapping.
- `stateDirectory`: absolute canonical path, default
  `~/.local/state/git-sync`. Must be separate from worktrees and Git storage.
  App directories are owned `0700`; existing unsafe directories are rejected,
  not chmod-repaired. State paths cannot contain `%` or `${` (OpenSSH filename
  expansions). Do not place configuration or app state inside a worktree.

Unknown fields and invalid values are rejected. No configurable shell commands
or arbitrary SSH options are accepted. SSH uses `-F /dev/null`: your user/system
SSH config, ProxyCommand, host aliases, and custom identity-file settings are
**not loaded**. Set up authentication using OpenSSH's standard default key files
for the running user. `BatchMode=yes` forbids interactive passwords/passphrases;
this version does not pass `SSH_AUTH_SOCK` to Git and cannot use an agent.
Use an appropriately restricted dedicated account/key. No credentials or host
key material are supplied by this project.

## Commands

After building:

```sh
node dist/src/cli.js once
node dist/src/cli.js status
node dist/src/cli.js run
# Any command also accepts: --config /absolute/path/config.json
```

`once` receives the configured branch's observed committed OID into a dedicated
bare store, retaining immutable refs for previous tips even after peer resets.
It never changes peer refs or peer files. Default receipt does not inspect or
transfer uncommitted peer changes. If apply is enabled, the local branch must
be the configured branch, clean, and a descendant fast-forward must be possible.
Dirty, divergent, detached/wrong-branch, unsupported, or uncertain states block
updates. Local-ahead stays local-ahead. Untracked files block; unrelated ignored
output is allowed, but ignored target collisions block. Hooks are disabled;
checkout filters, submodules, sparse/shallow histories and hidden index entries
are not supported by apply. SHA-256 repositories are unsupported.

`status` reads the last persisted per-repository result as JSON, validating its
mapping with read-only Git/filesystem checks. Pending intents and mismatched or
unverifiable mappings take precedence as `needs-recovery`. It performs no sync,
creates no state, and does not contact SSH. Before the first pass it reports
`never-run`. Timestamps are last-completed attempts, not a live health guarantee.
Read-only setup/preflight failures may leave previous status unchanged; check
stderr/exit status as well. A persisted error replaces the previous status; it
does not preserve the previous `received` details in that JSON record. Previously
received committed history remains protected by immutable refs in the store.
`once` exits nonzero for errors, blocked outcomes, or
recovery requirements. Ordinary received/up-to-date/local-ahead outcomes succeed.

`run` loads configuration once, repeatedly runs sequential passes and reports
results/errors. Settings are reloaded **only on restart**, not on each poll.
Restart it after config changes. SIGINT/SIGTERM cancel active Git
processes and the polling delay. Use your own OS supervisor (for example launchd
or systemd) with an absolute Node executable, absolute CLI/config paths, a
private log destination and the same user account. No install/uninstall command
or service automation is implemented. Do not run multiple controllers using
different state directories for the same checkout. Reciprocal receipt requires
you to configure and supervise a separate instance on the other host.

## State, interruption and limitations

Each canonical local path has a stable SHA-256-named directory under state:
`identity.json`, `known_hosts`, `received.git`, `status.json`, and, during apply,
`apply-intent.json`. Mapping records bind the repository ID, local path/inode, canonical Git/common
directory paths/inodes, peer account/host/path, branch and host-key fingerprint. Changing a mapping
fails closed instead of silently reusing receipts. Renaming IDs does not bypass
pending evidence. Moving/replacing a repository, rotating a host key or changing
a peer requires deliberate operator reconciliation; there is no migration CLI.
Keep the same external state directory across restarts. State and logs can
contain private runtime identities/history; never include them in a release.

One exclusive `controller.lock` serializes cooperating processes using the same
state directory. Existing locks are never automatically removed as stale.
Existing apply intents **always block the controller**, even after an apparently
completed apply, and remain byte-for-byte intact. Git locks are likewise retained.
Successful uninterrupted apply removes only its own durable intent. Before any
manual reconciliation, stop every controller, back up state, and inspect the
exact repository identity, branch, HEAD, index/worktree, locks and saved intent.
Do not delete evidence merely to force a retry. There is no automatic recovery
or rollback tool.

The lock is not exclusion against editors, independent Git commands or hostile
same-user processes. Repeated gates reduce but cannot eliminate concurrent-writer
races. Git may partially change files before an I/O failure or cancellation;
the retained intent requires human investigation. Stores accumulate history
without automatic retention/pruning. Git calls have time/output limits, **not**
hard memory/disk quotas. This is not a complete backup or a hostile-input sandbox.
Use it first on disposable repositories with your own SSH setup.

## Verification and packaging

`npm run build`, `npm run typecheck`, and `npm test` are the supported checks.
Tests use real Git and temporary fixtures; config/CLI/SSH-option checks run
without a live peer. They cover immutable receipt, byte-preserving blocked
updates, clean fast-forward, interruption evidence, owner-only configuration,
receive-only defaults and locking. A separate receive-only SSH smoke test with externally supplied private
configuration succeeded and left the local index unchanged. Its configuration
and operational details are not included here. An OS-supervised installation
is not supplied or validated by the public package.

The npm `files` allowlist contains only built runtime modules/declarations,
this README, MIT license and placeholder config (npm also includes package
metadata). Tests, source-development files and release evidence are not in the
package payload. `private: true` deliberately prevents accidental publication;
changing it requires a separate reviewed release decision. MIT license: **git-sync contributors**.
