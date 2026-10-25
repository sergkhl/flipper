import type { Valuation } from '../shared/types';

const issueLabels: Record<NonNullable<Valuation['evidenceIssue']>, string> = {
  not_compared: 'Not compared yet',
  insufficient_offers: 'Too few matching offers',
  configuration: 'Specifications need review',
  unavailable: 'Listing unavailable',
  outdated_policy: 'Comparison needs refreshing',
  missing_description: 'Seller description needed',
  stale_listing: 'Asking price out of date',
  stale_reference: 'Comparison out of date',
  unverified_price: 'Verify the asking price',
  exchange_rate: 'Exchange rate unavailable',
  retail_price: 'Retail price evidence needed',
};

export function evidenceLabel(value: Valuation): string {
  if (value.status === 'excluded') return 'Outside the working-used criteria';
  if (value.status === 'indicative') return 'Indicative only';
  return value.evidenceIssue ? issueLabels[value.evidenceIssue]
    : value.status === 'needs_review' ? 'Specifications need review' : 'More price evidence needed';
}
