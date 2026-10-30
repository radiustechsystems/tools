import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { readFileSync } from 'node:fs';
import { encodeFunctionData, isAddress, parseEther, verifyMessage, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { radiusNetwork, resolveConfig, readPasswordless, writeCachedAddress, writePasswordless } from '../lib/config.js';
import { keystoreExists, loadKeystorePrivateKey, saveKeystore } from '../lib/keystore.js';
import { getOwnAddress, promptSecret, requireAccount } from '../lib/account.js';
import { makePublicClient, makeWalletClient } from '../lib/client.js';
import { parseAmountArg, parseTokenArg, readBalances } from '../lib/erc20.js';
import { signJwt } from '../lib/jwt.js';
import { parseTypedData } from '../lib/typedData.js';
import { coerceArg, parseCastSignature } from '../lib/signature.js';
import { formatUsd, formatUsdShort, jsonStringify } from '../lib/format.js';
import { registerWalletPay } from './walletPay.js';
import type { GlobalOptions } from '../types.js';
import { explorerTxUrl } from 'radius-sdk';
import { createRadiusFetch, type TokenInput } from 'radius-sdk/client';

function readMessageArg(arg: string, raw: boolean): string | { raw: Hex } {
  const text = arg === '-' ? readFileSync(0, 'utf8') : arg;
  if (raw) {
    const trimmed = text.trim();
    if (!/^0x[0-9a-fA-F]*$/.test(trimmed) || trimmed.length % 2 !== 0) {
      throw new Error(`--raw input must be a 0x-prefixed hex string with an even length, got: ${trimmed}`);
    }
    return { raw: trimmed as Hex };
  }
  return text;
}

function normalizePrivateKey(input: string): Hex {
  const trimmed = input.trim();
  const withPrefix = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error('Private key must be a 32-byte hex string (64 hex chars).');
  }
  return withPrefix as Hex;
}

async function readNewPassword(envPassword?: string): Promise<string> {
  if (envPassword !== undefined) return envPassword;
  const first = await promptSecret('New keystore password:');
  if (first.length < 8) throw new Error('Password must be at least 8 characters.');
  const second = await promptSecret('Confirm password:');
  if (first !== second) throw new Error('Passwords do not match.');
  return first;
}

