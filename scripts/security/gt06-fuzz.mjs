#!/usr/bin/env node
// GT06 codec fuzzer. Node >= 18, no dependencies.
//
//   npm run build --workspace @scip/api      # produces dist/modules/devices/gt06-codec.js
//   node scripts/security/gt06-fuzz.mjs [iterations]
//
// The GT06 TCP gateway (apps/api/src/modules/devices/device-gateway.service.ts) is UNAUTHENTICATED
// by protocol: anyone who can reach tcp/5023 can send bytes. The gateway's safety therefore rests
// on the codec surviving arbitrary input without crashing, hanging, or over-allocating. This feeds
// the codec's parsing entry points (readFrame, decodeLogin, decodeLocation, decodeStatus) tens of
// thousands of random and adversarial buffers and asserts every one either returns a value, returns
// null (need more bytes), or throws Gt06ProtocolError — never an unexpected throw, and never a hang.
//
// It imports the COMPILED codec so it exercises exactly what ships. Exit code 0 = clean.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const codecPath = join(REPO, 'apps', 'api', 'dist', 'modules', 'devices', 'gt06-codec.js');

let codec;
try {
  codec = require(codecPath);
} catch (error) {
  console.error(`Cannot load the compiled codec at ${codecPath}`);
  console.error('Build the API first:  npm run build --workspace @scip/api');
  console.error(String(error));
  process.exit(2);
}

const { readFrame, decodeLogin, decodeLocation, decodeStatus, Gt06ProtocolError, GT06_START_SHORT, GT06_START_LONG } = codec;

const ITERATIONS = Number.parseInt(process.argv[2] ?? '', 10) || 200_000;
const HANG_BUDGET_MS = 50; // any single call over this on a <=8KB buffer is a red flag

let calls = 0;
let unexpected = [];
let slowest = 0;

/** Runs one parser on one buffer; records only outcomes that should never happen. */
function exercise(label, fn, buf) {
  calls += 1;
  const started = process.hrtime.bigint();
  let outcome;
  try {
    fn(buf);
    outcome = 'ok';
  } catch (error) {
    outcome = error instanceof Gt06ProtocolError || error instanceof RangeError ? 'expected-throw' : 'UNEXPECTED';
    if (outcome === 'UNEXPECTED' && unexpected.length < 30) {
      unexpected.push({ label, kind: error?.constructor?.name, message: String(error?.message).slice(0, 120), hex: buf.subarray(0, 24).toString('hex') });
    }
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (ms > slowest) slowest = ms;
  if (ms > HANG_BUDGET_MS) {
    unexpected.push({ label, kind: 'SLOW', message: `${ms.toFixed(1)}ms`, hex: buf.subarray(0, 24).toString('hex') });
  }
}

function randomBuffer(maxLen) {
  const len = Math.floor(Math.random() * maxLen);
  const buf = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

/** A buffer that looks like a real frame header, to drive the parser deep before it gives up. */
function structuredFrame() {
  const long = Math.random() < 0.5;
  const payloadLen = Math.floor(Math.random() * 300);
  const head = Buffer.alloc(long ? 4 : 3);
  if (long) {
    head.writeUInt16BE(GT06_START_LONG, 0);
    head.writeUInt16BE(payloadLen, 2);
  } else {
    head.writeUInt16BE(GT06_START_SHORT, 0);
    head.writeUInt8(payloadLen & 0xff, 2);
  }
  const rest = randomBuffer(payloadLen + 8);
  // Half the time, end with the real terminator so it passes framing and reaches decode.
  const tail = Math.random() < 0.5 ? Buffer.from([0x0d, 0x0a]) : randomBuffer(2);
  return Buffer.concat([head, rest, tail]);
}

const CORPUS = [
  Buffer.alloc(0),
  Buffer.from([0x78]),
  Buffer.from([0x78, 0x78]),
  Buffer.from([0x79, 0x79, 0xff, 0xff]), // long frame claiming 65535 payload bytes
  Buffer.from([0x78, 0x78, 0xff]), // short frame claiming 255 payload bytes, nothing after
  Buffer.from([0x78, 0x78, 0x05, 0x01, 0x00, 0x00, 0x00, 0x00, 0x0d, 0x0a]),
  Buffer.alloc(8 * 1024, 0x78), // the gateway's MAX_BUFFER_BYTES, all start bytes
];

console.log(`GT06 codec fuzz: ${ITERATIONS} iterations against ${codecPath.replace(REPO, '.')}\n`);

for (const buf of CORPUS) {
  exercise('readFrame/corpus', readFrame, buf);
  exercise('decodeLogin/corpus', decodeLogin, buf);
  exercise('decodeLocation/corpus', decodeLocation, buf);
  exercise('decodeStatus/corpus', decodeStatus, buf);
}

for (let i = 0; i < ITERATIONS; i += 1) {
  const buf = Math.random() < 0.6 ? structuredFrame() : randomBuffer(8 * 1024);
  exercise('readFrame', readFrame, buf);
  // The decoders receive the raw buffer as a payload too (what handleFrame passes after framing).
  if (i % 3 === 0) exercise('decodeLogin', decodeLogin, buf);
  if (i % 3 === 1) exercise('decodeLocation', decodeLocation, buf);
  if (i % 3 === 2) exercise('decodeStatus', decodeStatus, buf);
}

console.log(`${calls} parser calls. Slowest single call: ${slowest.toFixed(2)} ms.`);
if (unexpected.length === 0) {
  console.log('\n[PASS] No unexpected throw, hang or over-allocation. Every input returned a value, returned null, or threw Gt06ProtocolError/RangeError.');
  process.exit(0);
} else {
  console.log(`\n[FAIL] ${unexpected.length} unexpected outcome(s):`);
  for (const u of unexpected.slice(0, 30)) console.log(`  ${u.label}: ${u.kind} ${u.message}  [${u.hex}]`);
  process.exit(1);
}
