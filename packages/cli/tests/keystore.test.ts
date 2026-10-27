import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { changeKeystorePassword, keystoreExists, loadKeystorePrivateKey, saveKeystore, readKeystoreAddress } from '../src/lib/keystore.js';

describe('keystore', () => {
  let dir: string;
  let path: string;
  const password = 'correct-horse-battery-staple';
  const privateKey = generatePrivateKey();
  const expectedAddress = privateKeyToAccount(privateKey).address;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'radius-cli-test-'));
    path = join(dir, 'keystore.json');
  });

  it('reports keystore absence before save', () => {
    expect(keystoreExists(path)).toBe(false);
  });

  it('round-trips a private key through the encrypted keystore', async () => {
    const addr = await saveKeystore(path, privateKey, password);
    expect(addr.toLowerCase()).toBe(expectedAddress.toLowerCase());
    expect(keystoreExists(path)).toBe(true);

    const loaded = await loadKeystorePrivateKey(path, password);
    expect(loaded.toLowerCase()).toBe(privateKey.toLowerCase());
  }, 20_000);

  it('exposes the keystore address without decryption', () => {
    const addr = readKeystoreAddress(path);
    expect(addr?.toLowerCase()).toBe(expectedAddress.toLowerCase());
  });

  it('throws on a bad password', async () => {
    await expect(loadKeystorePrivateKey(path, 'wrong')).rejects.toThrow();
  }, 20_000);

  it('adds a password to a passwordless keystore without changing the key', async () => {
    const p = join(dir, 'passwordless.json');
    await saveKeystore(p, privateKey, '');
    const addr = await changeKeystorePassword(p, '', password);
    expect(addr.toLowerCase()).toBe(expectedAddress.toLowerCase());
    expect(existsSync(`${p}.tmp`)).toBe(false);
    await expect(loadKeystorePrivateKey(p, '')).rejects.toThrow();
    expect((await loadKeystorePrivateKey(p, password)).toLowerCase()).toBe(privateKey.toLowerCase());
  }, 60_000);

  it('refuses to change the password without the current one', async () => {
    await expect(changeKeystorePassword(path, 'wrong', 'new-password')).rejects.toThrow();
    expect((await loadKeystorePrivateKey(path, password)).toLowerCase()).toBe(privateKey.toLowerCase());
  }, 60_000);
});
