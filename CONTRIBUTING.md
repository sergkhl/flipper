# Contributing

Use Node.js 26 or newer and install the locked dependencies with `npm ci`.
Run `npm test` and `npm run build` before proposing changes. Tests use fixtures
and must not call live marketplaces or paid model providers.
Changes to deployment mechanics also run `npm run test:release`; those tests
use temporary local Git repositories without activating services.

Keep marketplace access, hardware interpretation, price arithmetic, persistence
and job scheduling behind their existing module boundaries. Price changes need
concrete comparable-offer evidence; AI never supplies prices or missing installed
memory capacity. Record consequential design changes under `docs/adr/`.

Use synthetic fixtures and generic configuration examples. Keep credentials,
seller datasets, private runbooks and personal paths out of code and commits.
Contributions are made under the project's MIT license; preserve third-party
data attribution and license boundaries.

For a routine release, finish the task in its worktree, integrate its committed
changes into the primary `main` checkout, push `main`, and remove the clean merged
task worktree and branch before deploying. Do not deploy directly from a task
worktree or detached HEAD. Preserve other unmerged/dirty worktrees. The repository
instructions in `AGENTS.md` and release checks in `docs/deployment.md` make this
the default sequence.
