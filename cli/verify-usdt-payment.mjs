#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { normalizeTxHash, verifyUsdtBep20Payment } from '../docs/assets/usdt-verifier.js';

function printHelp() {
  console.log(`VitalsScout USDT (BEP20) Payment Verifier

Usage:
  node ./cli/verify-usdt-payment.mjs <txHash> --service <audit|audit-fix> [--record <registry.json>]

Options:
  --service <key>   Required: "audit" ($20.86) or "audit-fix" ($48.86)
  --record <path>   Optional JSON array registry for replay protection (rejects duplicates and appends verified txs)
  -h, --help        Show this help message
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    return { help: true };
  }
  let txHash = null;
  let serviceKey = null;
  let recordPath = null;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--service' && args[i + 1]) {
      serviceKey = args[i + 1];
      i += 1;
    } else if (token === '--record' && args[i + 1]) {
      recordPath = path.resolve(process.cwd(), args[i + 1]);
      i += 1;
    } else if (!token.startsWith('-') && !txHash) {
      txHash = token;
    } else {
      throw new Error(`Unexpected argument: ${token}`);
    }
  }

  if (!txHash || !serviceKey) {
    throw new Error('Both <txHash> and --service <audit|audit-fix> are required.');
  }

  return { help: false, txHash, serviceKey, recordPath };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    console.error(JSON.stringify({ verified: false, status: 'INVALID_ARGS', message: err.message }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (opts.help) {
    printHelp();
    return;
  }

  const normalized = normalizeTxHash(opts.txHash);
  let registry = [];
  if (opts.recordPath && fs.existsSync(opts.recordPath)) {
    registry = JSON.parse(fs.readFileSync(opts.recordPath, 'utf8'));
    if (!Array.isArray(registry)) {
      throw new Error(`Registry file must contain a JSON array: ${opts.recordPath}`);
    }
    if (normalized && registry.some((entry) => String(entry.txHash || '').toLowerCase() === normalized)) {
      console.log(
        JSON.stringify(
          {
            verified: false,
            status: 'DUPLICATE_TX_ALREADY_REDEEMED',
            txHash: normalized,
            message: `Transaction ${normalized} has already been recorded/redeemed in ${opts.recordPath}.`,
          },
          null,
          2
        )
      );
      process.exitCode = 1;
      return;
    }
  }

  const result = await verifyUsdtBep20Payment({
    txHash: opts.txHash,
    serviceKey: opts.serviceKey,
  });

  if (result.verified && opts.recordPath) {
    fs.mkdirSync(path.dirname(opts.recordPath), { recursive: true });
    registry.push(result);
    fs.writeFileSync(opts.recordPath, JSON.stringify(registry, null, 2), 'utf8');
  }

  console.log(JSON.stringify(result, null, 2));
  if (!result.verified) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ verified: false, status: 'ERROR', message: err?.message || String(err) }, null, 2));
  process.exitCode = 1;
});
