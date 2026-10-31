import { ExternalLink, Info, TrendingDown } from 'lucide-react';
import type { DepreciatedRetailEstimate } from '../shared/retail';
import { compactMoney, date, money, safeSourceUrl } from './format';

export const depreciatedBadge = (estimate: DepreciatedRetailEstimate) => estimate.label === 'Depreciated retail estimate'
  ? 'Below depreciated retail estimate' : 'Below depreciated component estimate';

export default function DepreciatedRetail({estimate, compact = false}: {estimate: DepreciatedRetailEstimate; compact?: boolean}) {
  const amount = (value: number | null) => compact && value !== null ? compactMoney(value) : money(value);
  return <div className={`depreciated-retail${compact ? ' compact-retail' : ''}`}>
    {estimate.opportunity && <span className="deal-badge retail-estimate-badge"><TrendingDown size={13} />{depreciatedBadge(estimate)}</span>}
    <div className="retail-estimate-heading">
      <span>{estimate.label}{estimate.status === 'indicative' ? ' · indicative' : ''}</span>
      <strong>{amount(estimate.estimateVnd)}</strong>
    </div>
    <p className="retail-estimate-caption">
      {estimate.newTotalVnd === null ? 'No verified current retail price' : <>
        {amount(estimate.newTotalVnd)} new × 75% retained value
        {estimate.discountPercent !== null && <> · {Math.abs(estimate.discountPercent).toFixed(1)}% {estimate.discountPercent > 0 ? 'below' : estimate.discountPercent === 0 ? 'difference' : 'above'}</>}
      </>}
    </p>
    {compact ? <small>{estimate.components.length > 1 || estimate.label === 'Depreciated component estimate'
      ? `${estimate.components.length} priced components · partial total${estimate.status === 'indicative' ? ' · no verdict' : ''}`
      : estimate.status === 'indicative' ? 'Incomplete evidence · no verdict' : '25% policy reduction from current new retail'}</small> : <>
      {estimate.rangeVnd && estimate.status === 'indicative' && <p>Indicative range: {money(estimate.rangeVnd[0])}–{money(estimate.rangeVnd[1])}. No deal badge.</p>}
      <p className="section-caption">{estimate.reason}</p>
      {estimate.components.map(part => <div className="component-reference" key={part.kind}>
        <div className="component-heading"><div><span className="eyebrow">{part.kind.toUpperCase()}{part.quantity > 1 ? ` · QUANTITY ${part.quantity}` : ''}</span><h4>{part.label}</h4></div><strong>{money(part.estimateVnd)}</strong></div>
        <p className="section-caption">Lowest matching new total {money(part.newPriceVnd)} × 75%{part.indicative ? ' · indicative variants' : ''}. {part.sources.length} checked offer{part.sources.length === 1 ? '' : 's'}.</p>
        {part.reasons.map(reason => <p className="section-caption" key={reason}>{reason}</p>)}
        <div className="retail-estimate-sources">{part.sources.map(source => <a href={safeSourceUrl(source.url)} key={source.id} target="_blank" rel="noreferrer">
          <strong>{source.source} · {money(source.amount)}{part.quantity > 1 ? ' each' : ''} <ExternalLink size={12} /></strong>
          <span>{source.title}</span><small>Factory-new · VAT included · observed {date(source.observedAt)}</small>
        </a>)}</div>
      </div>)}
      {estimate.omitted.length > 0 && <div className="notice warning-notice"><Info size={17} /><div><strong>Unpriced or omitted</strong><ul>{estimate.omitted.map(omission => <li key={omission}>{omission}</li>)}</ul></div></div>}
      <p className="section-caption">Retail offers cache for seven days. This estimate is independent of the used-market average; the reduction does not measure wear, remaining warranty or completed-sale values.</p>
    </>}
  </div>;
}
