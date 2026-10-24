# Hosting Flipper

Run one server process per data directory. Local mode binds to loopback. Hosted
mode requires both `FLIPPER_PUBLIC_ORIGIN` (an exact HTTPS origin) and a strong
private `FLIPPER_ADMIN_TOKEN`; incomplete configuration fails startup. Only the
reverse proxy should reach the hosted application port.

## Container and private configuration

`compose.yml` uses a read-only container root, persistent writable `.data`, a
single service, no host-published port, and an external Docker network selected
by `FLIPPER_DOCKER_NETWORK` (default `web`). Create that network and a `.data`
directory writable by uid/gid 1000 before initial startup. Keep `.env` mode 0600.
Set `FLIPPER_CONTAINER_NAME` and `FLIPPER_EDGE_CONTAINER` for revision probes if
your container names differ from the generic defaults.

The app's optional LiteLLM URLs must be reachable from inside its container.
Supply only a restricted caller key. The app does not need a gateway master key
or upstream provider credentials. Configure gateway routing separately.

Use `deploy/Caddyfile.example` as a reverse-proxy template. Replace the example
hostname and supply only a password hash plus the proxy token to Caddy through
private configuration. For a Caddy environment file containing an Argon2 hash,
use Compose's raw env-file format so dollar signs are preserved. The proxy must
authenticate every `/admin` path, overwrite `X-Flipper-Admin-Token`, remove browser
Authorization before proxying, and strip the proxy token from public requests.
The app independently enforces the public/private API boundary and write origin.

## Release a checked revision

Configure an SSH target with `FLIPPER_DEPLOY_HOST` and `FLIPPER_DEPLOY_PATH`, or
create ignored `.deployment/target.json` containing `{"host":"your-ssh-alias",
"path":"~/services/flipper"}`. Host identity and credentials stay private.
The remote checkout must already be provisioned with its private environment,
data directory, edge and Docker network.

Before every routine deployment, validate and commit the task in its temporary
worktree, integrate it into the primary `main` checkout, push, and remove the
completed worktree. Run the following from the primary checkout, replacing the
example task branch and worktree path:

```sh
git switch main
git fetch origin main
git merge --ff-only origin/main
git merge --no-ff task-branch
git push origin main
git worktree remove /path/to/task-worktree
git branch -d task-branch
npm run deploy -- HEAD
```

Resolve any integration conflicts and rerun affected checks before pushing. Remove
only the completed task worktree after its commits are included in the pushed
main revision. Preserve unrelated unmerged/dirty worktrees and never remove the
primary checkout or runtime data. `AGENTS.md` records this default agent workflow.

Both `deploy/deploy.mjs` and direct `deploy/activate.py` activation enforce the
shared `deploy/verify-release.mjs` preflight. It requires a clean primary checkout
on `main`, with the selected revision equal to both local `main` and freshly
fetched `origin/main`, and refuses clean fully merged linked worktrees that still
need cleanup. The check never deletes worktrees. Detached and feature checkouts
are rejected before build or service operations. It can be run independently:

```sh
node deploy/verify-release.mjs HEAD
```

Deployment runs local release-policy tests (`npm run test:release`) and the
application tests/build, takes a remote lock, refuses a dirty remote
checkout, fast-forwards the VPS primary `main` to the selected published revision,
and repeats tests/build inside the target image.
Activation creates `.data/.deployment-maintenance` before checking existing
jobs/probes. New work, including scheduled work, defers; active work causes
activation to abort. Only this service is replaced. Other services and the edge
configuration are outside an ordinary application release.

Before replacement, activation takes an integrity-checked SQLite backup. It
verifies the image label and edge-to-service health revision, and records private
state in `.deploy-state.json`. Failed activation returns to the prior compatible
image and Compose definition while retaining the current database. Backups and
private deployment files are not committed.
Emergency image rollback can select the previous verified detached revision.
Return to the clean primary `main` workflow before the next routine deployment;
keep unrelated archived/private history outside the published main lineage.

