import { ProxyAgent, fetch as proxyFetch } from 'undici';
import { isIP } from 'node:net';
import { SourceDeferredError, type SourceRequestStore } from './source-policy.ts';
import { SOURCE_WORKERS } from './source-policy.ts';
import { WorkPool } from './concurrency.ts';

export const PROXY_SOURCES = [
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/all.txt',
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt',
] as const;
const CHECK_URLS = ['https://example.com/', 'https://www.gstatic.com/generate_204'] as const;
const CHECK_TIMEOUT_MS = 4_000;
const CACHE_MS = 30 * 60_000;
const FAILURE_MS = 15 * 60_000;
const RETRY_MS = 5 * 60_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PROXIES = 200;
interface ProxyState { at: string; uris: string[]; failed: Record<string, string>; verified?: Record<string, string>; cursor: number; retryAt?: string; refreshAfter?: string; }
type Send = (proxy: string, url: string, init: RequestInit) => Promise<Response>;

/** Lists are untrusted input. Only credential-free public IPv4 proxy endpoints qualify. */
export function proxyUri(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || url.username || url.password || !/:\d+\/?$/.test(value.trim())
      || !['', '/'].includes(url.pathname) || url.search || url.hash || isIP(url.hostname) !== 4) return null;
    const [a, b, c] = url.hostname.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b)
      || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b)
      || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113) return null;
    const port = url.port || (url.protocol === 'http:' ? '80' : url.protocol === 'https:' ? '443' : '1080');
    return Number(port) > 0 ? `${url.protocol}//${url.hostname}:${port}` : null;
  } catch { return null; }
}

