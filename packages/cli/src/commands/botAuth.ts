import type { Command } from 'commander';
import { configuredBotAuth, DIRECTORY_CONTENT_TYPE, DIRECTORY_PATH, keyDirectory } from '../lib/botAuth.js';
import { jsonStringify } from '../lib/format.js';

export function registerBotAuth(program: Command): void {
  const botAuth = program
    .command('bot-auth')
    .description(
      'Web Bot Auth: sign outgoing HTTP requests (wallet pay) with RFC 9421 message signatures. Off unless ' +
        'RADIUS_SIGNING_KEY names an Ed25519 private key file (PKCS#8 PEM or JWK); RADIUS_SIGNATURE_AGENT is the ' +
        'origin hosting its key directory (default https://radiustech.xyz).',
    );

  botAuth
    .command('directory')
    .description(
      [
        `Print the key directory (JWKS) for RADIUS_SIGNING_KEY's public key, to host at <origin>${DIRECTORY_PATH}.`,
        `Serve it as ${DIRECTORY_CONTENT_TYPE}, with the response signed as Cloudflare's Web Bot Auth docs describe.`,
        'Prints only the public key.',
        '',
        '  RADIUS_SIGNING_KEY=./web-bot-auth.pem radius-cli bot-auth directory > directory.json',
      ].join('\n'),
    )
    .action(async () => {
      const auth = await configuredBotAuth();
      if (!auth) {
        process.stderr.write('bot-auth directory: set RADIUS_SIGNING_KEY to the path of an Ed25519 private key\n');
        process.exitCode = 2;
        return;
      }
      process.stdout.write(`${jsonStringify(keyDirectory(auth))}\n`);
      process.stderr.write(
        `Host at ${auth.signatureAgent}${DIRECTORY_PATH} as ${DIRECTORY_CONTENT_TYPE}, signed per Cloudflare's Web Bot Auth docs.\n` +
          `keyid: ${auth.signer.keyid}\n`,
      );
    });
}
