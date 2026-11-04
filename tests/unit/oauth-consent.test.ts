import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  hasExplicitClientApproval,
  missingConnectSecretResponse,
} from '../../src/core/oauth-consent.js';

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

test('OAuth client authorization requires one explicit positive approval, not merely a secret', () => {
  assert.equal(hasExplicitClientApproval(null), false);
  const form = new FormData();
  assert.equal(hasExplicitClientApproval(form), false);
  form.set('approve_client', 'no');
  assert.equal(hasExplicitClientApproval(form), false);
  form.set('approve_client', 'yes');
  assert.equal(hasExplicitClientApproval(form), true);
  form.append('approve_client', 'yes');
  assert.equal(hasExplicitClientApproval(form), false);
});

test('the hosted /authorize path fails closed before issuing any OAuth grant', () => {
  const source = readFileSync('src/index.ts', 'utf8');
  const handler = source.split('async function handleAuthorize(')[1]?.split('function configuredOAuthResource(')[0];
  assert.ok(handler);
  const guard = handler.indexOf('missingConnectSecretResponse(env.CONNECT_SECRET)');
  const approval = handler.indexOf('hasExplicitClientApproval(form)');
  const grant = handler.indexOf('env.OAUTH_PROVIDER.completeAuthorization(');
  assert.ok(guard >= 0 && approval > guard && grant > approval);
  assert.match(handler, /if \(missingSecret\) return missingSecret/);
  const sourceForm = source.split('function renderConnectForm(')[1]?.split('async function handleAuthorize(')[0];
  assert.ok(sourceForm);
  assert.match(sourceForm, /name="approve_client" value="yes" required/);
  assert.match(sourceForm, /escapeHtml\(\(params\.get\('client_id'\)/);
  assert.match(sourceForm, /'cache-control': 'no-store'/);
  assert.match(sourceForm, /'referrer-policy': 'no-referrer'/);
});
