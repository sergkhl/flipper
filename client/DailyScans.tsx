import { useEffect, useState } from 'react';
import { CalendarClock, LoaderCircle } from 'lucide-react';
import type { DailyScanStatus } from '../shared/types';
import { message, post, request } from './api';
import { categoryLabels, usd } from './format';
import { ActivityConnection, RunStatus } from './RunStatus';
import type { RunActivityState } from './run-activity';

function vietnamTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
  }) + ' Vietnam' : 'Paused';
}
const states = {
  disabled: 'Automatic scans are paused', scheduled: 'Waiting for the next daily start',
  due: 'Daily scan is due', busy: 'Waiting for the current job or AI test',
  maintenance: 'Waiting for deployment to finish', running: 'Daily scan in progress',
  cooldown: 'Chợ Tốt requests are paused for a source cooldown',
  request_budget: 'Queued work is waiting for marketplace request allowance',
  proxy: 'Queued work is waiting for a working proxy',
};

export default function DailyScans({ initial, activity }: { initial: DailyScanStatus; activity: RunActivityState }) {
  const [schedule, setSchedule] = useState(initial), [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (activity.snapshot) setSchedule(activity.snapshot.schedule);
  }, [activity.snapshot]);
  const toggle = async () => {
    setSaving(true); setError(null);
    try { setSchedule(await post<DailyScanStatus>('/schedule', { enabled: !schedule.enabled })); }
    catch (error) { setError(message(error)); }
    finally { setSaving(false); }
  };
  const cancelRetry = async (id: string) => {
    setSaving(true); setError(null);
    try { await post(`/scan-retries/${id}/cancel`, {}); setSchedule(await request<DailyScanStatus>('/schedule')); }
    catch (error) { setError(message(error)); }
    finally { setSaving(false); }
  };
  return <section className="settings-section daily-scans">
    <div className="section-heading"><h3>Daily market scans</h3><ActivityConnection connection={activity.connection} /><CalendarClock size={19} /></div>
    <p className="section-caption">Laptops, desktops and graphics cards refresh sequentially from <strong>12:00 PM (noon) Vietnam time</strong>,
      including hardware checks and nationwide price comparisons. This runs on the server.</p>
    <div className="daily-scan-control">
      <div><strong>{states[schedule.state]}</strong><p>Next start: {vietnamTime(schedule.nextRunAt)}</p></div>
      <button type="button" className="button button-secondary" disabled={saving} onClick={() => void toggle()}>
        {saving && <LoaderCircle size={15} className="spin" />}{schedule.enabled ? 'Pause daily scans' : 'Enable daily scans'}
      </button>
    </div>
    <p className="section-caption">AI request budgets: laptops {usd(schedule.perCategoryBudgetUsd.laptop)}, desktops {usd(schedule.perCategoryBudgetUsd.desktop)} and graphics cards {usd(schedule.perCategoryBudgetUsd.gpu)}, up to {usd(schedule.dailyBudgetUsd)} per scheduled day.
      Manual scans have a separate budget. Enabling starts at the next noon. Pausing lets the current category finish.</p>
    {schedule.cooldown && <p className="section-caption" role="status">Chợ Tốt requests resume no earlier than <strong>{vietnamTime(schedule.cooldown.until)}</strong>.
      Daily work waits without consuming an attempt. The noon schedule stays in place.</p>}
    {schedule.retries.length > 0 && <div className="daily-scan-history">
      <h4>Queued work and recovery</h4>
      <ul>{schedule.retries.map(retry => <li key={retry.id}>
        <div><strong>{categoryLabels[retry.category]}</strong><RunStatus state={retry.status} /></div>
        <p>{retry.status === 'waiting' ? `Automatic retry after ${vietnamTime(schedule.cooldown && schedule.cooldown.until > retry.dueAt ? schedule.cooldown.until : retry.dueAt)}.` : retry.job.message}
          {` ${usd(retry.spentUsd)} total accounted cost; ${usd(Math.max(0, retry.budgetUsd - retry.spentUsd))} remains in the original allowance.`}
          {retry.aiIssue && ` ${retry.aiIssue}`}</p>
        {retry.status === 'waiting' && <button type="button" className="button button-secondary" disabled={saving} onClick={() => void cancelRetry(retry.id)}>Cancel retry</button>}
      </li>)}</ul>
      <p className="section-caption">Queued recoveries run on the server independently of the daily enable switch. A due daily category shares the recovery job.
        Retry costs include earlier attempts and uncertain charges; the allowance is never reset.</p>
    </div>}
    {schedule.lastRunDay && <div className="daily-scan-history">
      <h4>Latest scheduled day · {schedule.lastRunDay}</h4>
      <ul>{schedule.categories.map(category => {
        const attempt = schedule.attempts.find(attempt => attempt.category === category);
        return <li key={category}>
          <div><strong>{categoryLabels[category]}</strong><RunStatus state={attempt?.status ?? 'pending'} /></div>
          {attempt && <p>{attempt.job?.message ?? (attempt.status === 'interrupted' ? 'Interrupted by an application restart; no automatic retry today.' : 'Starting refresh…')}
            {attempt.job && ` ${attempt.job.scanned} collected · ${attempt.job.benchmarked} compared · ${usd(attempt.job.aiCostUsd)} accounted AI cost.`}
            {attempt.job?.error && ` ${attempt.job.error}`}{attempt.aiIssue && ` ${attempt.aiIssue}`}</p>}
        </li>;
      })}</ul>
    </div>}
    {schedule.marketplace && <p className="section-caption">
      Marketplace requests: {schedule.marketplace.requests.used} / {schedule.marketplace.requests.limit} in the last 24 hours.
      Automatic work allows up to {schedule.marketplace.requests.automaticCategoryLimit} per category; at least {schedule.marketplace.requests.manualReserve} total are reserved for manual analysis.
      {schedule.marketplace.proxies && ` Proxy routing: ${schedule.marketplace.proxies.available} cached candidates available. Direct fallback is disabled.`}
      {schedule.marketplace.proxies?.workerLimit !== undefined && ` ${schedule.marketplace.proxies.activeWorkers ?? 0} active proxy workers; ${schedule.marketplace.proxies.workers ?? 0} assigned of ${schedule.marketplace.proxies.workerLimit} maximum. ${schedule.marketplace.proxies.verified ?? 0} cached routes passed HTTPS checks.`}
      {schedule.marketplace.ai && ` AI calls: ${schedule.marketplace.ai.active} active of ${schedule.marketplace.ai.limit} maximum.`}
    </p>}
    <p className="section-caption">Source cooldowns, request limits and unavailable proxies queue work for automatic recovery. Other failures and interrupted jobs are not automatically repeated.
      After downtime, today's missed daily work and previously queued work can resume.</p>
    {error && <p className="error-text" role="alert">{error}</p>}
  </section>;
}
