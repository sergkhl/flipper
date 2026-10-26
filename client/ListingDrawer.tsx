import { useEffect, useState } from "react";
import {
  Bookmark,
  ChevronDown,
  ExternalLink,
  Info,
  LoaderCircle,
  MapPin,
  RefreshCw,
  ShieldCheck,
  TrendingDown,
  TriangleAlert,
} from "lucide-react";
import type {
  PublicSettings,
  AdjustedComparable,
  ComparableOffer,
  ListingDetail,
  ListingState,
  LaptopSpecReference,
  PricedConfiguration,
  ReferencePrice,
} from "../shared/types";
import Drawer from "./Drawer";
import { message } from "./api";
import { date, money, originalMoney, safeSourceUrl } from "./format";
import { evidenceLabel } from "./valuation";
import { hasDedicatedVram, hasMemoryTypeEstimates, hasTechApiMemoryData, memoryDescription, type MemoryTypeMetadata } from "./memory";

export default function ListingDrawer({
  item,
  error,
  onClose,
  onRetry,
  onState,
  onAnalyze,
  running,
  settings,
  canManage,
}: {
  item: ListingDetail | null;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
  onState: (state: Partial<ListingState>) => Promise<unknown>;
  onAnalyze: () => Promise<unknown>;
  running: boolean;
  settings?: PublicSettings;
  canManage: boolean;
}) {
  const [analyzing, setAnalyzing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [photo, setPhoto] = useState(0);
  const missingDetails = item
    ? [...new Set([
        ...(item.valuation.missingDetails ?? []),
        ...(item.valuation.reference?.missingDetails ?? []),
        ...(item.assessment.computer?.missing ?? []),
      ])]
    : [];
  useEffect(() => {
    setPhoto(0);
    setLocalError(null);
  }, [item?.id]);
  const analyze = async () => {
    if (!canManage) return;
    setAnalyzing(true);
    setLocalError(null);
    try {
      await onAnalyze();
    } catch (error) {
      setLocalError(message(error));
    } finally {
      setAnalyzing(false);
    }
  };
  return (
    <Drawer
      title="Price evidence"
      subtitle="A closer look before you make a move"
      onClose={onClose}
      wide
    >
      {!item ? (
        error ? (
          <div className="drawer-error">
            <TriangleAlert size={26} />
            <h3>Couldn’t open this listing</h3>
            <p>{error}</p>
            <button className="button" onClick={onRetry}>
              Try again
            </button>
          </div>
        ) : (
          <div className="loading-state">
            <LoaderCircle size={26} className="spin" />
            <p>Reading the listing and its evidence…</p>
          </div>
        )
      ) : (
        <>
          <div className="detail-title-row">
            <div>
              <span className="detail-location">
                <MapPin size={13} />
                {[item.district, item.region].filter(Boolean).join(" · ")}
              </span>
              <h3>{item.title}</h3>
            </div>
            {canManage && <button
              className={`icon-button save-detail ${item.state.saved ? "is-saved" : ""}`}
              aria-label={
                item.state.saved
                  ? "Remove listing from shortlist"
                  : "Save listing to shortlist"
              }
              aria-pressed={item.state.saved}
              onClick={() => {
                void onState({ saved: !item.state.saved }).catch((error) =>
                  setLocalError(message(error)),
                );
              }}
            >
              <Bookmark
                size={20}
                fill={item.state.saved ? "currentColor" : "none"}
              />
            </button>}
          </div>
          {item.images.length > 0 && (
            <div className="detail-gallery">
              <img
                className="detail-main-photo"
                src={safeSourceUrl(item.images[photo])}
                alt={item.title}
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                }}
              />
              {item.images.length > 1 && (
                <div className="photo-strip">
                  {item.images.slice(0, 8).map((url, index) => (
                    <button
                      key={`${url}-${index}`}
                      className={photo === index ? "selected" : ""}
                      onClick={() => setPhoto(index)}
                      aria-label={`View listing photo ${index + 1}`}
                      aria-pressed={photo === index}
                    >
                      <img
                        src={safeSourceUrl(url)}
                        alt={`Listing photo ${index + 1}`}
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="detail-price-grid">
            <div>
              <span>Seller asking price</span>
              <strong>{money(item.price)}</strong>
              <small>Observed {date(item.observedAt)}</small>
            </div>
            <div
              className={
                item.valuation.opportunity
                  ? "detail-discount deal"
                  : "detail-discount"
              }
            >
              {item.valuation.discountPercent !== null ? (
                <>
                  <span>
                    <TrendingDown size={15} />
                    {item.valuation.reference?.kind === "component_floor"
                      ? item.valuation.discountPercent > 0 ? "Below component value" : "At or above component value"
                      : item.valuation.discountPercent === 0 ? 'Equal to reference' : item.valuation.discountPercent > 0
                      ? "Below reference"
                      : "Above reference"}
                  </span>
                  <strong>
                    {Math.abs(item.valuation.discountPercent).toFixed(1)}
                    <small>%</small>
                  </strong>
                  <small>
                    {item.valuation.reference?.kind === "component_floor"
                      ? "Partial parts total; whole-PC value is not established"
                      : item.valuation.opportunity
                      ? item.valuation.reference?.kind === 'parts_market' ? 'Good price vs same-parts laptops'
                        : item.valuation.reference?.retail?.basis === 'current_new' ? 'Good price vs new retail'
                        : item.valuation.reference?.retail ? 'Good price vs depreciation estimate' : 'Good price: below the supported reference'
                      : item.valuation.status === 'indicative' ? 'Indicative evidence; no firm verdict' : 'Any amount strictly below qualifies; equality does not'}
                  </small>
                </>
              ) : (
                <>
                  <span>Price confidence</span>
                  <strong className="no-value">{evidenceLabel(item.valuation)}</strong>
                  <small>{item.valuation.reason}</small>
                </>
              )}
            </div>
          </div>
          {missingDetails.length > 0 && (
            <MissingDetails
              details={missingDetails}
              scored={item.valuation.status === "valued"}
              confidence={item.valuation.confidence}
            />
          )}
          {(item.assessment.priceOptions?.length ?? 0) > 0 && (
            <div className="priced-configurations">
              <h4>Configurations quoted by this seller</h4>
              {item.assessment.priceOptions!.map((option, index) => (
                <div className="priced-configuration" key={`${option.label}-${index}`}>
                  <div className="priced-configuration-heading">
                    <strong>{option.label}</strong>
                    <strong>{money(option.price)}</strong>
                  </div>
                  {option.price === item.price && (
                    <span className="badge">Matches the displayed asking price</span>
                  )}
                  <p>{configurationDescription(option)}</p>
                  <MemoryTypeEvidence metadata={option} />
                  <blockquote>“{option.evidence}”</blockquote>
                </div>
              ))}
            </div>
          )}
          <div className="detail-link-row">
            <a
              className="button"
              href={safeSourceUrl(item.url)}
              target="_blank"
              rel="noreferrer"
            >
              View on Chợ Tốt
              <ExternalLink size={15} />
            </a>
            {canManage && <button
              className="button subtle"
              onClick={() => void analyze()}
              disabled={running || analyzing}
            >
              {analyzing || running ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <RefreshCw size={15} />
              )}
              Refresh this evidence
            </button>}
          </div>
          {localError && (
            <div className="notice error-notice" role="alert">
              <TriangleAlert size={17} />
              <p>{localError}</p>
            </div>
          )}

          <section className="detail-section">
            <div className="section-heading">
              <h3>{item.valuation.reference?.kind === 'parts_market' ? 'Same-parts price reference'
                : item.category === 'laptop' ? 'Retail price reference' : 'Nationwide price reference'}</h3>
              <span
                className={`badge ${item.valuation.confidence === "high" ? "green-badge" : ""}`}
              >
                {item.valuation.confidence} confidence
              </span>
            </div>
            {item.valuation.reference ? (<>
              <Reference
                reference={item.valuation.reference}
                asking={item.price}
                minComparables={settings?.minComparables ?? 5}
              />
              {item.valuation.alternatives?.map((alternative, index) => (
                <details className="disclosure alternative-reference" key={`${alternative.kind}-${index}`}>
                  <summary>
                    <span>
                      <strong>{alternative.kind === 'parts_market' ? 'Same-parts laptop average'
                        : alternative.retail?.basis === 'current_new' ? 'Lowest new retail price' : 'Launch-price depreciation estimate'}: {money(alternative.average)}</strong>
                      <small>{alternative.kind === 'historical_depreciation' ? 'Shown for context; it does not decide or cap the verdict'
                        : 'Shown beside the deciding reference; the lower firm one decides'}</small>
                    </span>
                    <ChevronDown size={15} />
                  </summary>
                  <Reference reference={alternative} asking={item.price} minComparables={settings?.minComparables ?? 5} />
                </details>
              ))}
            </>) : (
              <div className="evidence-empty">
                <ShieldCheck size={22} />
                <div>
                  <strong>
                    {evidenceLabel(item.valuation)}
                  </strong>
                  <p>{item.valuation.reason}</p>
                  <span>
                    {item.category === 'laptop' ? /mac\s*book/i.test(item.title)
                      ? 'A dated new retail or original launch price is needed for this exact configuration.'
                      : `Same-parts comparisons need an exact processor model, graphics, RAM and storage, and at least 3 independent sellers (${Math.max(5, settings?.minComparables ?? 5)} for a verdict).`
                      : `At least 3 independent sellers support an indicative average; scoring needs ${Math.max(5, settings?.minComparables ?? 5)} per required price pool.`}
                  </span>
                </div>
              </div>
            )}
          </section>

          <section className="detail-section">
            <div className="section-heading">
              <h3>Specification check</h3>
              <span className="badge">
                {item.assessment.method === "ai"
                  ? "AI extraction"
                  : "Local rules"}
              </span>
            </div>
            <p className="section-caption">{item.assessment.status}</p>
            <div className="spec-grid">
              {[
                ["Model", item.assessment.profile.model],
                ...(item.category === "laptop" ? [
                  ["Model year", item.assessment.profile.modelYear?.toString()],
                  ["Screen size", item.assessment.profile.screenInches ? `${item.assessment.profile.screenInches} inches` : null],
                  ["CPU cores", item.assessment.profile.cpuCores?.toString()],
                  ["GPU cores", item.assessment.profile.gpuCores?.toString()],
                ] : []),
                ["CPU", item.assessment.profile.cpu],
                ["GPU", item.assessment.profile.gpuClass === "integrated"
                  ? item.assessment.profile.gpu || "Integrated graphics"
                  : item.assessment.profile.gpuInclusion === "absent"
                  ? "No discrete GPU included"
                  : item.assessment.profile.gpu],
                ["GPU type", item.assessment.profile.gpuClass === "integrated"
                  ? "Integrated"
                  : item.assessment.profile.gpuInclusion === "absent"
                  ? "Not applicable"
                  : item.assessment.profile.gpuClass],
                [
                  "GPU VRAM capacity / type",
                  hasDedicatedVram(item.assessment.profile)
                    ? memoryDescription(item.assessment.profile, "vram", item.assessment)
                    : item.assessment.profile.gpuClass === "integrated"
                      ? "Not applicable · integrated graphics"
                      : "Not applicable · no discrete GPU included",
                ],
                [
                  "System RAM capacity / type",
                  item.category === "gpu" ? "Not applicable · standalone GPU" : memoryDescription(item.assessment.profile, "ram", item.assessment),
                ],
                [
                  "RAM format / speed",
                  [
                    item.assessment.profile.ramFormFactor,
                    item.assessment.profile.ramSpeedMhz
                      ? `${item.assessment.profile.ramSpeedMhz} MHz`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || null,
                ],
                [
                  "Storage",
                  item.assessment.profile.storageGb === null
                    ? null
                    : `${item.assessment.profile.storageGb} GB ${item.assessment.profile.storageType || ""}`,
                ],
                ["Condition", item.condition],
                ["Price basis", item.assessment.profile.priceBasis],
                ...(item.assessment.computer ? [
                  ["Computer form factor", item.assessment.computer.formFactor],
                  ["CPU count", item.assessment.computer.cpuCount?.toString()],
                  ["Motherboard", item.assessment.computer.motherboard],
                  ["Power supply", item.assessment.computer.psu],
                  ["Case", item.assessment.computer.case],
                  ["Cooling", item.assessment.computer.cooling],
                  ["RAM error correction", item.assessment.computer.ramEcc],
                  ["Replaceable RAM", replaceabilityLabel(item.assessment.computer.ramReplaceable)],
                  ["Replaceable storage", replaceabilityLabel(item.assessment.computer.storageReplaceable)],
                ] : []),
              ].map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong
                    className={
                      !value || value === "unknown" || value === "Capacity / type unknown" ? "unknown-spec" : ""
                    }
                  >
                    {value || "Not specified"}
                  </strong>
                </div>
              ))}
            </div>
            <MemoryTypeEvidence metadata={item.assessment} />
            {!!item.assessment.laptopSpecReferences?.length && (
              <LaptopSpecEvidence references={item.assessment.laptopSpecReferences} />
            )}
            {(item.assessment.risks.length > 0 ||
              item.assessment.unknowns.length > 0 ||
              item.assessment.conflicts.length > 0) && (
              <div className="assessment-notes">
                {item.assessment.conflicts.map((note, index) => (
                  <p key={`conflict-${index}`} className="conflict-note">
                    <TriangleAlert size={15} />
                    <span>{note}</span>
                  </p>
                ))}
                {item.assessment.risks.map((note, index) => (
                  <p key={`risk-${index}`}>
                    <TriangleAlert size={15} />
                    <span>{note}</span>
                  </p>
                ))}
                {item.assessment.unknowns.map((note, index) => (
                  <p key={`unknown-${index}`}>
                    <Info size={15} />
                    <span>{note}</span>
                  </p>
                ))}
              </div>
            )}
            {item.assessment.evidence.length + (item.assessment.computer?.evidence.length ?? 0) > 0 && (
              <details className="disclosure">
                <summary>
                  Source evidence for extracted specs
                  <ChevronDown size={15} />
                </summary>
                <div className="quote-list">
                  {[...item.assessment.evidence, ...(item.assessment.computer?.evidence ?? [])].map((evidence, index) => (
                    <div key={index}>
                      <span>{evidence.field}</span>
                      <blockquote>“{evidence.quote}”</blockquote>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </section>

          <section className="detail-section">
            <div className="section-heading">
              <h3>Observed price history</h3>
              <span className="badge">Local records</span>
            </div>
            {item.history.length > 1 && <HistoryChart history={item.history} />}
            <div className="history-list">
              {item.history
                .slice()
                .reverse()
                .slice(0, 10)
                .map((point, index) => (
                  <div key={`${point.at}-${index}`}>
                    <span>
                      <span className="history-dot" />
                      {date(point.at)}
                    </span>
                    <strong>{money(point.price)}</strong>
                  </div>
                ))}
            </div>
            {item.history.length <= 1 && (
              <p className="section-caption">
                No earlier price changes recorded. History builds as market data is refreshed.
              </p>
            )}
          </section>
          <section className="detail-section source-description">
            <div className="section-heading">
              <h3>Seller’s description</h3>
              <span className="badge">Original source</span>
            </div>
            <p>
              {item.description || "No description was returned by the source."}
            </p>
            <div className="seller-meta">
              <span>
                Seller type:{" "}
                {item.sellerType === "business"
                  ? "business"
                  : item.sellerType === "private"
                    ? "private"
                    : "not stated"}
              </span>
              {item.displayAge && <span>Source age: {item.displayAge}</span>}
            </div>
          </section>
        </>
      )}
    </Drawer>
  );
}

function RetailReference({reference}: {reference: ReferencePrice}) {
  const evidence = reference.retail!;
  const historical = evidence.basis === 'historical_depreciation';
  return <>
    <div className="reference-summary"><div>
      <span>{reference.label}{evidence.indicative ? ' · indicative only' : ''}</span>
      <strong>{money(reference.average)}</strong>
      {evidence.indicative && reference.min !== reference.max && <p>Range: {money(reference.min)}–{money(reference.max)}</p>}
      <p>{reference.methodology}</p>
    </div></div>
    {historical && <p className="section-caption">
      Original new price: {money(evidence.originalVnd)}.
      {' '}Model age: {evidence.ageYears !== null ? `${evidence.ageYears.toFixed(1)} years`
        : evidence.ageRange ? `${evidence.ageRange[0].toFixed(1)}–${evidence.ageRange[1].toFixed(1)} years` : 'Unknown'}.
      {' '}Depreciation class: {evidence.laptopClass === 'apple_silicon' ? 'Apple Silicon' : evidence.laptopClass === 'business'
        ? 'Windows business/premium' : evidence.laptopClass === 'consumer' ? 'Consumer/gaming/Intel Mac' : 'Uncertain'}.
      {evidence.retention !== null && ` Retained value: ${(100*evidence.retention).toFixed(1)}% (drop ${(100*(1-evidence.retention)).toFixed(1)}%).`}
    </p>}
    <p className="section-caption">Working-used condition assumed. Confirm battery health and wear with the seller.</p>
    {evidence.reasons.length > 0 && <div className="notice warning-notice"><Info size={17}/><p>{evidence.reasons.join(' ')}</p></div>}
    <p className="section-caption">Current retail lookup: {evidence.lookupStatus === 'complete' ? 'complete within configured sources' : evidence.lookupStatus === 'failed' ? 'incomplete / failed' : 'not checked'} · {date(evidence.checkedAt)}.</p>
    {evidence.fx && <p className="section-caption">Foreign prices converted to VND using {evidence.fxStale ? 'a stale exchange rate' : 'exchange rates'} dated {evidence.fx.date}, fetched {date(evidence.fx.fetchedAt)}. Rates are cached for 7 days.{evidence.fxStale && ' Stale-rate estimates cannot support deal badges.'}</p>}
    {evidence.sources.map((source,index) => <div className="component-reference" key={source.id}>
      <div className="component-heading"><div>
        <span className="eyebrow">{source.basis === 'launch_msrp' ? 'Launch MSRP' : source.basis === 'launch_retail' ? 'Original launch retail' : index === 0 ? 'Lowest verified new offer' : 'New retail offer'}</span>
        <h4><a href={safeSourceUrl(source.url)} target="_blank" rel="noreferrer">{source.title} <ExternalLink size={13}/></a></h4>
      </div><strong>{money(source.amountVnd)}</strong></div>
      <p className="section-caption">{source.source} · original {originalMoney(source.amount,source.currency)} · {source.market} · price date {source.priceDate ?? 'unknown'} · checked {date(source.observedAt)}</p>
      {source.basis === 'current_new' && <p className="section-caption">{source.available ? 'In stock when checked' : 'Availability unverified'} · {source.totalCostKnown && source.shipsToVietnam ? 'Includes tax and mandatory Vietnam delivery' : 'Complete Vietnam purchase cost is unverified'}</p>}
      {source.releaseSourceUrl && <p className="section-caption"><a href={safeSourceUrl(source.releaseSourceUrl)} target="_blank" rel="noreferrer">Model release evidence</a>: {source.releaseDate ?? source.releaseYear ?? 'unknown'}</p>}
      {source.configurationSourceUrl && <p className="section-caption"><a href={safeSourceUrl(source.configurationSourceUrl)} target="_blank" rel="noreferrer">Original configuration evidence</a> (specifications only)</p>}
    </div>)}
  </>;
}

function Reference({
  reference,
  asking,
  minComparables,
}: {
  reference: ReferencePrice;
  asking: number;
  minComparables: number;
}) {
  if (reference.retail) return <RetailReference reference={reference} />;
  const component = reference.kind === "component_floor";
  const sameParts = reference.kind === "parts_market";
  const adjusted = reference.kind === "adjusted_configuration" || sameParts;
  const baseCount = reference.baseSampleCount ?? reference.adjustedOffers?.length ?? reference.offers.length;
  const indicative = reference.sampleCount < Math.max(5, minComparables);
  return (
    <>
      <div
        className={`reference-summary ${component ? "partial-summary" : ""}`}
      >
        <div>
          <span>
            {sameParts
              ? indicative ? "Indicative same-parts average" : "Same-parts laptop average"
              : adjusted
              ? indicative ? "Indicative adjusted average" : "Component-adjusted average"
              : indicative
              ? "Indicative average"
              : component
              ? "Partial component baseline"
              : "Filtered arithmetic mean"}
          </span>
          <strong>{money(reference.average)}</strong>
          <p>{reference.label}</p>
        </div>
        <span className="reference-icon">
          <ShieldCheck size={25} />
        </span>
      </div>
      {indicative && (
        <div className="notice warning-notice">
          <Info size={17} />
          <p>{sameParts
            ? `${reference.sampleCount} independent sellers support this average. At least ${Math.max(5, minComparables)} are needed for a verdict.`
            : adjusted
            ? `The smallest required price pool has ${reference.sampleCount} independent sellers. Each pool needs at least ${Math.max(5, minComparables)} for discount scoring.`
            : `${reference.sampleCount} independent offers support this average and observed range. At least ${Math.max(5, minComparables)} are needed for discount scoring.`}</p>
        </div>
      )}
      {component && (
        <div className="notice warning-notice">
          <Info size={17} />
          <p>
            Only the components below are supported. This sum is a partial
            baseline; other parts and whole-system value are unpriced.
          </p>
        </div>
      )}
      {sameParts && (
        <div className="adjusted-evidence-counts">
          <div>
            <strong>{reference.sampleCount}</strong>
            <span>independent sellers with the same processor and graphics</span>
          </div>
          <div>
            <strong>{reference.adjustedOffers?.filter((offer) => !offer.adjustments.length).length ?? 0}</strong>
            <span>with the same RAM and storage</span>
          </div>
          <p>Brand and model line are ignored. Each seller contributes one laptop; RAM and storage differences are priced at reviewed per-GB rates.</p>
        </div>
      )}
      {adjusted && !sameParts && (
        <div className="adjusted-evidence-counts">
          <div>
            <strong>{baseCount}</strong>
            <span>independent computer offers</span>
          </div>
          <div>
            <strong>{reference.sampleCount}</strong>
            <span>sellers in the smallest required price pool</span>
          </div>
          <p>Each computer contributes one adjusted price. Component offers support the additions and deductions; they do not add extra computer observations.</p>
        </div>
      )}
      <details className="disclosure methodology-details">
        <summary>How this average was calculated <ChevronDown size={15} /></summary>
        <p className="methodology-text">{reference.methodology}</p>
      </details>
      {!component && <PriceRange reference={reference} asking={asking} />}
      {component ? (
        reference.components.map((part, index) => (
          <div className="component-reference" key={`${part.kind}-${index}`}>
            <div className="component-heading">
              <div>
                <span className="eyebrow">
                  {part.kind.toUpperCase()} · QUANTITY {part.quantity}
                </span>
                <h4>{part.label}</h4>
              </div>
              <strong>{money(part.average * part.quantity)}</strong>
            </div>
            <p className="section-caption">
              {money(part.average)} per matched item · {part.offers.length}{" "}
              independent offers
            </p>
            <OffersTable offers={part.offers} />
          </div>
        ))
      ) : adjusted ? (
        <>
          <div className="comparison-heading">
            <h4>{baseCount} {sameParts ? 'laptops compared with' : 'computer offers adjusted to'} this configuration</h4>
            <span>Across Vietnam</span>
          </div>
          <AdjustedOffers offers={reference.adjustedOffers ?? []} />
        </>
      ) : (
        <>
          <div className="comparison-heading">
            <h4>{reference.sampleCount} independent comparable offers</h4>
            <span>Across Vietnam</span>
          </div>
          <OffersTable offers={reference.offers} />
        </>
      )}
      <p className="footnote">
        Candidate and same-seller offers are excluded. Minimum {Math.max(5, minComparables)}{" "}
        other independent sellers {adjusted && !sameParts ? "in the computer pool and each required component pool " : ""}for scoring; smaller samples of at least three are indicative only.
        Reference calculated {date(reference.observedAt)}. Each offer shows when its price was observed.
      </p>
      {reference.rejected.length > 0 && (
        <details className="disclosure rejected-offers">
          <summary>
            {reference.rejected.length} offers filtered out
            <ChevronDown size={15} />
          </summary>
          <div className="rejected-list">
            {reference.rejected.map((offer, index) => (
              <div key={`${offer.id}-${index}`}>
                <a
                  href={safeSourceUrl(offer.url)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {offer.title}
                  <ExternalLink size={12} />
                </a>
                <span>
                  {money(offer.price)} ·{" "}
                  {offer.rejectedReason ||
                    "Does not meet the comparison criteria"}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function LaptopSpecEvidence({ references }: { references: LaptopSpecReference[] }) {
  return (
    <details className="disclosure">
      <summary>Laptop specification references <ChevronDown size={15} /></summary>
      <p className="methodology-text">These catalog configurations help check the model. Installed memory, screen size and core counts still need support in the seller’s listing.</p>
      <div className="quote-list">
        {references.map((reference) => (
          <div key={reference.url}>
            <a href={safeSourceUrl(reference.url)} target="_blank" rel="noreferrer">
              {reference.name} <ExternalLink size={12} />
            </a>
            <p>{[
              reference.cpu,
              reference.modelYear?.toString(),
              reference.screenInches ? `${reference.screenInches} inches` : null,
              reference.cpuCores ? `${reference.cpuCores} CPU cores` : null,
              reference.gpuCores ? `${reference.gpuCores} GPU cores` : null,
              reference.ramGb ? `${reference.ramGb} GB ${reference.ramType || "RAM"}` : reference.ramType,
              reference.storageGb ? `${reference.storageGb} GB storage` : null,
            ].filter(Boolean).join(" · ")}</p>
            {reference.sourceUrls.map((url, index) => (
              <a key={url} href={safeSourceUrl(url)} target="_blank" rel="noreferrer">Catalog source {index + 1} <ExternalLink size={12} /> </a>
            ))}
            <span>Cached {date(reference.fetchedAt)} · external catalog, unconfirmed</span>
          </div>
        ))}
      </div>
      <p className="memory-data-attribution">
        Adapted laptop specifications from <a href={safeSourceUrl("https://gettechapi.github.io/TechAPI/")} target="_blank" rel="noreferrer">TechAPI</a>
        {" · "}<a href={safeSourceUrl("https://creativecommons.org/licenses/by-sa/4.0/")} target="_blank" rel="noreferrer">CC BY-SA 4.0</a>.
      </p>
    </details>
  );
}

function MemoryTypeEvidence({ metadata }: { metadata: MemoryTypeMetadata }) {
  if (!hasMemoryTypeEstimates(metadata)) return null;
  const inferences = metadata.memoryTypeInferences?.filter((entry) => entry.types.length) ?? [];
  const coveredFields = new Set(inferences.map((entry) => entry.field));
  const legacySources = metadata.memoryTypeSources?.filter((source) => !coveredFields.has(source.field)) ?? [];
  return (
    <div className="memory-type-sources">
      <h4>Memory type evidence</h4>
      <p>Hardware compatibility can identify a type or narrow the possibilities. It does not establish installed capacity or speed.</p>
      {inferences.map((inference, index) => (
        <div className="memory-type-inference" key={`${inference.field}-${index}`}>
          <strong>{inference.field === "ramType" ? "RAM" : "VRAM"}: {inference.types.join(" / ")}</strong>
          <span className="memory-inference-status">
            {inference.manufacturerVerified
              ? inference.types.length > 1
                ? "Manufacturer-checked possibilities · installed type unconfirmed"
                : "Manufacturer-checked hardware inference"
              : "External catalog hint · unconfirmed"}
          </span>
          <p>{inference.basis}</p>
          {inference.sources.map((source, sourceIndex) => (
            <a key={`${source.url}-${sourceIndex}`} href={safeSourceUrl(source.url)} target="_blank" rel="noreferrer">
              <span>{source.label}</span>
              <ExternalLink size={14} />
            </a>
          ))}
        </div>
      ))}
      {legacySources.map((source, index) => (
        <a key={`${source.field}-${source.part}-${index}`} href={safeSourceUrl(source.url)} target="_blank" rel="noreferrer">
          <span>
            <strong>{source.field === "ramType" ? "RAM" : "VRAM"}: {source.value} · inferred</strong>
            <span>{source.part} · manufacturer specifications</span>
          </span>
          <ExternalLink size={14} />
        </a>
      ))}
      {hasTechApiMemoryData(metadata) && (
        <p className="memory-data-attribution">
          Includes adapted memory data from{" "}
          <a href={safeSourceUrl("https://gettechapi.github.io/TechAPI/")} target="_blank" rel="noreferrer">TechAPI</a>
          {" · "}
          <a href={safeSourceUrl("https://creativecommons.org/licenses/by-sa/4.0/")} target="_blank" rel="noreferrer">CC BY-SA 4.0</a>.
          {" "}Part names and memory types are normalized; manufacturer checks and possible variants are shown above.
        </p>
      )}
    </div>
  );
}

function configurationDescription(option: PricedConfiguration) {
  const { profile } = option;
  return [
    profile.cpu,
    profile.gpuClass === "integrated" ? profile.gpu || "Integrated graphics"
      : profile.gpuInclusion === "absent" ? "No discrete GPU included" : profile.gpu,
    `RAM: ${memoryDescription(profile, "ram", option)}`,
    hasDedicatedVram(profile) ? `VRAM: ${memoryDescription(profile, "vram", option)}` : null,
    profile.storageGb === null ? null : `${profile.storageGb} GB ${profile.storageType || "storage"}`,
  ].filter(Boolean).join(" · ");
}

function replaceabilityLabel(value: boolean | null) {
  return value === null ? null : value ? "Yes, source verified" : "No";
}

function MissingDetails({ details, scored, confidence }: {
  details: string[];
  scored: boolean;
  confidence: string;
}) {
  return (
    <details className="disclosure missing-hardware-details">
      <summary>
        <span>
          <Info size={16} />
          <span>
            <strong>{scored ? "Scored with missing hardware details" : "Hardware details missing"}</strong>
            <small>{details.length} {details.length === 1 ? "detail" : "details"} to check · {confidence} confidence</small>
          </span>
        </span>
        <ChevronDown size={15} />
      </summary>
      <div>
        <p>Unspecified details may affect the whole-computer comparison.</p>
        <ul>{details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
      </div>
    </details>
  );
}

function AdjustedOffers({ offers }: { offers: AdjustedComparable[] }) {
  return (
    <div className="adjusted-offers">
      {offers.map((offer, index) => (
        <details className="disclosure adjusted-offer" key={`${offer.id}-${index}`}>
          <summary>
            <span>
              <strong>{offer.title}</strong>
              <small>{offer.configurationLabel} · {offer.region || "Vietnam"}</small>
            </span>
            <span className="adjusted-offer-result">
              <strong>{money(offer.price)}</strong>
              <small>Adjusted comparison price</small>
            </span>
            <ChevronDown size={15} />
          </summary>
          <div className="adjusted-offer-body">
            <a className="adjusted-source-link" href={safeSourceUrl(offer.url)} target="_blank" rel="noreferrer">
              View seller’s computer offer <ExternalLink size={13} />
            </a>
            <p className="section-caption">Observed {date(offer.observedAt)} · {offer.configurationLabel}</p>
            <dl className="adjustment-calculation">
              <div>
                <dt>Seller asking price for this configuration</dt>
                <dd>{money(offer.askingPrice)}</dd>
              </div>
              {offer.adjustments.map((part, partIndex) => (
                <div key={`${part.kind}-${part.operation}-${partIndex}`}>
                  <dt>{part.operation === "remove" ? "Remove" : "Add"} {part.label}{part.quantity !== 1 ? ` × ${part.quantity}` : ""}</dt>
                  <dd>{part.operation === "remove" ? "−" : "+"} {money(part.total)}</dd>
                </div>
              ))}
              <div className="adjustment-total">
                <dt>Adjusted to this listing’s configuration</dt>
                <dd>= {money(offer.price)}</dd>
              </div>
            </dl>
            {offer.adjustments.length === 0 && <p className="section-caption">This configuration already matches; no component adjustment was needed.</p>}
            {offer.missingDetails.length > 0 && (
              <div className="adjusted-missing-details">
                <strong>Missing base details</strong>
                <ul>{offer.missingDetails.map((detail) => <li key={detail}>{detail}</li>)}</ul>
              </div>
            )}
            {offer.adjustments.map((part, partIndex) => (
              <details className="disclosure adjustment-sources" key={`${part.kind}-${part.operation}-sources-${partIndex}`}>
                <summary>
                  <span>
                    <strong>{part.operation === "remove" ? "Deduction" : "Addition"}: {part.label}</strong>
                    <small>{part.ratePerGb ? `${money(part.ratePerGb)} per GB from the reviewed RAM/SSD table`
                      : `${money(part.average)} per matched item · ${part.offers.length} independent sellers`}</small>
                  </span>
                  <ChevronDown size={15} />
                </summary>
                {part.ratePerGb ? <p className="section-caption">Approximate used-part value, reviewed by hand from stored used listings; it applies whether or not the part is soldered.</p>
                  : <OffersTable offers={part.offers} />}
              </details>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

function OffersTable({ offers }: { offers: ComparableOffer[] }) {
  return (
    <div className="offers-table">
      <div className="offers-table-head">
        <span>Matching used offer</span>
        <span>Asking price</span>
      </div>
      {offers.map((offer, index) => (
        <a
          className="offer-row"
          href={safeSourceUrl(offer.url)}
          target="_blank"
          rel="noreferrer"
          key={`${offer.id}-${index}`}
        >
          <div>
            <strong>{offer.title}</strong>
            <span>
              {offer.region || "Vietnam"} · {date(offer.observedAt)}
            </span>
          </div>
          <div>
            <strong>{money(offer.price)}</strong>
            <ExternalLink size={13} />
          </div>
        </a>
      ))}
    </div>
  );
}

function PriceRange({
  reference,
  asking,
}: {
  reference: ReferencePrice;
  asking: number;
}) {
  const adjusted = reference.kind === "adjusted_configuration";
  const lower = Math.min(asking, reference.min) * 0.92;
  const upper = Math.max(asking, reference.max) * 1.08;
  const position = (value: number) =>
    Math.max(
      0,
      Math.min(100, ((value - lower) / Math.max(1, upper - lower)) * 100),
    );
  return (
    <div className="price-range">
      <div className="range-labels">
        <span>
          {adjusted ? "Adjusted comparable low" : "Comparable low"} <strong>{money(reference.min)}</strong>
        </span>
        <span>
          {adjusted ? "Adjusted comparable high" : "Comparable high"} <strong>{money(reference.max)}</strong>
        </span>
      </div>
      <div
        className="range-chart"
        role="img"
        aria-label={`This listing’s asking price ${money(asking)}, ${adjusted ? "component-adjusted" : "reference"} average ${money(reference.average)}, ${adjusted ? "adjusted " : ""}comparable range ${money(reference.min)} to ${money(reference.max)}`}
      >
        <div className="range-line" />
        <div
          className="range-band"
          style={{
            left: `${position(reference.min)}%`,
            width: `${position(reference.max) - position(reference.min)}%`,
          }}
        />
        {(adjusted ? reference.adjustedOffers ?? reference.offers : reference.offers).map((offer, index) => (
          <span
            className="range-offer-dot"
            key={`${offer.id}-${index}`}
            style={{ left: `${position(offer.price)}%` }}
            title={`${adjusted ? "Adjusted comparison price" : "Seller asking price"}: ${money(offer.price)}`}
          />
        ))}
        <span
          className="range-marker asking-marker"
          style={{ left: `${position(asking)}%` }}
        />
        <span
          className="range-marker mean-marker"
          style={{ left: `${position(reference.average)}%` }}
        />
      </div>
      <div className="range-legend">
        <span>
          <i className="asking-key" />
          This listing {money(asking)}
        </span>
        <span>
          <i className="mean-key" />
          {adjusted ? "Adjusted average" : "Average"} {money(reference.average)}
        </span>
      </div>
    </div>
  );
}

function HistoryChart({ history }: { history: ListingDetail["history"] }) {
  const points = history.slice(-20);
  const low = Math.min(...points.map((point) => point.price));
  const high = Math.max(...points.map((point) => point.price));
  const coordinates = points
    .map(
      (point, index) =>
        `${12 + (index / Math.max(1, points.length - 1)) * 476},${75 - ((point.price - low) / Math.max(1, high - low)) * 60}`,
    )
    .join(" ");
  return (
    <svg
      className="history-chart"
      viewBox="0 0 500 95"
      role="img"
      aria-label={`Recorded price changed from ${money(points[0].price)} to ${money(points[points.length - 1].price)}`}
    >
      <line x1="12" y1="75" x2="488" y2="75" stroke="#e0e5df" />
      <polyline
        points={coordinates}
        fill="none"
        stroke="#257b58"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {points.map((point, index) => (
        <circle
          key={`${point.at}-${index}`}
          cx={12 + (index / Math.max(1, points.length - 1)) * 476}
          cy={75 - ((point.price - low) / Math.max(1, high - low)) * 60}
          r="3.5"
          fill="#257b58"
        />
      ))}
    </svg>
  );
}
