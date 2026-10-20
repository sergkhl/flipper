# Application-owned daily market scans with durable category admission

ADR 0007 adds a specific exception for durable source-cooldown recovery; the
other failure, interruption and budget rules below remain in force.

The server schedules laptop, desktop and graphics-card full refreshes at 12:00 PM
(noon) Asia/Ho_Chi_Minh. Reuse the existing collection/interpretation/comparison
pipeline and its single-job exclusion rather than depending on a personal
computer or browser. Scheduling defaults off; private controls enable or pause it
and expose last/next-run status. First activation and resume wait for the strictly
next noon.

SQLite atomically claims each (Vietnam schedule day, category) once, captures the
current scan/memory settings and reserves up to USD 0.25 before work begins.
Admitted scheduled allowances total at most USD 0.75 for a nominal schedule day,
separate from manual settings. Keep full reservations across crashes; receipt
absence cannot prove an interrupted request was free. Reported overages reduce
later admission. External billing and cross-midnight execution are distinct from
this nominal-day request-admission policy.

Service admission synchronously defers for active jobs, AI probes, shutdown and
deployment maintenance. Startup marks abandoned claims interrupted and continues
only unstarted categories for the current eligible day. Never replay older days
or retry failed/interrupted/cancelled categories automatically that day. Preserve
partial observations and continue other categories. Persist terminal journal
state before releasing the busy flag; stop scheduling and drain aborted work
before closing SQLite. Run one service process per data directory. The additive
schema supports image rollback without rolling back the execution journal.
