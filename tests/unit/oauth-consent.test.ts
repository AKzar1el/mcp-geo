import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { missingConnectSecretResponse } from '../../src/core/oauth-consent.js';

test('hosted OAuth refuses missing and blank connection secrets without echoing input', async () => {
  for (const secret of [undefined, null, '', '   ', '\t\n']) {
    const response = missingConnectSecretResponse(secret);
    assert.ok(response);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(await response.text(), /configure[s]? CONNECT_SECRET/);
  }
});

test('configured connection secret leaves the existing form-based approval gate enabled', () => {
  assert.equal(missingConnectSecretResponse('configured-value'), null);
  assert.equal(missingConnectSecretResponse(' configured-value '), null);
});

test('the hosted /authorize path fails closed before issuing any OAuth grant', () => {
  const source = readFileSync('src/index.ts', 'utf8');
  const handler = source.split('async function handleAuthorize(')[1]?.split('function configuredOAuthResource(')[0];
  assert.ok(handler);
  const guard = handler.indexOf('missingConnectSecretResponse(env.CONNECT_SECRET)');
  const grant = handler.indexOf('env.OAUTH_PROVIDER.completeAuthorization(');
  assert.ok(guard >= 0 && grant > guard);
  assert.match(handler, /if \(missingSecret\) return missingSecret/);
});