export function registerWallet(program: Command): void {
  const wallet = program.command('wallet').description('Manage the local Radius wallet');

  wallet
    .command('new')
    .description('Create a new keystore at ~/.radius/keystore.json')
    .option('-f, --force', 'overwrite an existing keystore')
    .action(async (subOpts: { force?: boolean }, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      if (keystoreExists(cfg.keystorePath) && !subOpts.force) {
        throw new Error(`Keystore already exists at ${cfg.keystorePath}. Use --force to overwrite.`);
      }
      const password = await readNewPassword(cfg.password);
      const pk = generatePrivateKey();
      const address = await saveKeystore(cfg.keystorePath, pk, password);
      writeCachedAddress(address);
      writePasswordless(password === '');
      if (opts.json) {
        console.log(jsonStringify({ path: cfg.keystorePath, address }));
        return;
      }
      console.log(`Created keystore at ${cfg.keystorePath}`);
      console.log(`Address: ${address}`);
    });

  wallet
    .command('import')
    .description('Import an existing private key into the keystore')
    .argument('<privateKey>', 'hex-encoded private key (with or without 0x)')
    .option('-f, --force', 'overwrite an existing keystore')
    .action(async (privateKeyArg: string, subOpts: { force?: boolean }, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      if (keystoreExists(cfg.keystorePath) && !subOpts.force) {
        throw new Error(`Keystore already exists at ${cfg.keystorePath}. Use --force to overwrite.`);
      }
      const pk = normalizePrivateKey(privateKeyArg);
      const password = await readNewPassword(cfg.password);
      const address = await saveKeystore(cfg.keystorePath, pk, password);
      writeCachedAddress(address);
      writePasswordless(password === '');
      if (opts.json) {
        console.log(jsonStringify({ path: cfg.keystorePath, address }));
        return;
      }
      console.log(`Imported keystore at ${cfg.keystorePath}`);
      console.log(`Address: ${address}`);
    });

  wallet
    .command('address')
    .description('Print the address associated with the local account')
    .action(async (_subOpts, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      const address = await getOwnAddress(cfg, opts.privateKey);
      if (opts.json) {
        console.log(jsonStringify({ address }));
        return;
      }
      console.log(address);
    });

  wallet
    .command('export')
    .description('Decrypt and print the private key (DESTRUCTIVE: prints secret material)')
    .action(async (_subOpts, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      if (!opts.privateKey && !keystoreExists(cfg.keystorePath)) {
        throw new Error(
          `No keystore at ${cfg.keystorePath}. Run \`radius-cli wallet new\` or pass --private-key.`,
        );
      }
      const ok = await confirm({
        message: 'Print the raw private key to stdout?',
        default: false,
      });
      if (!ok) return;

      let pk: Hex;
      if (opts.privateKey) {
        pk = normalizePrivateKey(opts.privateKey);
      } else {
        const password = cfg.password
          ?? (readPasswordless() ? '' : await promptSecret('Keystore password:'));
        pk = await loadKeystorePrivateKey(cfg.keystorePath, password);
      }
      const address = privateKeyToAccount(pk).address;
      if (opts.json) {
        console.log(jsonStringify({ address, privateKey: pk }));
        return;
      }
      console.log(`Address: ${address}`);
      console.log(`PrivateKey: ${pk}`);
    });

  wallet
    .command('faucet')
    .description('Request a faucet drip for the local account (testnet ~0.5 SBC; mainnet ~0.01 SBC/day)')
    .action(async (_subOpts, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      const network = radiusNetwork(cfg);
      const account = await requireAccount(cfg, opts.privateKey);
      const { amount, txHash } = await createRadiusFetch({ networks: [network], signer: account, maxPerRequest: '0' }).fund();
      const explorerUrl = txHash ? explorerTxUrl(network, txHash) : undefined;
      if (opts.json) {
        console.log(jsonStringify({ address: account.address, network: network.name, amount, txHash, explorerUrl }));
        return;
      }
      console.log(`Dripped ${amount ?? '?'} ${network.asset.symbol} to ${account.address} on ${network.name}`);
      if (txHash) console.log(`Tx: ${txHash}`);
      if (explorerUrl) console.log(explorerUrl);
    });

  wallet
    .command('sign')
    .description('Sign a message with the local account (EIP-191 personal_sign)')
    .argument('<message>', "the message to sign — pass '-' to read from stdin")
    .option('--raw', 'treat the message as raw hex bytes (input must be 0x-prefixed)')
    .action(async (messageArg: string, subOpts: { raw?: boolean }, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      const account = await requireAccount(cfg, opts.privateKey);
      const message = readMessageArg(messageArg, !!subOpts.raw);
      const signature = await account.signMessage({ message });
      if (opts.json) {
        console.log(jsonStringify({ address: account.address, signature }));
        return;
      }
      console.log(signature);
    });

  wallet
    .command('sign-typed-data')
    .description('Sign EIP-712 typed data with the local account')
    .argument('<json>', "typed data as JSON ({domain, types, primaryType, message}) — pass '-' to read from stdin")
    .action(async (jsonArg: string, _subOpts, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      const typedData = parseTypedData(jsonArg === '-' ? readFileSync(0, 'utf8') : jsonArg);
      const account = await requireAccount(cfg, opts.privateKey);
      const signature = await account.signTypedData(typedData);
      if (opts.json) {
        console.log(jsonStringify({ address: account.address, signature }));
        return;
      }
      console.log(signature);
    });

  wallet
    .command('sign-jwt')
    .description('Sign a JWT (ES256K) with the local account; iss defaults to the account address')
    .option('--claims <json>', 'extra claims as a JSON object', '{}')
    .option('--expires-in <seconds>', 'token lifetime in seconds', '3600')
    .action(async (subOpts: { claims: string; expiresIn: string }, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      let claims: unknown;
      try {
        claims = JSON.parse(subOpts.claims);
      } catch {
        throw new Error('--claims must be valid JSON');
      }
      if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) throw new Error('--claims must be a JSON object');
      const account = await requireAccount(cfg, opts.privateKey);
      const token = await signJwt(account, { claims: claims as Record<string, unknown>, expiresIn: Number(subOpts.expiresIn) });
      if (opts.json) {
        console.log(jsonStringify({ address: account.address, token }));
        return;
      }
      console.log(token);
    });

  wallet
    .command('verify')
    .description('Verify an EIP-191 message signature')
    .argument('<message>', "signed message — pass '-' to read from stdin")
    .argument('<signature>', '0x-prefixed signature')
    .option('--raw', 'treat the message as raw hex bytes')
    .option('--address <address>', 'address to verify against (defaults to local account)')
    .action(async (
      messageArg: string,
      signatureArg: string,
      subOpts: { raw?: boolean; address?: string },
      cmd,
    ) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);

      let address: Address;
      if (subOpts.address) {
        if (!isAddress(subOpts.address)) throw new Error(`Not a valid address: ${subOpts.address}`);
        address = subOpts.address as Address;
      } else {
        address = await getOwnAddress(cfg, opts.privateKey);
      }

      const message = readMessageArg(messageArg, !!subOpts.raw);
      const sig = signatureArg.trim() as Hex;
      if (!/^0x[0-9a-fA-F]+$/.test(sig)) throw new Error(`Not a valid 0x signature: ${sig}`);

      const valid = await verifyMessage({ address, message, signature: sig });
      if (opts.json) {
        console.log(jsonStringify({ address, valid }));
        return;
      }
      console.log(valid ? `OK  ${address}` : `FAIL ${address}`);
      if (!valid) process.exitCode = 1;
    });

  wallet
    .command('balance')
    .description('Show RUSD (native) and SBC balances for an address (defaults to own)')
    .argument('[address]', 'address to query (defaults to own)')
    .action(async (addressArg: string | undefined, _subOpts, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);

      let address: Address;
      if (addressArg) {
        if (!isAddress(addressArg)) throw new Error(`Not a valid address: ${addressArg}`);
        address = addressArg as Address;
      } else {
        address = await getOwnAddress(cfg, opts.privateKey);
      }

      const client = makePublicClient(cfg);
      const report = await readBalances(client, cfg, address);

      if (opts.json) {
        console.log(jsonStringify(report));
        return;
      }
      console.log(`Address: ${address}`);
      if (report.sbcError) {
        console.log(`Balance: $${formatUsdShort(report.totalUsd)} ($${formatUsd(report.rusd)} RUSD; SBC unavailable: ${report.sbcError})`);
      } else {
        console.log(
          `Balance: $${formatUsdShort(report.totalUsd)} ($${formatUsd(report.sbc)} SBC + $${formatUsd(report.rusd)} RUSD)`,
        );
      }
    });

  wallet
    .command('send')
    .description(
      [
        'Send tokens. Forms:',
        '  radius-cli wallet send <to> <amount> RUSD       — native value transfer',
        '  radius-cli wallet send <to> <amount> SBC        — ERC-20 transfer of SBC',
        '  radius-cli wallet send <to> <amount> 0xToken    — ERC-20 transfer of any token',
        '  radius-cli wallet send <token> "<sig>" [args…]  — call any function',
      ].join('\n  '),
    )
    .argument('[args...]', 'see description for forms')
    .option('--no-wait', 'do not wait for the receipt before returning')
    .option('--gas-limit <units>', 'gas limit for the transaction (skips the eth_estimateGas roundtrip)')
    .action(async (args: string[], subOpts: { wait?: boolean; gasLimit?: string }, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      const wait = subOpts.wait !== false;
      const gas = parseGasLimit(subOpts.gasLimit);

      // Form A: cast-style — second arg looks like a function signature.
      if (args.length >= 2 && args[1].includes('(')) {
        await sendCastForm(cfg, args, opts, wait, gas);
        return;
      }

      // Form B: symbol form — exactly 3 args, last is RUSD, SBC or an ERC-20 address.
      if (args.length === 3) {
        const [to, amount, rawSymbol] = args;
        if (rawSymbol.toUpperCase() === 'RUSD') {
          await sendNative(cfg, to, amount, opts, wait, gas);
          return;
        }
        await sendErc20(cfg, parseTokenArg(cfg, rawSymbol), to, amount, opts, wait, gas);
        return;
      }

      const header = args.length === 0
        ? 'wallet send: missing arguments.'
        : `wallet send: could not parse arguments: ${args.join(' ')}`;
      throw new Error(
        [
          header,
          '',
          'Supported forms:',
          '  radius-cli wallet send <to> <amount> RUSD       — native value transfer',
          '  radius-cli wallet send <to> <amount> SBC        — ERC-20 transfer of SBC',
          '  radius-cli wallet send <to> <amount> 0xToken    — ERC-20 transfer of any token',
          '  radius-cli wallet send <token> "<sig>" [args…]  — call any function',
        ].join('\n'),
      );
    });

  registerWalletPay(wallet);
}

