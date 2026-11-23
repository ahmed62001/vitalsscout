#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REGISTRY_PATH,
  createManualOrderRegistry,
} from './order-registry.mjs';

function printHelp() {
  console.log(`VitalsScout Manual Order & Payment Registry CLI

Usage:
  node ./cli/manual-orders.mjs <command> [options]

Commands:
  create-order
    --service <audit|audit-fix> --url <url> --channel <channel> --contact <handle> --operator <name> [--notes <text>]
  issue-payment-instructions
    --order-id <id> --operator <name> [--ttl-minutes <60>]
  record-tx
    --order-id <id> --tx-hash <0x...> --channel <channel> --operator <name> [--notes <text>]
  verify-payment
    --order-id <id> [--tx-hash <0x...>]
    --binance-status <Completed|Credited|...> --binance-txid <0x...>
    --binance-coin <USDT> --binance-network <BSC> --binance-address <0x...> --binance-amount <amount>
    [--binance-deposit-ref <id>] [--clear-manual-review-reason <text>]
    --operator <name> [--notes <text>]
  flag-manual-review
    --order-id <id> --reason <text> --operator <name>
  start-fulfillment
    --order-id <id> --operator <name> [--notes <text>]
  close-order
    --order-id <id> --status <Expired|Cancelled|Failed|Fulfilled> --reason <text> --operator <name>
  list
  show
    --order-id <id>

Global Options:
  --registry <path.json>   Registry file path (default: $VITALS_MANUAL_REGISTRY_PATH or .local-state/manual-orders.json)
  -h, --help               Show this help message
`);
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    if (key === 'help') {
      flags.help = true;
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    flags[key] = next;
    i += 1;
  }
  return flags;
}

async function runCli(argv = process.argv) {
  const rawArgs = argv.slice(2);
  if (rawArgs.length === 0 || rawArgs[0] === '-h' || rawArgs[0] === '--help' || rawArgs[0] === 'help') {
    printHelp();
    return;
  }

  const command = rawArgs[0];
  const flags = parseFlags(rawArgs.slice(1));
  if (flags.help) {
    printHelp();
    return;
  }

  const rawRegistry = flags.registry || process.env.VITALS_MANUAL_REGISTRY_PATH || DEFAULT_REGISTRY_PATH;
  const registryPath = path.resolve(process.cwd(), rawRegistry);
  const registry = createManualOrderRegistry(registryPath);

  if (command === 'create-order') {
    const order = await registry.createOrder({
      serviceKey: flags.service,
      targetUrl: flags.url,
      contactChannel: flags.channel,
      contactHandle: flags.contact,
      operator: flags.operator,
      notes: flags.notes || '',
    });
    console.log(JSON.stringify({ ok: true, registryPath: registry.getRegistryPath(), order }, null, 2));
    return;
  }

  if (command === 'issue-payment-instructions') {
    const res = await registry.issuePaymentInstructions({
      orderId: flags['order-id'],
      operator: flags.operator,
      ...(flags['ttl-minutes'] !== undefined ? { ttlMinutes: Number(flags['ttl-minutes']) } : {}),
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (command === 'record-tx') {
    const res = await registry.recordCustomerTxHash({
      orderId: flags['order-id'],
      txHash: flags['tx-hash'],
      channel: flags.channel,
      operator: flags.operator,
      notes: flags.notes || '',
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (command === 'verify-payment') {
    const binanceRecord =
      flags['binance-status'] ||
      flags['binance-txid'] ||
      flags['binance-amount'] ||
      flags['binance-address'] ||
      flags['binance-coin'] ||
      flags['binance-network']
        ? {
            status: flags['binance-status'] || '',
            txId: flags['binance-txid'] || '',
            coin: flags['binance-coin'] || '',
            network: flags['binance-network'] || '',
            address: flags['binance-address'] || '',
            creditedAmountUsdt: flags['binance-amount'] || '',
            depositRef: flags['binance-deposit-ref'] || '',
            checkedAt: new Date().toISOString(),
          }
        : null;

    const res = await registry.verifyManualPayment({
      orderId: flags['order-id'],
      txHash: flags['tx-hash'],
      binanceRecord,
      operator: flags.operator,
      notes: flags.notes || '',
      clearManualReviewReason: flags['clear-manual-review-reason'] || '',
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (command === 'flag-manual-review') {
    const res = await registry.flagManualReview({
      orderId: flags['order-id'],
      reason: flags.reason,
      operator: flags.operator,
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (command === 'start-fulfillment') {
    const res = await registry.startFulfillment({
      orderId: flags['order-id'],
      operator: flags.operator,
      notes: flags.notes || '',
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (command === 'close-order') {
    const res = await registry.closeOrder({
      orderId: flags['order-id'],
      status: flags.status,
      reason: flags.reason,
      operator: flags.operator,
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (command === 'list') {
    const orders = await registry.listOrders();
    const activeWindow = await registry.getActivePaymentWindow();
    console.log(
      JSON.stringify(
        {
          ok: true,
          registryPath: registry.getRegistryPath(),
          activePaymentWindowCount: activeWindow.length,
          activePaymentWindowOrderIds: activeWindow.map((o) => o.orderId),
          orders,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === 'show') {
    const orderId = flags['order-id'];
    if (!orderId) {
      throw new Error('--order-id is required for show');
    }
    const order = await registry.getOrder(orderId);
    if (!order) {
      console.log(JSON.stringify({ ok: false, code: 'ORDER_NOT_FOUND', error: `Order ${orderId} not found.` }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ ok: true, order }, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().catch((err) => {
    const msg = process.env.VITALSSCOUT_DEBUG === '1' ? (err?.stack || err?.message || String(err)) : (err?.message || 'Unexpected error');
    console.error(JSON.stringify({ ok: false, code: err?.code || 'ERROR', error: msg }, null, 2));
    process.exitCode = 1;
  });
}
