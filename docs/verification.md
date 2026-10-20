# Verification

Use Node.js 26 or newer with the locked dependencies:

```sh
npm ci
npm test
npm run build
```

The test suite uses fixtures and mocked adapters. It verifies marketplace parsing,
hardware ambiguity, supported price evidence, memory policies, persistence,
public/private API boundaries, maintenance exclusion and job lifecycle. Scheduler
tests cover strict next-noon activation in Vietnam time, sequential once-per-day
admission, competing ticks, busy/probe/maintenance deferral, pause, category
failure, durable crash reservations, current-day-only recovery, budget isolation,
overreported costs and private status/control.

Automated checks establish source behavior. A browser check establishes the
rendered controls and interactions. A source/provider check establishes the
specific live request observed. A deployment check must identify the selected
revision, actual running image, health, persistent data, TLS and access boundary.
None of these alone proves that a future scheduled execution has happened.

Keep dated production receipts and environment-specific diagnostic records
privately. Do not publish credentials, personal state, raw provider responses or
seller datasets as test evidence. New tests must not call live providers or
marketplaces.