function parseGasLimit(input: string | undefined): bigint | undefined {
  if (input === undefined) return undefined;
  let value: bigint;
  try {
    value = BigInt(input);
  } catch {
    throw new Error(`--gas-limit must be an integer, got: ${input}`);
  }
  if (value <= 0n) throw new Error(`--gas-limit must be positive, got: ${input}`);
  return value;
}

async function sendNative(
  cfg: ReturnType<typeof resolveConfig>,
  to: string,
  amount: string,
  opts: GlobalOptions,
  wait: boolean,
  gas: bigint | undefined,
): Promise<void> {
  if (!isAddress(to)) throw new Error(`Not a valid address: ${to}`);
  const account = await requireAccount(cfg, opts.privateKey);
  const publicClient = makePublicClient(cfg);
  const walletClient = makeWalletClient(cfg, account);
  const value = parseEther(amount);
  const gasPrice = await publicClient.getGasPrice();

  const hash = await walletClient.sendTransaction({
    account,
    to: to as Address,
    value,
    gasPrice,
    gas,
    type: 'legacy',
    chain: cfg.chain,
  });
  await reportTx(publicClient, hash, opts, wait);
}

/**
 * ERC-20 transfer through the SDK's `transfer` action: it parses the display amount with the token's
 * decimals (read on-chain for a bare address) and encodes the call. The receipt is awaited here, not
 * by the SDK, so `--no-wait` and the `{hash, receipt}` output stay the same as for a native send.
 */
