# Optional session provenance

The lightweight producer is bundled as `extensions/provenance.ts` in this
repository. No separately installed private bridge package is needed. Load it
in an ordinary developer Pi session running in a discovered, enabled repository:

```sh
cd /REPLACE_WITH_EXISTING_CHECKOUT
pi -e "$SOURCE/extensions/provenance.ts"
```

Initialize git-sync first and use the same host/app-path environment as its
daemon. The producer emits session lifecycle and observed HEAD-transition
events to the private `bridge-outbox` beside config; the daemon consumes them
and records provenance. It does not sync files or change Git refs. Missing host
identity or unavailable Git observations do not grant inferred attribution.

The current producer uses `GIT_SYNC_HOME` or `~/.config/git-sync` for its
outbox base; unlike `AppPaths`, it does not read `XDG_CONFIG_HOME`. It does honor
`XDG_STATE_HOME` when finding host identity without a home override. For a new
custom-path setup, initialize with an explicit `GIT_SYNC_HOME` shared by both
producer and daemon. Do not change an existing app home without migrating its
state. A Guardian running outside Git needs no provenance extension: normal
`guardian register` is enough to make that live session a candidate.

```sh
"$NODE" "$CLI" provenance show /REPLACE_WITH_EXISTING_CHECKOUT
"$NODE" "$CLI" provenance show /REPLACE_WITH_EXISTING_CHECKOUT REPLACE_EXACT_COMMIT_OID
"$NODE" "$CLI" provenance record /REPLACE_WITH_EXISTING_CHECKOUT REPLACE_EXACT_COMMIT_OID --source manual --run-id REPLACE_RUN_ID
```

`record` requires an existing commit in a discovered, enabled local repository.
Supported explicit sources are `manual`, `vscode`, `chatgpt-work`, `automation`,
and `external-agent`; `--run-id` is optional. It records a user's nonexclusive
assertion, not cryptographic authorship or a Pi session association.

Observed/created-candidate metadata is evidence, not proof that Pi authored a
commit: another tool may change HEAD in the same interval. Without reliable
attribution, report the source/session as **unknown**. Manual commits and commits
from other tools are normal sync input. Guardian-to-original-session notification
requires a reliable association and live routable target; git-sync cannot infer
one from author text, recency, or the nearest session. Routing incidents to the
configured Guardian does not automatically notify every original developer.
