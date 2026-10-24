import type { Assessment, HardwareProfile, RawListing } from '../shared/types.ts';
import { assessWithRules, normalize } from './hardware.ts';

const priceConflict = 'A stated cash price in the description differs from the displayed asking price';
const essential = new Set<keyof HardwareProfile>(['model', 'cpu', 'gpu', 'gpuClass', 'vramGb', 'ramGb', 'storageGb', 'storageType']);
const canonical = (value: unknown) => normalize(String(value))
  .replace(/^(?:intel(?: core)?|amd|nvidia(?: geforce)?|geforce|dell|lenovo|hp|apple)\s+/, '')
  .replace(/\s*\(\d+\s*cpu\)/g, '');
const compact = (value: unknown) => canonical(value).replace(/[^a-z0-9]/g, '');

/** Reconcile AI omissions with quoted source facts, including retained assessments. */
export function reconcileAssessment(raw: RawListing, input: Assessment): Assessment {
  if (input.method !== 'ai') return input;
  const rules = assessWithRules(raw);
  if (input.kind !== rules.kind) return input;
  const profile = { ...input.profile }, evidence = [...input.evidence], filled = new Set<string>();
  const conflicts = input.conflicts.filter(note => note !== priceConflict || rules.conflicts.includes(note));
  for (const [field, value] of Object.entries(rules.profile)) {
    if (value === null || value === 'unknown') continue;
    const quotes = rules.evidence.filter(item => item.field === field);
    // Capacities and identities come only from explicit seller claims. Class
    // follows a parsed GPU in its listing category; quantity has its own gate.
    const derivedClass = field === 'gpuClass' && profile.gpu === rules.profile.gpu;
    if (!quotes.length && !derivedClass) continue;
    const key = field as keyof HardwareProfile, previous = profile[key];
    if (previous == null || previous === 'unknown') {
      Object.assign(profile, { [field]: value });
      evidence.push(...quotes); filled.add(field);
    } else if (essential.has(key) && (field !== 'model' || input.kind === 'laptop' || input.kind === 'desktop')
      && normalize(String(previous)) !== normalize(String(value))) {
      const before = compact(previous), parsed = compact(value);
      // Model patterns can identify a family while AI preserves a longer SKU.
      // A family prefix is not a contradiction or permission to discard the SKU.
      if (field === 'model' && (before.startsWith(parsed) || parsed.startsWith(before))) continue;
      if (field === 'cpu' && /^(?:i[3579]|ryzen[3579])$/.test(before) && parsed.startsWith(before)) {
        profile.cpu = String(value); evidence.push(...quotes); filled.add(field);
      } else if (before !== parsed) conflicts.push(`Source parsing and AI disagree about ${field}.`);
    }
  }
  if (input.kind === 'gpu' && profile.quantity === null && profile.priceBasis === 'item'
    && rules.profile.gpu && profile.gpu === rules.profile.gpu && !rules.conflicts.length && !rules.risks.length) {
    profile.quantity = 1;
    filled.add('quantity');
    evidence.push({ field: 'quantity', quote: raw.title });
  }
  const unknowns = input.unknowns.filter(note => {
    const match = note.match(/^(\w+) (?:is not stated reliably|has no verifiable supporting quote)\.$/);
    return !match || !filled.has(match[1]!);
  });
  const risks = [...new Set([...input.risks, ...rules.risks])];
  const mergedConflicts = [...new Set([...conflicts, ...rules.conflicts])];
  const excluded = input.eligibility === 'excluded' || rules.eligibility === 'excluded';
  const resolved = unknowns.length < input.unknowns.length || conflicts.length < input.conflicts.length;
  const eligibility = excluded ? 'excluded' : mergedConflicts.length || unknowns.length || risks.length ? 'review'
    : resolved ? 'eligible' : input.eligibility;
  return { ...input, profile, evidence: evidence.filter((item, index, all) =>
    all.findIndex(other => other.field === item.field && other.quote === item.quote) === index),
    conflicts: mergedConflicts, unknowns, risks, eligibility };
}
