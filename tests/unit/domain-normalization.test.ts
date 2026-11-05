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
