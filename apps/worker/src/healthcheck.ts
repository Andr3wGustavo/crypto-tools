import path from 'node:path';
import { evaluateHeartbeats, heartbeatFile, readHeartbeat } from './ops/heartbeat';

/**
 * Container healthcheck (exit 0 = healthy): this worker's heartbeat is fresh, written by THIS
 * image version (so a deploy is only "healthy" once the new code is the one running), its MEXC
 * feed is alive, and it is not halted/killed.
 */
const symbol = process.env.BOT_SYMBOL ?? 'SOLUSDT';
const dir = process.env.HEARTBEAT_DIR ?? path.join(process.env.MARKET_DATA_DIR ?? './data/market', '..', 'health');
const version = process.env.APP_VERSION ?? 'dev';
const hb = readHeartbeat(heartbeatFile(dir, symbol));
const r = evaluateHeartbeats([symbol], () => hb, Date.now());
const problems = [...r.problems];
if (hb && hb.version !== version) problems.push(`${symbol}: heartbeat from version ${hb.version}, expected ${version}`);
if (problems.length) {
  console.error(problems.join('; '));
  process.exit(1);
}
console.log(`${symbol}: healthy (${version})`);
