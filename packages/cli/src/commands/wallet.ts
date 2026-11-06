import { Command } from 'commander';
import { confirm, password as promptPassword } from '@inquirer/prompts';
import { readFileSync } from 'node:fs';
import { encodeFunctionData, formatUnits, isAddress, parseEther, verifyMessage, type Address, type Hex } from 'viem';
import type { TokenTransfer } from 'radius-sdk/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { radiusNetwork, resolveConfig, readPasswordless, writeCachedAddress, writePasswordless } from '../lib/config.js';
import { changeKeystorePassword, keystoreExists, loadKeystorePrivateKey, saveKeystore } from '../lib/keystore.js';
import { getOwnAddress, requireAccount } from '../lib/account.js';
import { makePublicClient, makeWalletClient } from '../lib/client.js';
import { describeToken, formatBalanceLines, listTransfers, parseAmountArg, parseTokenArg, readBalances, toTransferRow, transferFilters, type TransferSides } from '../lib/erc20.js';
import { signJwt } from '../lib/jwt.js';
import { parseTypedData } from '../lib/typedData.js';
import { coerceArg, parseCastSignature } from '../lib/signature.js';
import { errDetail, jsonStringify } from '../lib/format.js';
import { registerWalletPay } from './walletPay.js';
import type { GlobalOptions } from '../types.js';
import { explorerTxUrl } from 'radius-sdk';
import { createRadiusFetch, MAX_LOG_RANGE, type TokenInput } from 'radius-sdk/client';

