import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadEnvFile } from 'node:process';
import * as sqlite from 'node:sqlite';
import { TechAPICache, type LaptopSpecRequest, type MemoryPartRequest } from '../server/techapi.ts';
import { laptopSpecRequest } from '../server/laptop-specs.ts';
import { assessWithRules } from '../server/hardware.ts';
import type { RawListing } from '../shared/types.ts';

if (existsSync('.env')) loadEnvFile('.env');
const directory = resolve(process.env.FLIPPER_DATA_DIR ?? '.data');
const parts: MemoryPartRequest[] = [];
const laptops: LaptopSpecRequest[] = [];
const Database = ('Database' in sqlite ? sqlite.Database : sqlite.DatabaseSync) as typeof sqlite.DatabaseSync;
if (existsSync(join(directory,'flipper.sqlite'))) {
  const db = new Database(join(directory,'flipper.sqlite'), { readOnly: true });
  try {
    for (const row of db.prepare('SELECT raw FROM listings WHERE local=1').all() as { raw: string }[]) {
      const raw: RawListing = JSON.parse(row.raw), p = assessWithRules(raw).profile;
      if (p.cpu) parts.push({ kind: 'cpu', model: p.cpu });
      if (p.gpu && p.gpuClass !== 'integrated') parts.push({ kind: 'gpu', model: p.gpu, gpuClass: p.gpuClass });
      const laptop = raw.category === 'laptop' ? laptopSpecRequest(p) : null;
      if (laptop) laptops.push(laptop);
    }
  } finally { db.close(); }
}
const cache = new TechAPICache(directory);
await cache.warm(parts, AbortSignal.timeout(180_000));
await cache.warmLaptops(laptops, AbortSignal.timeout(180_000));
process.stdout.write(`Requested ${laptops.length} retained laptop configurations.\n`);
process.stdout.write(`Requested ${new Set(parts.map(p => `${p.kind}:${p.model}:${p.gpuClass ?? ''}`)).size} retained part identities. Cache status: ${JSON.stringify(cache.status)}\n`);
if (!cache.status.indexes && parts.length) process.exitCode = 1;
process.stdout.write('Data from TechAPI — CC BY-SA 4.0. Only manufacturer-checked unique types affect price matching.\n');
