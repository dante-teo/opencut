import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { notarize } from '@electron/notarize';
import { signAsync } from '@electron/osx-sign';

const [input, output] = process.argv.slice(2);
if (!input || !output || process.argv.length !== 4 || existsSync(output))
  throw new Error(
    'Usage: node scripts/release/sign.mjs <local-app.zip> <new-signed-app.zip>',
  );
const {
  OPENCUT_SIGNING_KEYCHAIN,
  OPENCUT_NOTARY_KEY_PATH,
  OPENCUT_NOTARY_KEY_ID,
  OPENCUT_NOTARY_ISSUER,
} = process.env;
if (
  !OPENCUT_SIGNING_KEYCHAIN ||
  !OPENCUT_NOTARY_KEY_PATH ||
  !OPENCUT_NOTARY_KEY_ID ||
  !OPENCUT_NOTARY_ISSUER
)
  throw new Error(
    'Developer ID keychain and notarization API key configuration are required.',
  );

const work = mkdtempSync(join(tmpdir(), 'opencut-sign-'));
const app = join(work, 'OpenCut Review.app');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
try {
  run('/usr/bin/ditto', ['-x', '-k', resolve(input), work]);
  await signAsync({
    app,
    identity: 'Developer ID Application',
    keychain: OPENCUT_SIGNING_KEYCHAIN,
    hardenedRuntime: true,
    preAutoEntitlements: false,
  });
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  await notarize({
    appPath: app,
    appleApiKey: OPENCUT_NOTARY_KEY_PATH,
    appleApiKeyId: OPENCUT_NOTARY_KEY_ID,
    appleApiIssuer: OPENCUT_NOTARY_ISSUER,
  });
  run('/usr/bin/xcrun', ['stapler', 'validate', app]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', app]);
  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, resolve(output)]);
} finally {
  rmSync(work, { recursive: true, force: true });
}