## Daily schedule and schema compatibility

The daily scanner starts with the server but defaults to disabled. Enable it
through the private `/admin/api/schedule` endpoint or the administrator UI.
The strictly next noon is persisted; server restarts preserve eligibility.
No Mac scheduler or browser session is required. A private GET of that endpoint
reports enablement, next start, latest schedule day and category outcomes.

Chợ Tốt cooldowns persist across restarts and defer all marketplace requests
without moving the noon boundary or consuming a daily attempt. Source-cooldown
failures of full refreshes enter a durable recovery queue. Waiting entries resume
automatically after the advertised deadline and the shared busy/maintenance gate.
Retry job costs include earlier attempts and unknown-billing reservations against
the original allowance. A matching due daily category shares the recovery job.
Other failures, cancellations and interrupted claims do not repeat automatically.
The private schedule view shows queued recoveries and lets administrators cancel
waiting entries independently of the daily enable switch.

The shared marketplace allowance is 700 actual attempts per rolling 24 hours,
including every proxy route, retry and redirect. Automatic work has a 150-attempt
category ceiling and leaves at least 250 for manual analysis. Request allowance,
the next permitted start, proxy candidates/health and incremental progress persist
in SQLite. Request exhaustion and unavailable proxies use the same waiting queue
and preserve its AI spending. Proxy catalogs are fetched lazily from the two
fixed GitHub providers described in ADR 0009. Marketplace requests use HTTPS with
certificate verification, four independently paced workers with stable distinct
proxy IPs, and connection-only failover;
there is no direct fallback. LiteLLM and administrator credentials stay outside
these routes. Existing source cooldowns retain precedence over proxy switching.

For a finalized failed refresh made before durable recovery was available, the
private `POST /admin/api/scan-retries` accepts its `job` snapshot, original
`budgetUsd`, and verified `cooldown` (`until`, `observedAt`, HTTP `status`). Keep
that production evidence private. The allowance cannot exceed the configured
manual cap. Re-importing the same original job is idempotent and cannot rearm a
completed or cancelled record. `POST /admin/api/scan-retries/:id/cancel` cancels
a waiting recovery. Public callers cannot access these controls or history.

The scheduler adds `daily_scan_control`, `daily_scan_attempts`, `source_cooldowns`
and `scan_retries`; request controls add `source_requests`, `source_runtime`,
`pool_progress` and a focused-listing scope on retry records without
altering or removing existing data. Older compatible application images ignore
these additive tables. Image rollback keeps the journal so reverting an image
does not reset spent or uncertain scheduled allowances. Do not restore a SQLite
snapshot as an automatic image-rollback step.

Images predating cooldown recovery do not honor the persisted source pause or
execute its queue. Keep that limitation explicit when choosing a rollback image.
Images predating ADR 0009 also lack its rolling request limits and proxy routing.
Images predating ADR 0010 retain the 500-attempt single-worker behavior and cannot
report or run parallel proxy/AI pools. Worker/proxy pacing and spending survive
image replacement. Check the private worker limits and actual new progress after
release; health alone does not prove that collection has resumed.

Before a deliberate database restore, pause scheduling, stop this service, make
a fresh consistent backup, and reconcile any already-started scheduled attempts.
Restoring an old journal without reconciliation could repeat work or spending.
Preserve the original database and caches; never remove persistent data or use
`docker compose down -v` as a release operation. Incompatible future schema
changes require their own migration and restore procedure.

## Verification

Check the running image revision, container health, edge-to-service reachability,
public HTTPS/TLS and the public/private access boundary separately. Verify that
public reads reveal no bookmarks, saved searches, operational settings, schedule
history or AI costs, and that public writes cannot trigger collection. Verify
persistence through a restart. Health alone does not prove marketplace/provider
access, scan quality, or that a future noon execution has occurred.

Keep environment-specific runbooks, credentials, production receipts and backup
locations in private operational records.
