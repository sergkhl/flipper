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
