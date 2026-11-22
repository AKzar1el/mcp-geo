import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  hasExplicitClientApproval,
  missingConnectSecretResponse,
  oauthRedirectAuthority,
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
  assert.match(sourceForm, /const clientId = escapeHtml\(params\.get\('client_id'\) \?\? ''\)/);
  assert.match(sourceForm, /const requestedScope = escapeHtml\(params\.get\('scope'\) \?\? ''\)/);
  assert.doesNotMatch(sourceForm, /\.slice\(0, 240\)/);
  assert.match(sourceForm, /'cache-control': 'no-store'/);
  assert.match(sourceForm, /'referrer-policy': 'no-referrer'/);
});

test('OAuth approval shows a complete, escaped redirect plus its parsed authority', () => {
  const source = readFileSync('src/index.ts', 'utf8');
  const sourceForm = source.split('function renderConnectForm(')[1]?.split('async function handleAuthorize(')[0];
  assert.ok(sourceForm);
  assert.match(sourceForm, /const redirectTarget = escapeHtml\(redirectUri\)/);
  assert.doesNotMatch(sourceForm, /redirectUri\.slice\(|redirectTarget\.slice\(/);
  assert.match(sourceForm, /oauthRedirectAuthority\(redirectUri\)/);
  assert.match(sourceForm, /Redirect destination \(unverified\): <code>\$\{redirectTarget\}<\/code>/);
  assert.match(sourceForm, /Parsed redirect authority \(unverified\): <code>\$\{escapeHtml\(redirectAuthority\)\}<\/code>/);
  assert.doesNotMatch(sourceForm, /href="\$\{redirectTarget\}"/);
});

test('redirect authority reveals the actual recipient behind long paths, userinfo and IDNs', () => {
  const deceptive = `https://trusted.example@receiver.evil.example/${'x'.repeat(350)}`;
  assert.equal(oauthRedirectAuthority(deceptive), 'https://receiver.evil.example');
  assert.equal(oauthRedirectAuthority('https://example.org:8443/callback'), 'https://example.org:8443');
  assert.equal(oauthRedirectAuthority('https://b\u00fccher.example/cb'), 'https://xn--bcher-kva.example');
  assert.equal(oauthRedirectAuthority('native-app:/callback'), null);
  assert.equal(oauthRedirectAuthority('not a URL'), null);
});
