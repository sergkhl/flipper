import { timingSafeEqual } from 'node:crypto';

export interface ServerOptions {
  publicOrigin?: string;
  adminToken?: string;
  revision?: string;
}
export interface ServerAccess {
  hosted: boolean;
  publicOrigin: string | null;
  adminToken: string | null;
  revision: string;
}

export function serverOptions(env: NodeJS.ProcessEnv = process.env): ServerOptions {
  return { publicOrigin: env.FLIPPER_PUBLIC_ORIGIN, adminToken: env.FLIPPER_ADMIN_TOKEN, revision: env.FLIPPER_REVISION };
}

export function validateServerAccess(options: ServerOptions): ServerAccess {
  const { publicOrigin, adminToken } = options;
  const hosted = publicOrigin !== undefined || adminToken !== undefined;
  if (hosted) {
    if (!publicOrigin || !adminToken) throw new Error('Hosted mode requires both FLIPPER_PUBLIC_ORIGIN and FLIPPER_ADMIN_TOKEN');
    let origin: URL;
    try { origin = new URL(publicOrigin); } catch { throw new Error('FLIPPER_PUBLIC_ORIGIN must be an HTTPS origin without a path'); }
    if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || origin.username || origin.password) {
      throw new Error('FLIPPER_PUBLIC_ORIGIN must be an exact HTTPS origin without a path, query, credentials, or fragment');
    }
    if (!/^[\x21-\x7e]{32,1024}$/.test(adminToken)) throw new Error('FLIPPER_ADMIN_TOKEN must contain 32–1024 printable non-space characters');
  }
  const revision = options.revision ?? 'development';
  if (!/^[\w.+/-]{1,128}$/.test(revision)) throw new Error('FLIPPER_REVISION must be a short revision identifier');
  return { hosted, publicOrigin: publicOrigin ?? null, adminToken: adminToken ?? null, revision };
}

export function validAdminToken(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== 'string') return false;
  const supplied = Buffer.from(value), target = Buffer.from(expected);
  return supplied.length === target.length && timingSafeEqual(supplied, target);
}

export function serverHost(access: ServerAccess, env: NodeJS.ProcessEnv = process.env): string {
  const host = env.FLIPPER_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::'].includes(host)) throw new Error('FLIPPER_HOST must be a loopback or wildcard IP address');
  if (!access.hosted && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('A public bind address requires hosted access configuration');
  return host;
}
