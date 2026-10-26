# Repository workflow

Before every routine deployment, finish these steps in order:

1. Validate and commit the task in its temporary worktree.
2. Return to the primary checkout, switch to `main`, and fetch `origin/main`.
3. Integrate the task branch into `main`, resolving conflicts and rerunning
   affected checks when necessary.
4. Push `main` to `origin` and verify that both name the same revision.
5. Remove the completed, clean task worktree with `git worktree remove`, then
   delete its merged local branch.
6. Deploy the checked revision from the clean primary `main` checkout.

Do not deploy from a feature branch, detached HEAD, or linked worktree. Both
deployment entry points verify the release checkout. They also refuse release
while a clean, fully merged linked worktree still needs cleanup. Unmerged or
dirty worktrees belonging to other work must be preserved.

Never remove the primary checkout or its runtime data as worktree cleanup. Do
not force-delete worktrees, force-push `main`, or merge archived/private history
into the published repository to repair a stale local branch.

Use `docs/deployment.md` for release mechanics and rollback. An emergency image
rollback can select the previously verified detached revision; the next routine
deployment must return to the primary `main` workflow above.

## Product decisions and compatibility

The owner is Flipper's only user and administrator. Base decisions on the actual
deployment rather than hypothetical users, older clients, or other installations.

Breaking changes are allowed. Prefer a coherent implementation over compatibility
layers, deprecated fields, dual paths, or migrations that existing deployed data
does not require. Keep documentation and ADRs aligned with the current design;
update or remove outdated material without preserving superseded decision history
or adding deprecation notes.

## Database evidence and reset authority

Before asking about existing records, saved searches, price sources, caches, or
migration needs, inspect the relevant code, configured sources, and deployed
database. Identify the deployment target and the running container's actual data
mount; do not substitute test fixtures, an unverified local database, or old
documentation for deployed evidence. Inspect only the data needed and do not
expose credentials or private record contents.

The owner gives standing authorization to clear, drop, or recreate Flipper's
database, tables, and caches when needed to complete a task, without asking for
confirmation again. This authorization remains in effect until the owner
explicitly revokes or narrows it. A reset must serve the task; permission alone
is not a reason to reset data. It does not authorize deleting credentials,
unrelated services or their data, or the primary checkout, and does not permit
removing runtime data as worktree cleanup.
