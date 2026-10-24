import { CircleCheck, CircleDashed, CircleSlash, CircleX, Clock3, LoaderCircle, TriangleAlert, Wifi, WifiOff } from 'lucide-react';
import type { RunSummary } from '../shared/types';
import type { RunActivityState } from './run-activity';

export const runStatusLabels: Record<RunSummary['state'] | 'running' | 'pending', string> = {
  collecting: 'Collecting', assessing: 'Extracting specifications', comparing: 'Comparing nationwide',
  running: 'Processing', waiting: 'Waiting to resume', complete: 'Complete', failed: 'Failed',
  cancelled: 'Cancelled', interrupted: 'Interrupted', pending: 'Not started',
};
export function RunStatus({ state }: { state: keyof typeof runStatusLabels }) {
  const processing = ['collecting', 'assessing', 'comparing', 'running'].includes(state);
  const Icon = processing ? LoaderCircle : state === 'complete' ? CircleCheck : state === 'failed' ? CircleX
    : state === 'cancelled' ? CircleSlash : state === 'waiting' ? Clock3 : state === 'interrupted' ? TriangleAlert : CircleDashed;
  return <span className={`run-state state-${state}`} role="img" aria-label={runStatusLabels[state]} title={runStatusLabels[state]}>
    <Icon size={18} className={processing ? 'spin' : undefined} aria-hidden="true" />
  </span>;
}
export function ActivityConnection({ connection }: Pick<RunActivityState, 'connection'>) {
  const label = connection === 'live' ? 'Live updates connected' : connection === 'connecting' ? 'Connecting to live updates' : 'Reconnecting — showing last known state';
  const Icon = connection === 'live' ? Wifi : connection === 'connecting' ? LoaderCircle : WifiOff;
  return <span className={`activity-connection connection-${connection}`} role="status" aria-label={label} title={label}>
    <Icon size={16} className={connection === 'connecting' ? 'spin' : undefined} aria-hidden="true" />
    {connection === 'reconnecting' && <span>Reconnecting</span>}
  </span>;
}
