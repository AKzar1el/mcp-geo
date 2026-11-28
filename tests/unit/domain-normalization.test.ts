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

test('IDNA dot separators and a single DNS root dot preserve canonical domain identity', () => {
  const idn = 'xn--fsqu00a.xn--0zwm56d';
  for (const separator of ['\u3002', '\uff0e', '\uff61']) {
    assert.equal(normalizeDomainInput(`\u4f8b\u5b50${separator}\u6d4b\u8bd5`), idn);
    assert.equal(normalizeRequiredDomain(`https://www.\u4f8b\u5b50${separator}\u6d4b\u8bd5/`), idn);
  }
  assert.equal(normalizeDomainInput('example.com.'), 'example.com');
  assert.equal(normalizeDomainInput('https://www.example.com./help'), 'example.com');
  assert.deepEqual(
    normalizeCompetitorDomains(['example.com.', 'example.com'], 'acme.com'),
    ['example.com'],
  );
  for (const invalid of ['example.com..', 'example..com', '.example.com', '.', 'example.com@evil.com']) {
    assert.equal(normalizeDomainInput(invalid), null, invalid);
  }
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

test('non-web URL schemes are not silently accepted as a monitored web domain', () => {
  for (const input of [
    'ftp://example.com',
    'file://example.com/local',
    'javascript://example.com',
    'mailto://example.com',
  ]) {
    assert.equal(normalizeDomainInput(input), null, input);
    assert.throws(() => normalizeRequiredDomain(input), DomainInputError, input);
    assert.throws(() => normalizeCompetitorDomains([input], 'acme.com'), DomainInputError, input);
  }
  assert.equal(normalizeDomainInput('https://www.EXAMPLE.COM/guide'), 'example.com');
  assert.equal(normalizeDomainInput('http://example.com:8080/guide'), 'example.com');
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

test('oversized invalid domains produce bounded errors for brands and competitors', () => {
  const input = `${'a'.repeat(100_000)}.example`;
  for (const validate of [
    () => normalizeRequiredDomain(input),
    () => normalizeCompetitorDomains([input], 'acme.com'),
  ]) {
    assert.throws(validate, (error: unknown) => {
      assert.ok(error instanceof DomainInputError);
      assert.ok(error.message.length <= 256);
      assert.ok(error.message.includes(`'${'a'.repeat(80)}...'`));
      assert.ok(!error.message.includes(input));
      assert.match(error.message, /does not look like a domain/);
      assert.match(error.message, /Pass .*domains? like/);
      return true;
    });
  }
});

test('domain errors sanitize newline, control, formatting and delimiter injection', () => {
  for (const injection of [
    '\r\n',
    '\t',
    '\u0000',
    '\u001b',
    '\u007f',
    '\u0085',
    '\u2028',
    '\u2029',
    '\u202e',
    '\u2066',
    "'",
  ]) {
    const input = `bad${injection}FORGED.example`;
    for (const validate of [
      () => normalizeRequiredDomain(input),
      () => normalizeCompetitorDomains([input], 'acme.com'),
    ]) {
      assert.throws(validate, (error: unknown) => {
        assert.ok(error instanceof DomainInputError);
        assert.ok(error.message.length <= 256);
        assert.doesNotMatch(error.message, /[\p{C}\p{Zl}\p{Zp}]/u);
        assert.ok(!error.message.includes(input));
        assert.match(error.message, /'bad\?+FORGED\.example'/);
        assert.match(error.message, /does not look like a domain/);
        return true;
      });
    }
  }
});

test('ordinary invalid domains retain useful input feedback and guidance', () => {
  for (const input of ['not a domain.com', 'example..com']) {
    assert.throws(() => normalizeRequiredDomain(input), (error: unknown) => {
      assert.ok(error instanceof DomainInputError);
      assert.equal(
        error.message,
        `'${input}' does not look like a domain. Pass a bare domain like 'acme.com' (no scheme or path needed).`,
      );
      return true;
    });
    assert.throws(
      () => normalizeCompetitorDomains([input], 'acme.com'),
      (error: unknown) => {
        assert.ok(error instanceof DomainInputError);
        assert.equal(
          error.message,
          `Competitor '${input}' does not look like a domain. Pass bare domains like 'asana.com'.`,
        );
        return true;
      },
    );
  }
});

test('long URL paths still normalize valid brand and competitor hosts', () => {
  const input = `https://www.EXAMPLE.COM/${'a'.repeat(100_000)}`;
  assert.equal(normalizeRequiredDomain(input), 'example.com');
  assert.deepEqual(normalizeCompetitorDomains([input], 'acme.com'), ['example.com']);
});

test('invalid URL-like domain diagnostics do not disclose userinfo or access data', () => {
  const marker = 'PRIVATE_SYNTHETIC';
  for (const input of [
    'person@example.com',
    'bad\\FORGED.example',
    'https://user:' + marker + '@example.invalid',
    'https://user%3A' + marker + '%40example.invalid',
    'ftp://example.invalid/' + marker,
    'not a domain?token=' + marker,
    'not a domain#' + marker,
    'not a domain/' + marker,
    'not a domain\\' + marker,
    'bad.example:' + marker,
    'not a domain;' + marker,
    'not a domain\uFF20' + marker,
    'not a domain\uFF1D' + marker,
    marker + 'x'.repeat(100) + '@example.invalid',
  ]) {
    assert.equal(normalizeDomainInput(input), null);
    for (const validate of [
      () => normalizeRequiredDomain(input),
      () => normalizeCompetitorDomains([input], 'acme.com'),
    ]) {
      assert.throws(validate, (error: unknown) => {
        assert.ok(error instanceof DomainInputError);
        assert.match(error.message, /'\[redacted\]' does not look like a domain/);
        assert.ok(!error.message.includes(marker));
        assert.ok(!error.message.includes(input));
        assert.doesNotMatch(error.message, /[\p{C}\p{Zl}\p{Zp}]/u);
        assert.match(error.message, /Pass .*domains? like/);
        return true;
      });
    }
  }
});
