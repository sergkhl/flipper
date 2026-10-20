# Accepted release decisions

Decisions settled on 20 October 2026:

- Publish Flipper's existing application code as open source; retain the current
  application, optional model integration, hosting and access boundaries.
- Use MIT for application code and project-authored documentation, with a 2026
  Flipper contributors notice. Third-party datasets retain their own terms.
- Publish clean history at the original `sergkhl/flipper` URL using a fresh
  public repository. Retain the predecessor repository and history privately
  under a separate name. This replaces the initial same-repository visibility
  change because GitHub retained old commit objects after a history reset.
  Preserve operational records privately; generalize published installation and
  deployment instructions and omit runtime data and credentials.
- Run full market refreshes for laptops, desktops and standalone graphics cards
  sequentially, using the current scan limits and persistent filter defaults.
- Start daily at **12:00 PM (noon) Vietnam time**, Asia/Ho_Chi_Minh (UTC+7).
- The hosted application owns scheduling and persists execution state in SQLite.
  Other installations default to disabled. Private administrators can enable or
  pause scanning and inspect last/next-run status and category outcomes.
- Scheduled AI request allowances are USD 0.25/category and USD 0.75 per nominal
  Vietnam schedule day, separate from manual budgets. Missing/unavailable AI or
  exhausted budgets retain conservative processing with explicit status.
- Wait for active manual work, provider probes and deployment maintenance.
  First enable/resume waits for the strictly next noon. Catch up only the current
  day's missed work; skip older days. Failed, cancelled or interrupted categories
  consume their automatic attempt; continue only categories not yet started.
  Preserve collected evidence and record failures privately.

ADRs record the publication boundary and durable scheduler design. Operator
interview history and environment-specific evidence are maintained privately.

Follow-up accepted on 20 October 2026: persist Chợ Tốt's cooldown and
automatically recover source-cooldown failures after it expires, including the
incomplete desktop and GPU refreshes. Keep the daily noon boundary and original
budget limits. ADR 0007 records this specific exception to the earlier
no-automatic-retry rule, cumulative spending and shared daily/recovery work.
