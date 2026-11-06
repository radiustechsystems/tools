import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { Wallet } from 'ethers';
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress, type Address, type Hex } from 'viem';

export function keystoreExists(path: string): boolean {
  return existsSync(path);
}

export async function saveKeystore(path: string, privateKey: Hex, password: string): Promise<Address> {
  const wallet = new Wallet(privateKey);
  const json = await wallet.encrypt(password);

  // Write through a symlink to its target, as a plain write would, rather than replacing the link.
  const target = existsSync(path) ? realpathSync(path) : path;
  const dir = dirname(target);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Write a fresh, uniquely named temp file (0o600 from creation, fsynced), then rename it into place,
  // so an interrupted write or a concurrent CLI process never leaves a partial or foreign keystore.
  const tmp = join(dir, `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, json);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }

  return wallet.address as Address;
}

/** Re-encrypt the keystore under a new password. The key, and so the address, stay the same. */
export async function changeKeystorePassword(path: string, currentPassword: string, newPassword: string): Promise<Address> {
  const pk = await loadKeystorePrivateKey(path, currentPassword);
  return await saveKeystore(path, pk, newPassword);
}

export async function loadKeystorePrivateKey(path: string, password: string): Promise<Hex> {
  if (!existsSync(path)) {
    throw new Error(`No keystore at ${path}. Run \`radius-cli wallet new\` or \`radius-cli wallet import\` first.`);
  }
  const json = readFileSync(path, 'utf8');
  const wallet = await Wallet.fromEncryptedJson(json, password);
  return wallet.privateKey as Hex;
}

export async function loadAccount(path: string, password: string) {
  const pk = await loadKeystorePrivateKey(path, password);
  return privateKeyToAccount(pk);
}

export function readKeystoreAddress(path: string): Address | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8')) as { address?: string };
    if (!obj.address) return undefined;
    const addr = obj.address.startsWith('0x') ? obj.address : `0x${obj.address}`;
    return getAddress(addr);
  } catch {
    return undefined;
  }
}
