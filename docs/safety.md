# Safety, status, and recovery

## What is automatic

Sync accepts only explicitly selected trusted committed history. It creates
app-owned bare receipt stores, not clones of user worktrees. Each observed tip
has an immutable receipt ref; a later source reset does not erase earlier tips.
There is no retention/pruning policy or complete-backup guarantee.

Direct sync requires both registry enrollment and an enabled repository row;
`applyCleanFastForward: false` means receipt only. Upstream `enable` is an
explicit apply opt-in. Both use the same safe fast-forward implementation.
The source is never pushed to or edited. Uncommitted peer files are not synced.

Application requires the configured branch, valid identity/receipt, supported
Git layout, unchanged tracked files/index, and descendant history. Unrelated
untracked/ignored files may remain; target path collisions block. Hooks are
disabled. Checkout filters, submodules, shallow/sparse histories, hidden index
entries, and ambiguous/unsupported states are not bypassed. Receipt/apply uses
SHA-1 stores; do not assume SHA-256 repository support.

Cooperating locks do not freeze independent Git writers, editors, or same-user
processes. Repeated checks reduce but cannot eliminate races. Git can partially
change files on I/O failure or cancellation. Subprocess time/output bounds are
not hard disk/RAM quotas or an untrusted-code sandbox. Start with disposable
repositories and your own verified transport before enabling real updates.

## Read outcomes, not just exit codes

- `received-not-applied`: history received, not an updated checkout.
- `fast-forwarded` / `up-to-date`: inspect the apply result and target/HEAD.
- `local-ahead`: local history is ahead; no reset, and no proof of peer apply.
- `blocked-dirty`: inspect tracked/index changes or target path collisions.
- `blocked-diverged`: a resolver is needed; retrying cannot make it a fast-forward.
- `blocked-branch` / `blocked-identity`: recheck branch, inventory, paths, remotes.
- `needs-recovery`: preserve evidence and investigate before any new attempt.

`sync status` / `sync upstream status` report persisted evidence. They do not
fetch, refresh checkouts, or prove current transport health. A retained
`received` field can describe a previous successful receive even if the latest
transfer is pending/error; read `transfer.state` and timestamps together.
`sync once` exits nonzero for error rows, but blocked rows need not produce a
nonzero exit. Always inspect row and apply states. For observer-only
`daemon once` output, read sync status separately.

## Interrupted work

Stop all relevant controllers before investigation. Privately back up state and
the affected checkout, including uncommitted/untracked material. Preserve
apply intents, Git locks, receipt stores, identity records, daemon/service
receipts, incidents, and quarantine. A pending apply intent blocks future apply
even if HEAD appears to equal the target. It is not safe to delete it based only
on a status label. There is no automatic apply-intent recovery/rollback CLI.

For a daemon lifecycle lock specifically:

```sh
"$NODE" "$CLI" doctor daemon-lock
# Only after proving the service is stopped and reviewing the exact lock:
"$NODE" "$CLI" doctor daemon-lock clear --instance-id REPLACE_INSPECTED_INSTANCE_ID --confirm-service-stopped
```

This guarded command is not permission to remove sync/apply/Git locks. Never
use blanket `rm` of state or locks to force progress. Reconcile exact repository
identity, branch/HEAD, index/worktree, saved input/target, and any partial changes
with the user's authority. Moving paths, rotating trust pins, or replacing a
checkout is deliberate reconfiguration, not evidence that old state is disposable.
