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

From a clean checkout:

```sh
git push origin main
npm run deploy -- HEAD
```

Deployment verifies that the full selected revision is pushed to `origin/main`,
runs local tests/build, takes a remote lock, refuses a dirty remote checkout,
checks out the exact revision, and repeats tests/build inside the target image.
Activation creates `.data/.deployment-maintenance` before checking existing
jobs/probes. New work, including scheduled work, defers; active work causes
activation to abort. Only this service is replaced. Other services and the edge
configuration are outside an ordinary application release.

Before replacement, activation takes an integrity-checked SQLite backup. It
verifies the image label and edge-to-service health revision, and records private
state in `.deploy-state.json`. Failed activation returns to the prior compatible
image and Compose definition while retaining the current database. Backups and
private deployment files are not committed.

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

For a finalized failed refresh made before durable recovery was available, the
private `POST /admin/api/scan-retries` accepts its `job` snapshot, original
`budgetUsd`, and verified `cooldown` (`until`, `observedAt`, HTTP `status`). Keep
that production evidence private. The allowance cannot exceed the configured
manual cap. Re-importing the same original job is idempotent and cannot rearm a
completed or cancelled record. `POST /admin/api/scan-retries/:id/cancel` cancels
a waiting recovery. Public callers cannot access these controls or history.

The scheduler adds `daily_scan_control`, `daily_scan_attempts`, `source_cooldowns`
and `scan_retries` tables without
altering or removing existing data. Older compatible application images ignore
these additive tables. Image rollback keeps the journal so reverting an image
does not reset spent or uncertain scheduled allowances. Do not restore a SQLite
snapshot as an automatic image-rollback step.

Images predating cooldown recovery do not honor the persisted source pause or
execute its queue. Keep that limitation explicit when choosing a rollback image.

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