const TOKEN_ARG_HELP = 'SBC (default) or any ERC-20 contract address';

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
  const first = await promptPassword({ message: 'New keystore password:', mask: '*' });
  if (first.length < 8) throw new Error('Password must be at least 8 characters.');
  const second = await promptPassword({ message: 'Confirm password:', mask: '*' });
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
    .command('password')
    .description('Set or change the keystore password, keeping the same key and address')
    .option('--remove', 'remove the password instead (the keystore becomes effectively unencrypted)')
    .action(async (subOpts: { remove?: boolean }, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      if (!keystoreExists(cfg.keystorePath)) {
        throw new Error(`No keystore at ${cfg.keystorePath}. Run \`radius-cli wallet new\` or \`radius-cli wallet import\` first.`);
      }
      // A passwordless keystore decrypts with '', even when RADIUS_PASSWORD is already exported for later commands.
      const current = readPasswordless()
        ? ''
        : cfg.password ?? await promptPassword({ message: 'Current keystore password:', mask: '*' });
      // The env value gets the same rule as the prompt, so an empty or unset CI secret never strips the password.
      const envNext = process.env.RADIUS_NEW_PASSWORD;
      if (subOpts.remove && envNext !== undefined) throw new Error('Pass either --remove or RADIUS_NEW_PASSWORD, not both.');
      if (envNext !== undefined && envNext.length < 8) {
        throw new Error('RADIUS_NEW_PASSWORD must be at least 8 characters. To remove the password, pass --remove.');
      }
      const next = subOpts.remove ? '' : await readNewPassword(envNext);
      let address: Address;
      try {
        address = await changeKeystorePassword(cfg.keystorePath, current, next);
      } catch (err) {
        if (current !== '' && cfg.password !== undefined) {
          throw new Error(`Could not decrypt ${cfg.keystorePath} with RADIUS_PASSWORD: ${errDetail(err)}`);
        }
        throw new Error(`Could not decrypt ${cfg.keystorePath}: ${errDetail(err)}`);
      }
      writeCachedAddress(address);
      writePasswordless(next === '');
      if (opts.json) {
        console.log(jsonStringify({ path: cfg.keystorePath, address, passwordless: next === '' }));
        return;
      }
      console.log(next === '' ? `Removed the password from ${cfg.keystorePath}` : `Updated the password of ${cfg.keystorePath}`);
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
          ?? (readPasswordless() ? '' : await promptPassword({ message: 'Keystore password:', mask: '*' }));
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
      for (const line of formatBalanceLines(report)) console.log(line);
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

  wallet
    .command('approve')
    .description('Approve a spender to move tokens from the local account (ERC-20 approve)')
    .argument('<spender>', 'address allowed to spend')
    .argument('<amount>', 'amount in display units (e.g. 1.5), or "max" for an unlimited approval')
    .argument('[token]', TOKEN_ARG_HELP, 'SBC')
    .option('--no-wait', 'do not wait for the receipt before returning')
    .option('--gas-limit <units>', 'gas limit for the transaction (skips the eth_estimateGas roundtrip)')
    .action(async (spender: string, amountArg: string, tokenArg: string, subOpts: { wait?: boolean; gasLimit?: string }, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      if (!isAddress(spender)) throw new Error(`Not a valid address: ${spender}`);
      const token = parseTokenArg(cfg, tokenArg);
      const amount = parseAmountArg(amountArg);
      const gas = parseGasLimit(subOpts.gasLimit);

      const account = await requireAccount(cfg, opts.privateKey);
      const publicClient = makePublicClient(cfg);
      const walletClient = makeWalletClient(cfg, account);
      const { hash } = await walletClient.approve({ token, spender: spender as Address, amount, gas, wait: false });
      await reportTx(publicClient, hash, opts, subOpts.wait !== false);
    });

  wallet
    .command('allowance')
    .description('Show how much of a token a spender may move from an owner (ERC-20 allowance)')
    .argument('<spender>', 'address allowed to spend')
    .argument('[token]', TOKEN_ARG_HELP, 'SBC')
    .option('--owner <address>', 'token owner (defaults to the local account)')
    .action(async (spender: string, tokenArg: string, subOpts: { owner?: string }, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      if (!isAddress(spender)) throw new Error(`Not a valid address: ${spender}`);
      let owner: Address;
      if (subOpts.owner) {
        if (!isAddress(subOpts.owner)) throw new Error(`Not a valid address: ${subOpts.owner}`);
        owner = subOpts.owner as Address;
      } else {
        owner = await getOwnAddress(cfg, opts.privateKey);
      }
      const token = parseTokenArg(cfg, tokenArg);

      const client = makePublicClient(cfg);
      const [info, allowanceWei] = await Promise.all([
        describeToken(client, token),
        client.getAllowance({ token, owner, spender: spender as Address }),
      ]);
      const allowance = formatUnits(allowanceWei, info.decimals);
      if (opts.json) {
        console.log(jsonStringify({ token: info.address, symbol: info.symbol, decimals: info.decimals, owner, spender, allowance, allowanceWei }));
        return;
      }
      console.log(`Token:     ${info.symbol} (${info.address})`);
      console.log(`Owner:     ${owner}`);
      console.log(`Spender:   ${spender}`);
      console.log(`Allowance: ${allowance} ${info.symbol}`);
    });

  wallet
    .command('token')
    .description('Show an ERC-20 token\'s name, symbol, decimals and total supply')
    .argument('[token]', TOKEN_ARG_HELP, 'SBC')
    .action(async (tokenArg: string, _subOpts, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      const client = makePublicClient(cfg);
      const meta = await client.getTokenMetadata({ token: parseTokenArg(cfg, tokenArg) });
      if (opts.json) {
        console.log(jsonStringify({ ...meta, totalSupplyFormatted: formatUnits(meta.totalSupply, meta.decimals) }));
        return;
      }
      console.log(`Address:      ${meta.address}`);
      console.log(`Name:         ${meta.name}`);
      console.log(`Symbol:       ${meta.symbol}`);
      console.log(`Decimals:     ${meta.decimals}`);
      console.log(`Total supply: ${formatUnits(meta.totalSupply, meta.decimals)} ${meta.symbol}`);
    });

  wallet
    .command('transfers')
    .description('List ERC-20 Transfer events of a token (defaults to those sent or received by the local account)')
    .argument('[token]', TOKEN_ARG_HELP, 'SBC')
    .option('--from <address>', 'only transfers sent by this address')
    .option('--to <address>', 'only transfers received by this address')
    .option('--address <address>', 'transfers sent or received by this address (default: local account)')
    .option('--all', 'every transfer of the token, no address filter')
    .option('--blocks <n>', `look back this many blocks from the latest (default: ${MAX_LOG_RANGE}; Radius block numbers are unix milliseconds, so about 16.7 minutes)`)
    .option('--from-block <n>', 'first block to search (overrides --blocks)')
    .option('--to-block <n>', 'last block to search (default: latest)')
    .action(async (tokenArg: string, subOpts: TransferSideOptions & { blocks?: string; fromBlock?: string; toBlock?: string }, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      const token = parseTokenArg(cfg, tokenArg);
      const client = makePublicClient(cfg);
      const sides = await resolveTransferSides(cfg, opts, subOpts);

      const toBlock = subOpts.toBlock !== undefined ? parseBlock(subOpts.toBlock, '--to-block') : await client.getBlockNumber();
      let fromBlock: bigint;
      if (subOpts.fromBlock !== undefined) {
        fromBlock = parseBlock(subOpts.fromBlock, '--from-block');
      } else {
        const lookback = subOpts.blocks !== undefined ? parseBlock(subOpts.blocks, '--blocks') : MAX_LOG_RANGE;
        fromBlock = toBlock > lookback ? toBlock - lookback : 0n;
      }
      if (fromBlock > toBlock) throw new Error(`--from-block ${fromBlock} is after --to-block ${toBlock}`);

      const [info, transfers] = await Promise.all([describeToken(client, token), listTransfers(client, { token, ...sides, fromBlock, toBlock })]);
      const rows = transfers.map((t) => toTransferRow(t, info));
      if (opts.json) {
        console.log(jsonStringify({ token: info.address, symbol: info.symbol, fromBlock, toBlock, transfers: rows }));
        return;
      }
      console.log(`${info.symbol} transfers, blocks ${fromBlock}–${toBlock}: ${rows.length}`);
      for (const t of transfers) console.log(formatTransferLine(t, info));
    });

  wallet
    .command('watch')
    .description('Stream ERC-20 Transfer events of a token as they happen (defaults to the local account, Ctrl-C to stop)')
    .argument('[token]', TOKEN_ARG_HELP, 'SBC')
    .option('--from <address>', 'only transfers sent by this address')
    .option('--to <address>', 'only transfers received by this address')
    .option('--address <address>', 'transfers sent or received by this address (default: local account)')
    .option('--all', 'every transfer of the token, no address filter')
    .option('--poll <ms>', 'polling interval in milliseconds (default: the client\'s)')
    .action(async (tokenArg: string, subOpts: TransferSideOptions & { poll?: string }, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      const token = parseTokenArg(cfg, tokenArg);
      const client = makePublicClient(cfg);
      const sides = await resolveTransferSides(cfg, opts, subOpts);
      const pollingInterval = subOpts.poll !== undefined ? Number(parseBlock(subOpts.poll, '--poll')) : undefined;
      const info = await describeToken(client, token);

      const seen = new Set<string>();
      const onTransfer = (t: TokenTransfer) => {
        const key = `${t.transactionHash}:${t.logIndex}`;
        if (seen.has(key)) return; // a self-transfer matches both directions
        seen.add(key);
        if (opts.json) console.log(jsonStringify(toTransferRow(t, info), 0));
        else console.log(formatTransferLine(t, info));
      };
      const onError = (e: Error) => process.stderr.write(`watch: ${e.message}\n`);
      const stops = transferFilters(sides).map((f) => client.watchTransfers({ token, ...f, onTransfer, onError, pollingInterval }));
      if (!opts.json) {
        const who = sides.from || sides.to ? [sides.from && `from ${sides.from}`, sides.to && `to ${sides.to}`].filter(Boolean).join(' ') : sides.address ? `involving ${sides.address}` : 'all';
        process.stderr.write(`Watching ${info.symbol} transfers (${who}) on ${cfg.network}… Ctrl-C to stop\n`);
      }
      await new Promise<void>((resolve) => {
        const stop = () => {
          for (const unwatch of stops) unwatch();
          resolve();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });

  registerWalletPay(wallet);
}

interface TransferSideOptions {
  from?: string;
  to?: string;
  address?: string;
  all?: boolean;
}

/** `--from` / `--to` win; `--all` drops the address filter; otherwise `--address` or the local account, both directions. */
async function resolveTransferSides(cfg: ReturnType<typeof resolveConfig>, opts: GlobalOptions, subOpts: TransferSideOptions): Promise<TransferSides> {
  const addr = (value: string | undefined, flag: string): Address | undefined => {
    if (value === undefined) return undefined;
    if (!isAddress(value)) throw new Error(`${flag}: not a valid address: ${value}`);
    return value as Address;
  };
  const from = addr(subOpts.from, '--from');
  const to = addr(subOpts.to, '--to');
  if (from || to) return { from, to };
  if (subOpts.all) return {};
  return { address: addr(subOpts.address, '--address') ?? (await getOwnAddress(cfg, opts.privateKey)) };
}

function parseBlock(input: string, flag: string): bigint {
  let value: bigint;
  try {
    value = BigInt(input);
  } catch {
    throw new Error(`${flag} must be a non-negative integer, got: ${input}`);
  }
  if (value < 0n) throw new Error(`${flag} must be a non-negative integer, got: ${input}`);
  return value;
}

function formatTransferLine(t: TokenTransfer, info: { symbol: string; decimals: number }): string {
  return `${t.blockNumber.toString().padStart(12)}  ${t.from} → ${t.to}  ${formatUnits(t.amount, info.decimals)} ${info.symbol}  ${t.transactionHash}`;
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
