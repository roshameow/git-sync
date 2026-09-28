# git-sync

Explicit committed-history synchronization, safe opt-in fast-forward, and an
ordinary interactive Pi Guardian for problems that need investigation.

This repository contains the active workflow, not just a transfer library:
discovery and explicit enrollment, GitHub upstream or direct-peer receipt,
background observation, incident routing, isolated merge preview, and optional
session provenance. Runtime identities, credentials, checkouts, and operational
records belong outside this source tree.

```text
existing owner checkout ← safe fast-forward ← private committed-history store
                                                   ↑                 ↑
                                           GitHub HTTPS       pinned SSH peer
                                                   │                 │
                              daemon → status / incidents → Pi Guardian
                                                       public notify + durable
                                                       ordinary tools / Desktop
```

- **One host:** receive a selected GitHub branch into an existing checkout. No
  peer or second copy is required.
- **Two hosts:** each explicitly receives the other's selected branch. IDs and
  paths are configuration, not built-in device names. Each host supports zero
  or one workflow peer.
- **Central Guardian:** the primary host can monitor a peer's upstream status
  even without that repository locally or any local sync enrollment.
- **No automatic conflict resolution:** routine work uses no model. Divergence
  needs a resolver using ordinary tools in an isolated worktree, appropriate
  project checks, and any required user decision.

## Start here

1. [Install, initialize, discover, and select a sync mode](docs/setup.md).
2. [Start the daemon and connect an ordinary Pi Guardian](docs/guardian.md).
3. Use the [Guardian AGENTS.md template](docs/guardian-agent.md).
4. Read [safety and recovery](docs/safety.md),
   [optional provenance](docs/provenance.md), and
   [migration / private-data boundaries](docs/migration.md).

Requirements: Node.js **20.10+** for git-sync, `/usr/bin/git`, and POSIX filesystem
semantics. Direct-peer transport uses `/usr/bin/ssh`. GitHub upstream needs your
own authenticated GitHub CLI; Guardian routing needs Python **3.9+**. The complete
Pi setup needs the dependencies' newer Node/Pi requirements (use Node **22.19+**
and a current Pi). Native Windows is not supported. LaunchAgent installation is
**macOS only**; other POSIX hosts use foreground `daemon run` or their own
supervisor, not launchd.

From a checkout of this public repository:

```sh
npm ci
npm run build
npm run typecheck
npm test
node dist/src/cli.js --help
```

Use a source checkout for this full workflow, including docs/examples and
`extensions/provenance.ts`; do not assume an older npm/core artifact contains
these resources. No private extension package is required. Public integrations:
[pi-agent-notify](https://github.com/roshameow/pi-agent-notify),
[pi-subagent-durable](https://github.com/roshameow/pi-subagent-durable), and
[pi-session-viewer](https://github.com/roshameow/pi-session-viewer).

## Safety in brief

Receipt is not application; a wake request is not a completed sync. Only an
explicitly selected existing checkout can be updated. Tracked/index changes,
colliding untracked or ignored paths, divergence, wrong branch, or uncertain
identity block application. Unrelated untracked/ignored files remain in place.
No automatic clone, stash, reset, clean, push, branch switch, or semantic merge.
Interrupted apply evidence must be preserved, not deleted to force a retry.

These instructions describe implemented interfaces, not a claim that anyone's
production installation has been repointed or that your SSH/GitHub/Pi setup has
been tested. The v0.1 core configuration is **not automatically compatible**.
See [migration](docs/migration.md) before reusing old state. MIT licensed.

## Reusable publication skill

`skills/github-public-release/` contains the portable GitHub publication skill: private
docs/config stay out of Git, tracked files/history and packages are reviewed
separately, and one public implementation must work without private dependencies.
Pi discovers it through this package's `pi.skills` declaration; it can also be
installed in a user skill directory independently. The skill is guidance, not
authorization to publish or delete another repository.
