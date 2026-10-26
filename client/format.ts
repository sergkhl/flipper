import type { Category, RefreshJob } from "../shared/types";
export function originalMoney(value: number, currency = 'VND'): string {
  return new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:currency === 'VND' ? 0 : 2}).format(value);
}

export const categoryLabels: Record<Category, string> = {
  laptop: "Laptops",
  desktop: "Desktops",
  gpu: "Graphics cards",
};
export const categorySingular: Record<Category, string> = {
  laptop: "laptop",
  desktop: "desktop",
  gpu: "GPU",
};
export function money(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : originalMoney(value);
}
export function compactMoney(value: number): string {
  return Number.isFinite(value) ? new Intl.NumberFormat('en-US', {
    style:'currency',currency:'VND',notation:'compact',maximumFractionDigits:1,
  }).format(value) : '—';
}
export function usd(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}
export function date(value: string | null | undefined): string {
  if (!value) return "Never refreshed";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value
    : parsed.toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}
export function timeAgo(value: string | null | undefined): string {
  if (!value) return "No scan yet";
  const elapsed = Date.now() - new Date(value).valueOf();
  if (!Number.isFinite(elapsed)) return "Unknown time";
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}
export function isRunning(job: RefreshJob | null): boolean {
  return Boolean(
    job && ["collecting", "assessing", "comparing"].includes(job.status),
  );
}
export function safeSourceUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return ["https:", "http:"].includes(parsed.protocol)
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}