async function sendErc20(
  cfg: ReturnType<typeof resolveConfig>,
  token: TokenInput,
  to: string,
  amount: string,
  opts: GlobalOptions,
  wait: boolean,
  gas: bigint | undefined,
): Promise<void> {
  if (!isAddress(to)) throw new Error(`Not a valid address: ${to}`);
  const account = await requireAccount(cfg, opts.privateKey);
  const publicClient = makePublicClient(cfg);
  const walletClient = makeWalletClient(cfg, account);
  const { hash } = await walletClient.transfer({ token, to: to as Address, amount: parseAmountArg(amount), gas, wait: false });
  await reportTx(publicClient, hash, opts, wait);
}

async function sendCastForm(
  cfg: ReturnType<typeof resolveConfig>,
  args: string[],
  opts: GlobalOptions,
  wait: boolean,
  gas: bigint | undefined,
): Promise<void> {
  const [target, signature, ...callArgs] = args;
  if (!isAddress(target)) throw new Error(`Not a valid address: ${target}`);
  const parsed = parseCastSignature(signature);
  const inputs = parsed.abiItem.inputs ?? [];
  if (callArgs.length !== inputs.length) {
    throw new Error(`Expected ${inputs.length} args for ${signature}, got ${callArgs.length}`);
  }
  const coerced = inputs.map((input, i) => coerceArg(callArgs[i], input.type));
  const data = encodeFunctionData({
    abi: [parsed.abiItem],
    functionName: parsed.abiItem.name,
    args: coerced,
  });

  const account = await requireAccount(cfg, opts.privateKey);
  const publicClient = makePublicClient(cfg);
  const walletClient = makeWalletClient(cfg, account);
  const gasPrice = await publicClient.getGasPrice();

  const hash = await walletClient.sendTransaction({
    account,
    to: target as Address,
    data,
    gasPrice,
    gas,
    type: 'legacy',
    chain: cfg.chain,
  });
  await reportTx(publicClient, hash, opts, wait);
}

async function reportTx(
  publicClient: ReturnType<typeof makePublicClient>,
  hash: `0x${string}`,
  opts: GlobalOptions,
  wait: boolean,
): Promise<void> {
  if (!wait) {
    if (opts.json) console.log(jsonStringify({ hash }));
    else console.log(hash);
    return;
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (opts.json) {
    console.log(jsonStringify({ hash, receipt }));
  } else {
    console.log(`Hash:        ${hash}`);
    console.log(`Status:      ${receipt.status}`);
    console.log(`Block:       ${receipt.blockNumber.toString()}`);
    console.log(`Gas used:    ${receipt.gasUsed.toString()}`);
  }
}