export class ProxyPool {
  private state: ProxyState;
  private checking = new WorkPool(1);
  private probesRemaining = 12;
  private agents = new Map<string, ProxyAgent>();
  private refreshing: Promise<void> | null = null;
  private now: () => Date;
  private download: typeof fetch;
  private send: Send;
  private probe: (uri: string, signal?: AbortSignal) => Promise<boolean>;
  constructor(private store: Pick<SourceRequestStore, 'runtimeValue' | 'setRuntimeValue'>,
    options: { now?: () => Date; download?: typeof fetch; send?: Send; probe?: (uri: string, signal?: AbortSignal) => Promise<boolean> } = {}) {
    this.now = options.now ?? (() => new Date()); this.download = options.download ?? fetch;
    const saved = store.runtimeValue<ProxyState>('proxy_pool');
    this.state = saved && Array.isArray(saved.uris) ? { ...saved,
      uris: saved.uris.filter(uri => proxyUri(uri) === uri).slice(0, MAX_PROXIES), failed: saved.failed ?? {}, cursor: saved.cursor ?? 0 }
      : { at: '', uris: [], failed: {}, cursor: 0 };
    this.state.verified ??= {};
    this.send = options.send ?? (async (uri, url, init) => {
      let agent = this.agents.get(uri);
      if (!agent) { agent = new ProxyAgent({ uri, connections: 1, connectTimeout: 5_000 }); this.agents.set(uri, agent); }
      return await proxyFetch(url, { method: 'GET', headers: init.headers as Record<string, string>, redirect: 'manual',
        signal: init.signal, dispatcher: agent }) as unknown as Response;
    });
    this.probe = options.probe ?? (async (uri, signal) => {
      // A check website's outage says nothing about the proxy's other destinations.
      // Two independent targets share the previous eight-second candidate bound.
      for (const url of CHECK_URLS) {
        signal?.throwIfAborted();
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(new DOMException('Proxy check timed out', 'TimeoutError')), CHECK_TIMEOUT_MS);
        try {
          const response = await this.send(uri, url, { signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal });
          const okay = response.ok; await response.body?.cancel();
          if (okay) return true;
        } catch { signal?.throwIfAborted(); }
        finally { clearTimeout(timer); }
      }
      return false;
    });
  }
  beginJob(): void { this.probesRemaining = 12; }
  private save(): void { this.store.setRuntimeValue('proxy_pool', this.state); }
  status() {
    const now = this.now().getTime();
    return { enabled: true, sources: [...PROXY_SOURCES], cached: this.state.uris.length,
      available: this.state.uris.filter(uri => Date.parse(this.state.failed[uri] ?? '') <= now || !this.state.failed[uri]).length,
      verified: this.state.uris.filter(uri => this.verified(uri, now)).length,
      fetchedAt: this.state.at || null,
      retryAt: this.state.retryAt && Date.parse(this.state.retryAt) > now ? this.state.retryAt : null };
  }
  async refresh(signal?: AbortSignal): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const now = this.now();
    if (this.state.uris.length && this.state.refreshAfter && Date.parse(this.state.refreshAfter) > now.getTime()) return;
    if (this.state.uris.length && now.getTime() - Date.parse(this.state.at) < CACHE_MS) return;
    if (this.state.retryAt && Date.parse(this.state.retryAt) > now.getTime()) throw new SourceDeferredError(this.state.retryAt, 'proxy');
    this.refreshing = (async () => {
      const results = await Promise.allSettled(PROXY_SOURCES.map(async url => {
        const response = await this.download(url, { redirect: 'error', signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000), headers: { accept: 'text/plain' } });
        if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) {
          await response.body?.cancel(); throw new Error('Proxy list unavailable');
        }
        const reader = response.body?.getReader(); if (!reader) throw new Error('Proxy list is empty');
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Proxy list too large'); }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
        return [...new Set(Buffer.concat(chunks).toString('utf8').split(/\r?\n/).map(proxyUri).filter((uri): uri is string => !!uri))].slice(0, MAX_PROXIES / 2);
      }));
      signal?.throwIfAborted();
      // Interleave the providers instead of letting a larger list crowd one out.
      const lists = results.map(result => result.status === 'fulfilled' ? result.value : []);
      const uris = new Set<string>();
      for (let i = 0; i < MAX_PROXIES / 2; i++) for (const list of lists) if (list[i]) uris.add(list[i]!);
      if (uris.size) {
        this.state.uris = [...uris]; this.state.at = now.toISOString(); delete this.state.retryAt;
        this.state.refreshAfter = new Date(now.getTime() + CACHE_MS).toISOString();
      } else {
        this.state.refreshAfter = new Date(now.getTime() + RETRY_MS).toISOString();
        if (!this.state.uris.length) this.state.retryAt = this.state.refreshAfter;
      }
      this.state.failed = Object.fromEntries(Object.entries(this.state.failed).filter(([uri, until]) =>
        this.state.uris.includes(uri) && Date.parse(until) > now.getTime()));
      this.state.verified = Object.fromEntries(Object.entries(this.state.verified ?? {}).filter(([uri, at]) =>
        this.state.uris.includes(uri) && now.getTime() - Date.parse(at) < CACHE_MS));
      this.save();
      if (!this.state.uris.length) throw new SourceDeferredError(this.state.retryAt!, 'proxy');
    })();
    try { await this.refreshing; } finally { this.refreshing = null; }
  }
  private verified(uri: string, now: number): boolean {
    return (!this.state.failed[uri] || Date.parse(this.state.failed[uri]!) <= now)
      && now - Date.parse(this.state.verified?.[uri] ?? '') < CACHE_MS;
  }
  /** Probe at most twelve candidates per job; every worker gets a distinct proxy IP. */
  async routes(limit = SOURCE_WORKERS, excluded: string[] = [], signal?: AbortSignal): Promise<string[]> {
    return this.checking.run(async () => {
      const now = this.now().getTime();
      if (this.state.retryAt && Date.parse(this.state.retryAt) > now) throw new SourceDeferredError(this.state.retryAt, 'proxy');
      await this.refresh(signal);
      const hosts = new Set(excluded.map(uri => new URL(uri).hostname)), selected: string[] = [];
      const add = (uri: string) => {
        const host = new URL(uri).hostname;
        if (!hosts.has(host) && selected.length < limit) { selected.push(uri); hosts.add(host); }
      };
      for (const uri of this.state.uris) if (this.verified(uri, now)) add(uri);
      const checked = new Set<string>();
      while (selected.length < limit && this.probesRemaining > 0) {
        const candidates: string[] = [], batchHosts = new Set(hosts);
        for (let i = 0; i < this.state.uris.length && candidates.length < Math.min(SOURCE_WORKERS, this.probesRemaining); i++) {
          const uri = this.state.uris[(this.state.cursor + i) % this.state.uris.length]!;
          const host = new URL(uri).hostname;
          if (checked.has(uri) || batchHosts.has(host) || this.verified(uri, now)
            || this.state.failed[uri] && Date.parse(this.state.failed[uri]!) > now) continue;
          candidates.push(uri); batchHosts.add(host); checked.add(uri);
        }
        if (!candidates.length) break;
        this.probesRemaining -= candidates.length; this.state.cursor += candidates.length;
        const results = await Promise.allSettled(candidates.map(uri => this.probe(uri, signal)));
        signal?.throwIfAborted();
        for (let i = 0; i < results.length; i++) {
          const result = results[i]!, uri = candidates[i]!;
          if (result.status === 'fulfilled' && result.value) { this.succeeded(uri); add(uri); }
          else this.failed(uri);
        }
      }
      this.save(); return selected;
    }, signal);
  }
  async fetch(uri: string, url: string, init: RequestInit): Promise<Response> {
    if (new URL(url).protocol !== 'https:') throw new Error('Proxy requests require HTTPS');
    return this.send(uri, url, init);
  }
  failed(uri: string): void {
    this.state.failed[uri] = new Date(this.now().getTime() + FAILURE_MS).toISOString();
    delete this.state.verified![uri];
    const agent = this.agents.get(uri); this.agents.delete(uri); void agent?.destroy().catch(() => {});
    this.save();
  }
  succeeded(uri: string): void { this.state.verified![uri] = this.now().toISOString(); delete this.state.failed[uri]; this.save(); }
  pause(): never {
    this.state.retryAt = new Date(this.now().getTime() + RETRY_MS).toISOString(); this.save();
    throw new SourceDeferredError(this.state.retryAt, 'proxy');
  }
  async close(): Promise<void> { await Promise.allSettled([...this.agents.values()].map(agent => agent.destroy())); this.agents.clear(); }
}
