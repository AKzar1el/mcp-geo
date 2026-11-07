import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DomainInputError,
  normalizeCompetitorDomains,
  normalizeDomainInput,
  normalizeRequiredDomain,
} from '../../src/core/domain.ts';

test('Unicode internationalized domains normalize to canonical ASCII IDNs', () => {
  assert.equal(normalizeDomainInput('b\u00fccher.de'), 'xn--bcher-kva.de');
  assert.equal(
    normalizeRequiredDomain('https://www.B\u00dcCHER.de/catalogue?ref=example'),
    'xn--bcher-kva.de',
  );
  assert.equal(
    normalizeDomainInput('\u4f8b\u5b50.\u6d4b\u8bd5'),
    'xn--fsqu00a.xn--0zwm56d',
  );
});

test('Unicode and punycode duplicates resolve to one canonical competitor', () => {
  assert.deepEqual(
    normalizeCompetitorDomains(
      ['b\u00fccher.de', 'xn--bcher-kva.de', 'https://www.B\u00dcCHER.de', 'acme.com'],
      'acme.com',
    ),
    ['xn--bcher-kva.de'],
  );
});

test('IDNA-folded www prefixes canonicalize to the same domain identity', () => {
  assert.equal(
    normalizeDomainInput('https://\uff37\uff37\uff37.B\u00dcCHER.de/catalogue'),
    'xn--bcher-kva.de',
  );
  assert.equal(
    normalizeDomainInput('\uff57\uff57\uff57.example.com'),
    'example.com',
  );
  assert.deepEqual(
    normalizeCompetitorDomains(
      ['\uff57\uff57\uff57.example.com', 'example.com'],
      'example.com',
    ),
    [],
  );
});

test('domain normalization still rejects invalid host syntax and encoded URL tricks', () => {
  for (const input of [
    'not a domain.com',
    'person@example.com',
    '%61cme.com',
    'foo_bar.com',
    'example..com',
    'example.com:abc',
    '-bad.example',
  ]) {
    assert.equal(normalizeDomainInput(input), null, input);
    assert.throws(() => normalizeRequiredDomain(input), DomainInputError, input);
  }
});

test('IP addresses cannot be enrolled as a brand or competitor domain', () => {
  for (const input of [
    '127.0.0.1',
    'https://192.168.0.1/dashboard',
    '8.8.8.8',
    '0x7f.0.0.1',
  ]) {
    assert.equal(normalizeDomainInput(input), null, input);
    assert.throws(() => normalizeRequiredDomain(input), DomainInputError, input);
    assert.throws(() => normalizeCompetitorDomains([input], 'acme.com'), DomainInputError, input);
  }
  assert.equal(normalizeDomainInput('123.example.com'), '123.example.com');
});

test('domain labels cannot exceed the DNS 63-octet limit after IDNA conversion', () => {
  const validAscii = `${'a'.repeat(63)}.example`;
  const tooLongAscii = `${'a'.repeat(64)}.example`;
  const tooLongTld = `example.${'a'.repeat(64)}`;
  const validIdn = `${'\u00fc'.repeat(57)}.de`;
  const tooLongIdn = `${'\u00fc'.repeat(58)}.de`;

  assert.equal(normalizeDomainInput(validAscii), validAscii);
  assert.equal(normalizeDomainInput(validIdn)?.split('.')[0].length, 63);
  for (const input of [tooLongAscii, tooLongTld, tooLongIdn]) {
    assert.equal(normalizeDomainInput(input), null, input);
    assert.throws(() => normalizeRequiredDomain(input), DomainInputError, input);
    assert.throws(
      () => normalizeCompetitorDomains([input], 'acme.com'),
      DomainInputError,
      input,
    );
  }
});
