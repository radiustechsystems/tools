import type { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { formatUnits, maxUint256, type Address } from 'viem';
import { describeSupportedSchemes, type PaymentNetwork } from 'radius-sdk';
import {
  createRadiusFetch,
  getPaymentReceipt,
  RadiusPaymentError,
  type ApprovalRequest,
  type PaymentOffer,
  type PaymentProtocol,
  type PaymentReceipt,
  type PaymentRejectedDetails,
} from 'radius-sdk/client';
import { PAY_NETWORKS, resolveConfig, resolvePayNetworks } from '../lib/config.js';
import { deferredAccount } from '../lib/account.js';
import { jsonStringify } from '../lib/format.js';
import {
  decodeBodyAsUtf8,
  isSupportedVerb,
  looksLikeJson,
  parseHeaderArgs,
  readBodyArg,
  readCappedBody,
  runRequest,
  sameOrigin,
  SUPPORTED_VERBS,
  type HttpResponse,
  type HttpVerb,
} from '../lib/http.js';
import { decidePayment, type PayDecision } from '../lib/payPolicy.js';
import type { GlobalOptions } from '../types.js';

interface SubOptions {
  header?: string[];
  data?: string;
  networks?: string;
  protocol?: string;
  threshold?: string;
  yes?: boolean;
  include?: boolean;
  approvePermit2?: boolean;
}

interface PaymentSummary {
  paid: boolean;
  protocol: PaymentProtocol;
  /** CAIP-2 network the payment was made on. */
  network: string;
  scheme: string;
  asset: Address;
  assetSymbol: string | null;
  amount: string;
  amountWei: string;
  payTo: Address;
  txHash?: string;
  payer?: string;
}

export function registerWalletPay(wallet: Command): void {
  wallet
    .command('pay')
    .description(
      [
        'Make an HTTP request and pay if the server responds with 402: x402, or MPP (WWW-Authenticate: Payment, evm charges).',
        'Pays on Radius by default; add Base with --networks radius,base (--network testnet pairs Radius testnet with Base Sepolia).',
        `Supports ${describeSupportedSchemes()}.`,
        'Permit2 approvals are gas-sponsored when the server offers eip2612GasSponsoring.',
        '',
        '  radius-cli wallet pay get https://example.com/resource',
        '  radius-cli wallet pay post https://api.example.com/x -d \'{"a":1}\'',
        '  radius-cli wallet pay get https://example.com/r --threshold 0.05',
        '  radius-cli wallet pay get https://example.com/r --networks radius,base',
      ].join('\n'),
    )
    .argument('<verb>', `HTTP verb (${SUPPORTED_VERBS.join(', ')})`)
    .argument('<url>', 'request URL')
    .option('-H, --header <h...>', "request header, repeatable: 'Key: Value'")
    .option('-d, --data <body>', "request body (literal, '@path' for file, '-' for stdin)")
    .option(
      '--networks <list>',
      `networks to pay on, in preference order (${PAY_NETWORKS.join(', ')}; default radius, or RADIUS_PAY_NETWORKS)`,
    )
    .option('--protocol <name>', "payment protocol: auto (x402 when offered, else MPP), x402 or mpp", 'auto')
    .option('--threshold <decimal>', "auto-pay if the offered fee ≤ this amount in the asset's display units (USD for SBC and USDC)")
    .option('-y, --yes', 'auto-confirm payment without prompting (capped by --threshold when both are given)')
    .option(
      '--approve-permit2',
      'grant Permit2 an unlimited token approval if one is missing and the server does not sponsor it',
    )
    .option('--include', 'write response status and headers to stderr')
    .action(async (verbArg: string, url: string, subOpts: SubOptions, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      await runPay(verbArg, url, subOpts, opts);
    });
}

/** `--protocol` → the SDK's preference list. */
function protocolsFor(flag = 'auto'): PaymentProtocol[] {
  if (flag === 'auto') return ['x402', 'mpp'];
  if (flag === 'x402' || flag === 'mpp') return [flag];
  process.stderr.write(`pay: --protocol must be auto, x402 or mpp (got '${flag}')\n`);
  process.exit(2);
}

/** Why a payment did not go ahead; decides the exit code and message. */
type Refusal =
  | { kind: 'insufficient-balance' }
  | { kind: 'no-tty' }
  | { kind: 'over-threshold' }
  | { kind: 'declined' }
  | { kind: 'approval-no-tty' }
  | { kind: 'approval-declined' };

async function runPay(
  verbArg: string,
  url: string,
  subOpts: SubOptions,
  opts: GlobalOptions,
): Promise<void> {
  const verb = verbArg.toLowerCase();
  if (!isSupportedVerb(verb)) {
    process.stderr.write(`pay: unsupported verb '${verbArg}' (use one of ${SUPPORTED_VERBS.join(', ')})\n`);
    process.exit(2);
  }
  const method = verb.toUpperCase();

  const reqHeaders = parseHeaderArgs(subOpts.header);
  const body = readBodyArg(subOpts.data);
  if (body && !reqHeaders.has('content-type') && looksLikeJson(body)) {
    reqHeaders.set('content-type', 'application/json');
  }

  // First request without a wallet: no keystore prompt unless the server actually wants payment.
  const initial = await runRequest(verb as HttpVerb, url, { headers: reqHeaders, body });
  if (initial.status !== 402) {
    emit(initial, null, !!opts.json, !!subOpts.include);
    process.exit(initial.status >= 400 ? 1 : 0);
  }

  const cfg = resolveConfig(opts);
  const networks = resolvePayNetworks(cfg, subOpts.networks);
  const protocols = protocolsFor(subOpts.protocol);
  // The keystore is unlocked only when the SDK signs, i.e. after the 402 has been parsed and
  // matched (network, asset, scheme, payTo) and the payment approved. A bad challenge never prompts.
  const account = await deferredAccount(cfg, opts.privateKey);

  // Hand the 402 we already have to the SDK instead of asking the server twice.
  let replayed = false;
  const replayFirst: typeof fetch = async (input, init) => {
    if (!replayed) {
      replayed = true;
      return new Response(initial.body as BodyInit, { status: initial.status, headers: initial.headers });
    }
    return fetch(input, init);
  };

  let offer: PaymentOffer | undefined;
  let refusal: Refusal | undefined;

  const payFetch = createRadiusFetch({
    networks,
    protocols,
    signer: account,
    // The policy (threshold / prompt / refuse) lives in onPaymentRequired; no SDK-side cap.
    maxPerRequest: { amount: maxUint256.toString() },
    fetch: replayFirst,
    onPaymentRequired: async (o) => {
      offer = o;
      const { decimals, symbol } = o.network.asset;
      const wallet = payFetch.on(o.network);
      const isUpto = o.scheme === 'upto';
      const amount = BigInt(o.amount);
      const amountStr = formatUnits(amount, decimals);
      const balance = await wallet.balance();
      if (balance.atomic < amount) {
        refusal = { kind: 'insufficient-balance' };
        process.stderr.write(
          `pay: insufficient balance. Need ${isUpto ? 'up to ' : ''}${amountStr} ${symbol}, ` +
            `have ${balance.formatted}.\n`,
        );
        return false;
      }
      const decision: PayDecision = decidePayment(subOpts, amount, decimals, !!process.stdin.isTTY);
      if (decision === 'refuse-no-tty') {
        refusal = { kind: 'no-tty' };
        writeChallengeSummary(o, amountStr, symbol, balance.formatted, isUpto);
        return false;
      }
      if (decision === 'refuse-over-threshold') {
        refusal = { kind: 'over-threshold' };
        process.stderr.write(
          `pay: offer ${isUpto ? 'authorizes up to ' : 'of '}${amountStr} ${symbol} exceeds --threshold ` +
            `${subOpts.threshold}; not paying. Raise the threshold, or drop it to let --yes pay any amount.\n`,
        );
        return false;
      }
      if (decision === 'prompt') {
        const verbText = isUpto ? `Authorize up to ${amountStr}` : `Pay ${amountStr}`;
        const proceed = await confirm({
          message: `${verbText} ${symbol} on ${o.network.name} to ${o.payTo}? (balance: ${balance.formatted})`,
          default: false,
        });
        if (!proceed) {
          refusal = { kind: 'declined' };
          process.stderr.write('pay: payment declined.\n');
          return false;
        }
      }
      if (subOpts.approvePermit2 && o.transferMethod === 'permit2') {
        // The flag promises an allowance whether or not the server sponsors approvals (the SDK
        // only checks when it does not), so a facilitator that still answers 412 has a way out.
        const allowance = await wallet.permit2Allowance();
        if (allowance < amount) {
          process.stderr.write(`pay: granting Permit2 an unlimited ${symbol} approval on ${o.network.name} (--approve-permit2)…\n`);
          const tx = await wallet.approvePermit2();
          process.stderr.write(`pay: approval confirmed (tx ${tx.hash})\n`);
        }
      }
      return true;
    },
    onApprovalRequired: async (req: ApprovalRequest) => {
      if (subOpts.yes || subOpts.approvePermit2) return true;
      const { decimals, symbol } = req.network.asset;
      // `offer` is set when the SDK is approving for a payment; the CLI only calls approvePermit2()
      // itself under the flags handled above, so the prompt below is always payment-driven.
      const need = req.offer ? `${formatUnits(BigInt(req.offer.amount), decimals)} ${symbol}` : undefined;
      const have = formatUnits(req.currentAllowance, decimals);
      // `sponsored`: no transaction is sent by this wallet; the server's facilitator submits what we sign.
      const sponsoredWhat = req.sponsored === 'erc20Approval' ? `a raw approve transaction giving Permit2 an unlimited ${symbol} allowance` : undefined;
      if (!process.stdin.isTTY) {
        refusal = { kind: 'approval-no-tty' };
        process.stderr.write(
          sponsoredWhat
            ? `pay: this payment asks you to sign ${sponsoredWhat}, which the server's facilitator will submit ` +
                `(allowance ${have}${need ? `, need ${need}` : ''}). Re-run with --approve-permit2 (or -y) to allow it.\n`
            : `pay: this payment requires a Permit2 approval for ${symbol} (have ${have}${need ? `, need ${need}` : ''}) ` +
                'and the server does not sponsor it. Re-run with --approve-permit2 (or -y) to grant ' +
                'a one-time unlimited approval.\n',
        );
        return false;
      }
      const proceed = await confirm({
        message: sponsoredWhat
          ? `Sign ${sponsoredWhat} for Permit2 (${req.spender}), submitted by the server's facilitator? ` +
            `${need ? `This payment needs ${need}. ` : ''}Every payment still requires its own signed authorization.`
          : `Grant Permit2 (${req.spender}) an unlimited ${symbol} approval? ` +
            `One-time setup; ${need ? `this payment needs ${need}, and ` : ''}every payment still ` +
            'requires its own signed authorization.',
        default: false,
      });
      if (!proceed) {
        refusal = { kind: 'approval-declined' };
        process.stderr.write('pay: Permit2 approval declined.\n');
      }
      return proceed;
    },
  });

  let res: Response;
  try {
    const hasBody = body !== undefined && method !== 'GET' && method !== 'HEAD';
    // Pay where the 402 came from: the final URL, if fetch followed redirects to it (the SDK does the
    // same for its own requests); method and body are replayed there, see createRadiusFetch.
    const target = initial.url || url;
    if (!sameOrigin(target, url)) ['authorization', 'cookie'].forEach((h) => reqHeaders.delete(h));
    res = await payFetch(target, {
      method,
      headers: reqHeaders,
      body: hasBody ? (body as BodyInit) : undefined,
    });
  } catch (e) {
    if (!(e instanceof RadiusPaymentError)) throw e;
    process.exit(
      await reportPaymentError(e, {
        refusal,
        offer,
        networks,
        payer: account.address,
        challengeBody: initial.body,
        json: !!opts.json,
      }),
    );
  }

  const paid: HttpResponse = {
    status: res.status,
    headers: res.headers,
    body: await readCappedBody(res),
    contentType: res.headers.get('content-type'),
  };

  if (paid.status === 412) {
    process.stderr.write(
      'pay: facilitator rejected the payment — Permit2 allowance required (412). ' +
        'Re-run with --approve-permit2 to grant it.\n',
    );
    process.stderr.write(safeBodyPreview(paid.body));
    process.exit(1);
  }

  if (!offer) {
    // The SDK only retries after onPaymentRequired approved an offer.
    process.stderr.write('pay: internal error: response returned without an approved offer.\n');
    process.exit(1);
  }

  const receipt = getPaymentReceipt(res, offer.network);
  const summary = summarize(offer, receipt, paid.status, account.address);

  if (paid.status >= 200 && paid.status < 300 && !summary.paid) {
    process.stderr.write(
      'pay: HTTP request succeeded, but payment settlement was not confirmed by a successful payment response.\n',
    );
  }

  emit(paid, summary, !!opts.json, !!subOpts.include);
  process.exit(paid.status >= 400 ? 1 : 0);
}

function summarize(
  offer: PaymentOffer,
  receipt: PaymentReceipt | undefined,
  status: number,
  fallbackPayer: Address,
): PaymentSummary {
  const { decimals, symbol } = offer.network.asset;
  // For upto the facilitator reports what it actually charged (validated by the SDK); exact charges the offer.
  const settled = BigInt(receipt?.amount ?? offer.amount);
  return {
    paid: status >= 200 && status < 300 && receipt?.success === true,
    network: offer.network.network,
    protocol: offer.protocol,
    scheme: offer.scheme,
    asset: offer.asset,
    assetSymbol: symbol,
    amount: formatUnits(settled, decimals),
    amountWei: settled.toString(),
    payTo: offer.payTo,
    txHash: receipt?.transaction || undefined,
    payer: receipt?.payer ?? fallbackPayer,
  };
}

interface ErrorContext {
  refusal: Refusal | undefined;
  offer: PaymentOffer | undefined;
  networks: readonly PaymentNetwork[];
  payer: Address;
  /** Body of the server's first 402, for the preview on an unusable challenge. */
  challengeBody: Uint8Array;
  json: boolean;
}

/** Print a payment failure the way the CLI always has, and return the exit code. */
async function reportPaymentError(e: RadiusPaymentError, ctx: ErrorContext): Promise<number> {
  const { refusal, offer, networks, payer, json } = ctx;
  const err = process.stderr;
  switch (e.code) {
    case 'invalid_challenge':
      err.write(`pay: server returned 402 but the body is not a valid challenge: ${e.message}\n`);
      err.write(safeBodyPreview(ctx.challengeBody));
      return 2;
    case 'network_mismatch':
    case 'asset_mismatch':
    case 'unsupported_transfer_method':
    case 'no_compatible_offer':
      err.write(
        `pay: no compatible payment option for ${networks.map((n) => `${n.asset.symbol} on ${n.name} (${n.network})`).join(', ')}. ` +
          `Supported: ${describeSupportedSchemes()}. ${e.message}\n`,
      );
      return 1;
    case 'declined':
      // The hooks already explained themselves on stderr.
      return refusal?.kind === 'no-tty' || refusal?.kind === 'over-threshold' ? 2 : 1;
    case 'payment_rejected': {
      // The SDK hands back the server's second 402 unread; show it the way the old client did.
      const detail = e.details as PaymentRejectedDetails;
      const rejected: HttpResponse = {
        status: detail.response.status,
        headers: detail.response.headers,
        body: await readCappedBody(detail.response),
        contentType: detail.response.headers.get('content-type'),
      };
      err.write('pay: server still returned 402 after payment.\n');
      if (detail.error) err.write(`reason: ${detail.error}\n`);
      err.write(safeBodyPreview(rejected.body));
      if (json && offer) {
        console.log(jsonStringify(envelope(rejected, summarize(offer, undefined, 402, payer))));
      }
      return 1;
    }
    case 'insufficient_balance':
      // Several networks offered, none funded: the SDK read each balance before signing.
      err.write(`pay: ${e.message.replace(/^Insufficient/, 'insufficient')}.\n`);
      return 1;
    case 'redirect_refused':
      err.write('pay: server redirected the paid request cross-origin; refusing to replay the payment header.\n');
      return 1;
    default:
      err.write(`pay: ${e.message}\n`);
      return 1;
  }
}

function writeChallengeSummary(
  offer: PaymentOffer,
  amount: string,
  symbol: string,
  balanceStr: string,
  isUpto: boolean,
): void {
  const lead = isUpto
    ? `payment required (authorize up to ${amount} ${symbol}, charged on use, to ${offer.payTo}).`
    : `payment required (${amount} ${symbol} to ${offer.payTo}).`;
  process.stderr.write(
    [
      `pay: ${lead}`,
      `     balance: ${balanceStr}`,
      `     pass --threshold ${amount} (or higher) to auto-pay, or --yes to confirm.`,
      '',
    ].join('\n'),
  );
}

function emit(res: HttpResponse, payment: PaymentSummary | null, json: boolean, include: boolean): void {
  if (json) {
    console.log(jsonStringify(envelope(res, payment)));
    return;
  }
  if (include) {
    process.stderr.write(`HTTP ${res.status}\n`);
    res.headers.forEach((v, k) => { process.stderr.write(`${k}: ${v}\n`); });
    process.stderr.write('\n');
  }
  if (payment?.paid) {
    const tag = payment.assetSymbol ?? payment.asset;
    const tx = payment.txHash ? ` (tx ${payment.txHash})` : '';
    process.stderr.write(`pay: paid ${payment.amount} ${tag}${tx}\n`);
  }
  process.stdout.write(res.body);
}

function envelope(res: HttpResponse, payment: PaymentSummary | null): Record<string, unknown> {
  const decoded = decodeBodyAsUtf8(res.body);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return {
    status: res.status,
    headers,
    body: decoded ?? Buffer.from(res.body).toString('base64'),
    bodyEncoding: decoded === null ? 'base64' : 'utf8',
    payment,
  };
}

function safeBodyPreview(body: Uint8Array): string {
  const s = decodeBodyAsUtf8(body) ?? '';
  const trimmed = s.length > 1024 ? s.slice(0, 1024) + '\n…(truncated)' : s;
  return trimmed.endsWith('\n') ? trimmed : trimmed + '\n';
}
