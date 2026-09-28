# Migration and private-data boundaries

## From the v0.1 public core

The old single `config.json` (`peer`, `repos`, `stateDirectory`, etc.) and commands
such as top-level `once`, `run`, `status`, and `--config` are **not automatically
compatible** with this workflow. Do not feed that file to current `init` or
silently rename it to `direct-sync.json`.

1. Inventory the old installation and stop its controller deliberately. Preserve
   an offline private backup of config, complete state, checkouts and local
   edits, Git refs/history, receipt stores, intents, locks, and service receipts.
   Confirm the backup is readable. Do not delete presumed secrets or recovery
   evidence merely because they are old.
2. Build the public source and initialize a **new external app location** with
   your chosen host ID. Discover existing checkouts and explicitly enroll only
   the repositories you intend to manage. Never run old and new controllers
   against the same checkout concurrently.
3. Re-express selections using [setup](setup.md): workflow transport/pins and
   executable paths; direct config with required local/peer path bindings; or
   GitHub upstream enrollment. No hidden host/account allowlist is supplied.
   Keep old state offline rather than transplanting it into a new schema.
4. Investigate every retained intent/partial apply before authorizing new
   updates. A fresh state directory is not a recovery bypass. Validate receipt,
   then application on disposable data before production. Note that upstream
   `enable` authorizes fast-forward immediately.
5. Reconnect the normal Pi Guardian and public notify sender. Verify actual
   status/delivery and any service ownership before deliberately repointing an
   installation. Archive old private operational docs and private Git history
   offline, not in the public source tree.

This is a migration procedure, not a claim that an existing production system
has already been repointed. Publish/repoint/delete/history-rewrite actions each
need their own authority. Do not remove an old repository just to simplify names.

## Keep private material outside the source tree

Use AppPaths/GIT_SYNC_HOME for live configuration and state, a private Guardian
cwd for its AGENTS.md/checkpoints, and separate private storage for deployment
notes/backups. Do not publish host bindings, account inventories, SSH trust files,
credentials, session UUIDs/transcripts, operational OIDs, notification evidence,
intents, journals, receipts, quarantine, or old private repository history.

If a checkout must contain private local material, add precise rules to **your**
`.gitignore`, for example (review against the actual repository first):

```gitignore
/private/
/docs/private/
/docs/local/
/docs/*.local.md
/config.local.json
/workflow.local.json
.env
.env.*
!.env.example
/state/
*.log
```

These are suggested conventions, not an assertion that the repository already
has those rules. Do not ignore all `docs/`: the public workflow documentation
belongs in version control. `.gitignore` does not untrack existing files, scrub
history, or filter npm/release attachments. Check tracked paths, branches/tags
and historical content, package contents, and release assets separately. Preserve
private local copies before any precisely authorized untracking. Rotate a real
exposed credential; deleting text alone cannot revoke it. Never assume every
private-looking file is disposable or every scan is proof of no secrets.
