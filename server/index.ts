import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { appServer } from './http.ts';
import { Store } from './store.ts';
import { FlipperService } from './service.ts';
import { TechAPICache } from './techapi.ts';
import { serverHost, serverOptions, validateServerAccess } from './access.ts';
import { DailyScanner } from './scheduler.ts';
import { LaptopPriceBook } from './laptop-price-book.ts';

if (existsSync('.env')) loadEnvFile('.env');
const options = serverOptions(), access = validateServerAccess(options), host = serverHost(access);
const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer between 1024 and 65535');
const dataDirectory = resolve(process.env.FLIPPER_DATA_DIR ?? '.data');
const store = new Store(dataDirectory);
const service = new FlipperService(store, undefined, new TechAPICache(dataDirectory),undefined,
  new LaptopPriceBook(store));
const pricesTimer = setInterval(() => { void service.refreshPriceCache(); },60_000);
pricesTimer.unref();
const scanner = new DailyScanner(service);
const server = appServer(service, undefined, options);
server.listen(port, host, () => {
  void service.refreshPriceCache();
  scanner.start();
  process.stdout.write(`Flipper is ready at http://${host.includes(':') ? `[${host}]` : host}:${port}\n`);
});
server.on('error', (error) => { process.stderr.write(`Cannot start Flipper: ${error.message}\n`); process.exitCode = 1; });
let stopping = false;
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true; scanner.stop(); clearInterval(pricesTimer);
  const httpClosed = new Promise<void>(resolve => server.close(() => resolve()));
  void service.shutdown().then(async () => { await httpClosed; store.close(); process.exit(0); });
});
