// Unit tests for brand/competitor mention matching in extractCitations.
// Run with: npm run test:unit  (node --test via tsx, so we can import the
// TypeScript source directly). tests/ is outside tsconfig `include`, so this
// file is intentionally not part of `npm run typecheck`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractCitations } from '../src/core/openai.ts';
import type { Brand } from '../src/db/types.ts';

function makeBrand(overrides: Partial<Brand>): Brand {
  return {
    id: 'test-brand',
    user_id: 'dev-user',
    domain: 'example.com',
    name: 'Example',
    category: null,
    competitors: [],
    aliases: [],
    exclude_terms: [],
    refresh_frequency: 'weekly',
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

test('excluded bare word does not count as a brand mention', () => {
  const brand = makeBrand({
    domain: 'monday.com',
    name: 'Monday',
    competitors: ['notion.so'],
    aliases: [],
    exclude_terms: ['monday'],
  });
  const { brand_mentioned } = extractCitations(
    brand,
    'send the report on monday, promise.',
  );
  assert.equal(brand_mentioned, 0);
});

test('full domain still counts even when the bare word is excluded', () => {
  const brand = makeBrand({
    domain: 'monday.com',
    name: 'Monday',
    competitors: ['notion.so'],
    aliases: [],
    exclude_terms: ['monday'],
  });
  const { brand_mentioned } = extractCitations(brand, 'check monday.com for that.');
  assert.equal(brand_mentioned, 1);
});

test('malformed repeated-dot domain suffixes do not count as brand or competitor mentions', () => {
  const brand = makeBrand({
    domain: 'acme.com',
    name: 'Different legal name',
    competitors: ['rival.com'],
    exclude_terms: ['acme'],
  });
  const malformed = extractCitations(
    brand,
    'Misleading hosts include acme.com..attacker.test and shop.rival.com..fake.example.',
  );
  assert.equal(malformed.brand_mentioned, 0);
  assert.deepEqual(malformed.competitors_mentioned, []);

  const valid = extractCitations(brand, 'See acme.com. Then compare docs.rival.com...');
  assert.equal(valid.brand_mentioned, 1);
  assert.deepEqual(valid.competitors_mentioned, ['rival.com']);

  const mixed = extractCitations(brand, 'Not acme.com..fake.test, but acme.com is referenced.');
  assert.equal(mixed.brand_mentioned, 1);
});

test('HTML hidden subtrees cannot inflate visible mentions or linked citations', () => {
  const brand = makeBrand({
    domain: 'acme.com',
    name: 'Acme',
    competitors: ['rival.com'],
  });

  const hidden = extractCitations(brand,
    '<div hidden><p>Acme recommends rival.com. <a href="https://acme.com/source">Source</a></p></div>');
  assert.equal(hidden.brand_mentioned, 0);
  assert.equal(hidden.brand_cited_with_link, 0);
  assert.deepEqual(hidden.cited_urls, []);
  assert.deepEqual(hidden.competitors_mentioned, []);

  const inlineStyle = extractCitations(brand,
    '<section style="color: red; display: none !important"><span>Acme https://acme.com/hidden</span></section>');
  assert.equal(inlineStyle.brand_mentioned, 0);
  assert.equal(inlineStyle.brand_cited_with_link, 0);
  assert.deepEqual(inlineStyle.cited_urls, []);

  const visible = extractCitations(brand,
    '<div title="some hidden words">Acme <a href="https://acme.com/real">source</a></div>' +
    '<div hidden><div>rival.com https://rival.com/hidden</div></div>' +
    '<span>Independent visible text follows.</span>');
  assert.equal(visible.brand_mentioned, 1);
  assert.equal(visible.brand_cited_with_link, 1);
  assert.deepEqual(visible.cited_urls, ['acme.com']);
  assert.deepEqual(visible.competitors_mentioned, []);

  const afterHidden = extractCitations(brand,
    '<div hidden>rival.com https://rival.com/hidden</div>' +
    '<p>Acme remains visible. <a href="https://acme.com/source">Source</a></p>');
  assert.equal(afterHidden.brand_mentioned, 1);
  assert.equal(afterHidden.brand_cited_with_link, 1);
  assert.deepEqual(afterHidden.cited_urls, ['acme.com']);
  assert.deepEqual(afterHidden.competitors_mentioned, []);
});

test('fully transparent and skipped CSS subtrees cannot supply mention or citation evidence', () => {
  const brand = makeBrand({ domain: 'acme.com', name: 'Acme', competitors: ['rival.com'] });
  const invisible = extractCitations(brand,
    '<div style="opacity: 0"><p>Acme recommends rival.com ' +
    '<a href="https://acme.com/hidden">Source</a></p>' +
    '<span style="opacity:1">Acme is still transparent</span></div>' +
    '<section style="content-visibility: hidden !important">rival.com ' +
    '<a href="https://rival.com/skipped">Source</a></section>');
  assert.equal(invisible.brand_mentioned, 0);
  assert.equal(invisible.brand_cited_with_link, 0);
  assert.deepEqual(invisible.cited_urls, []);
  assert.deepEqual(invisible.competitors_mentioned, []);

  const visible = extractCitations(brand,
    '<div style="opacity: 0.5">Acme ' +
    '<a href="https://acme.com/visible">Source</a></div>' +
    '<section style="content-visibility:auto">rival.com remains visible</section>');
  assert.equal(visible.brand_mentioned, 1);
  assert.equal(visible.brand_cited_with_link, 1);
  assert.deepEqual(visible.cited_urls, ['acme.com']);
  assert.deepEqual(visible.competitors_mentioned, ['rival.com']);
});

test('CSS visibility excludes hidden evidence but preserves explicitly visible descendants', () => {
  const brand = makeBrand({ domain: 'acme.com', name: 'Acme', competitors: ['rival.com'] });
  const hidden = extractCitations(brand,
    '<div style="visibility: hidden">Acme and rival.com ' +
    '<a href="https://acme.com/hidden">Source</a><span>Acme</span></div>' +
    '<section style="visibility: collapse">Acme ' +
    '<a href="https://rival.com/collapsed">Source</a></section>');
  assert.equal(hidden.brand_mentioned, 0);
  assert.equal(hidden.brand_cited_with_link, 0);
  assert.deepEqual(hidden.competitors_mentioned, []);
  assert.deepEqual(hidden.cited_urls, []);

  const restored = extractCitations(brand,
    '<div style="visibility:hidden">Acme ' +
    '<span style="visibility:visible">rival.com ' +
    '<a href="https://rival.com/visible">Source</a></span>' +
    '<span>Acme <a href="https://acme.com/hidden">Source</a></span></div>' +
    '<p>Acme <a href="https://acme.com/outside">Source</a></p>');
  assert.equal(restored.brand_mentioned, 1);
  assert.equal(restored.brand_cited_with_link, 1);
  assert.deepEqual(restored.competitors_mentioned, ['rival.com']);
  assert.deepEqual(restored.cited_urls.sort(), ['acme.com', 'rival.com']);
});

test('closed HTML details score only the first visible summary, not undisclosed evidence', () => {
  const brand = makeBrand({ domain: 'acme.com', name: 'Acme', competitors: ['rival.com'] });
  const closed = extractCitations(brand,
    '<details><summary>More information</summary>' +
    '<p>Acme recommends rival.com <a href="https://acme.com/private">Source</a></p>' +
    '</details><p>Neutral public text</p>');
  assert.equal(closed.brand_mentioned, 0);
  assert.equal(closed.brand_cited_with_link, 0);
  assert.deepEqual(closed.competitors_mentioned, []);
  assert.deepEqual(closed.cited_urls, []);

  const summary = extractCitations(brand,
    '<details><summary>Acme <a href="https://acme.com/public">Source</a></summary>' +
    '<p>rival.com <a href="https://rival.com/private">Hidden</a></p>' +
    '<summary>rival.com later label</summary></details>');
  assert.equal(summary.brand_mentioned, 1);
  assert.equal(summary.brand_cited_with_link, 1);
  assert.deepEqual(summary.cited_urls, ['acme.com']);
  assert.deepEqual(summary.competitors_mentioned, []);

  const open = extractCitations(brand,
    '<details open="false"><summary>Details</summary>' +
    '<p>Acme and rival.com <a href="https://acme.com/open">Source</a></p></details>');
  assert.equal(open.brand_mentioned, 1);
  assert.equal(open.brand_cited_with_link, 1);
  assert.deepEqual(open.competitors_mentioned, ['rival.com']);

  const nested = extractCitations(brand,
    '<details open><summary>Outer</summary><details>' +
    '<summary>Inner</summary><p>rival.com</p></details>' +
    '<p>Acme <a href="https://acme.com/visible">Source</a></p></details>');
  assert.equal(nested.brand_mentioned, 1);
  assert.equal(nested.brand_cited_with_link, 1);
  assert.deepEqual(nested.competitors_mentioned, []);
});

test('closed HTML dialogs do not supply brand, competitor or linked citation evidence', () => {
  const brand = makeBrand({ domain: 'acme.com', name: 'Acme', competitors: ['rival.com'] });
  const closed = extractCitations(brand,
    '<dialog><p>Acme recommends rival.com ' +
    '<a href="https://acme.com/closed">Source</a></p></dialog>');
  assert.equal(closed.brand_mentioned, 0);
  assert.equal(closed.brand_cited_with_link, 0);
  assert.deepEqual(closed.competitors_mentioned, []);
  assert.deepEqual(closed.cited_urls, []);

  const open = extractCitations(brand,
    '<dialog open><p>Acme recommends rival.com ' +
    '<a href="https://acme.com/open">Source</a></p></dialog>');
  assert.equal(open.brand_mentioned, 1);
  assert.equal(open.brand_cited_with_link, 1);
  assert.deepEqual(open.competitors_mentioned, ['rival.com']);
  assert.deepEqual(open.cited_urls, ['acme.com']);

  const booleanOpen = extractCitations(brand,
    '<dialog open="false">Acme <a href="https://acme.com/boolean">Source</a></dialog>');
  assert.equal(booleanOpen.brand_mentioned, 1);
  assert.equal(booleanOpen.brand_cited_with_link, 1);

  const nested = extractCitations(brand,
    '<dialog><div><dialog open>rival.com ' +
    '<a href="https://rival.com/hidden">Source</a></dialog></div></dialog>' +
    '<p>Acme <a href="https://acme.com/visible">Source</a></p>');
  assert.equal(nested.brand_mentioned, 1);
  assert.equal(nested.brand_cited_with_link, 1);
  assert.deepEqual(nested.competitors_mentioned, []);
  assert.deepEqual(nested.cited_urls, ['acme.com']);
});

test('root term is not matched inside a larger word', () => {
  const brand = makeBrand({
    domain: 'notion.so',
    name: 'Notion',
    exclude_terms: [],
  });
  const { brand_mentioned } = extractCitations(
    brand,
    'this was promotional content.',
  );
  assert.equal(brand_mentioned, 0);
});

test('citation hosts ignore trailing punctuation while preserving brand links', () => {
  const brand = makeBrand({
    domain: 'example.com',
    name: 'Example',
    competitors: ['notion.so'],
  });
  const result = extractCitations(
    brand,
    'Sources: https://example.com, https://notion.so; https://foo.example.com! ',
  );
  assert.deepEqual(result.cited_urls, ['example.com', 'notion.so', 'foo.example.com']);
  assert.equal(result.brand_cited_with_link, 1);
});

test('competitor is matched as a standalone word', () => {
  const brand = makeBrand({
    domain: 'monday.com',
    name: 'Monday',
    competitors: ['notion.so'],
  });
  const { competitors_mentioned } = extractCitations(
    brand,
    'I prefer Notion for docs.',
  );
  assert.deepEqual(competitors_mentioned, ['notion.so']);
});

test('plain-text competitor names match the registrable label of common multi-part public suffixes', () => {
  const brand = makeBrand({
    domain: 'example.com',
    name: 'Example',
    competitors: ['acme.co.uk', 'zen.com.au', 'kumo.co.jp'],
  });
  const { competitors_mentioned } = extractCitations(
    brand,
    'For the shortlist, compare Acme with Zen and Kumo.',
  );
  assert.deepEqual(competitors_mentioned, ['acme.co.uk', 'zen.com.au', 'kumo.co.jp']);
});

test('Pakistani and Thai public suffixes keep competitor names visible in prose', () => {
  const brand = makeBrand({
    domain: 'example.com',
    competitors: ['paktech.com.pk', 'siam.co.th'],
  });
  assert.deepEqual(
    extractCitations(brand, 'Compare Paktech with Siam for your team.').competitors_mentioned,
    ['paktech.com.pk', 'siam.co.th'],
  );
  assert.deepEqual(
    extractCitations(brand, 'PaktechPlus and Siamese are different businesses.').competitors_mentioned,
    [],
  );
});

test('Saudi and Egyptian registrable names are counted without matching longer words', () => {
  const brand = makeBrand({
    domain: 'falcon.com.sa',
    name: 'Different legal name',
    competitors: ['lotus.com.eg'],
  });
  const observed = extractCitations(brand, 'Falcon and Lotus are compared in the response.');
  assert.equal(observed.brand_mentioned, 1);
  assert.deepEqual(observed.competitors_mentioned, ['lotus.com.eg']);

  const unrelated = extractCitations(brand, 'Falconry and Lotusware are different names.');
  assert.equal(unrelated.brand_mentioned, 0);
  assert.deepEqual(unrelated.competitors_mentioned, []);
});

test('Kenyan, Nigerian, Ugandan and Bangladeshi registrable names are visible evidence', () => {
  const brand = makeBrand({
    domain: 'bayleaf.co.ke',
    name: 'Different legal name',
    competitors: ['noria.com.ng', 'kampala.co.ug', 'delta.com.bd', 'robin.co.bd'],
  });
  const result = extractCitations(
    brand,
    'Bayleaf is mentioned alongside Noria, Kampala, Delta and Robin.',
  );
  assert.equal(result.brand_mentioned, 1);
  assert.deepEqual(result.competitors_mentioned, [
    'noria.com.ng', 'kampala.co.ug', 'delta.com.bd', 'robin.co.bd',
  ]);

  const unrelated = extractCitations(brand, 'The co and com divisions are separate.');
  assert.equal(unrelated.brand_mentioned, 0);
  assert.deepEqual(unrelated.competitors_mentioned, []);
});

test('independent tenants on private public suffixes count tenant names, not hosting brands', () => {
  const brand = makeBrand({
    domain: 'bayleaf.pages.dev',
    name: 'Different legal name',
    competitors: [
      'noria.github.io', 'lumen.vercel.app', 'sprout.netlify.app', 'cedar.blogspot.com',
    ],
  });
  const visible = extractCitations(
    brand,
    'Compare Bayleaf with Noria, Lumen, Sprout and Cedar for your next purchase.',
  );
  assert.equal(visible.brand_mentioned, 1);
  assert.deepEqual(visible.competitors_mentioned, brand.competitors);

  const hostingServices = extractCitations(
    brand,
    'GitHub, Vercel, Netlify, Blogspot and Pages are hosting platforms.',
  );
  assert.equal(hostingServices.brand_mentioned, 0);
  assert.deepEqual(hostingServices.competitors_mentioned, []);
});

test('subdomain-tracked brands and competitors match their registrable name in answer prose', () => {
  const brand = makeBrand({
    domain: 'portal.acme.com',
    name: 'Acme Portal',
    competitors: ['shop.rival.com', 'docs.zen.co.uk'],
  });
  const observed = extractCitations(brand, 'Acme and Rival compete with Zen for teams.');
  assert.equal(observed.brand_mentioned, 1);
  assert.deepEqual(observed.competitors_mentioned, ['shop.rival.com', 'docs.zen.co.uk']);

  const unrelated = extractCitations(
    brand,
    'Portal and Shop are ordinary words; Rivalry and Zenify are unrelated.',
  );
  assert.equal(unrelated.brand_mentioned, 0);
  assert.deepEqual(unrelated.competitors_mentioned, []);
  assert.deepEqual(
    extractCitations(brand, 'https://shop.rival.com/docs').competitors_mentioned,
    [],
  );
});

test('Australian government-domain competitor names match visible prose without a URL', () => {
  const brand = makeBrand({
    domain: 'example.com',
    competitors: ['services.gov.au'],
  });
  assert.deepEqual(
    extractCitations(brand, 'Services provides the official guidance.').competitors_mentioned,
    ['services.gov.au'],
  );
  assert.deepEqual(
    extractCitations(brand, 'Our team uses ServicesHub instead.').competitors_mentioned,
    [],
  );
  assert.deepEqual(
    extractCitations(brand, 'Read https://fake-services.gov.au for details.').competitors_mentioned,
    [],
  );
});

test('plain-text competitor names also match Colombian, Israeli and Vietnamese second-level domains', () => {
  const brand = makeBrand({
    domain: 'example.com',
    name: 'Example',
    competitors: ['andes.com.co', 'shahar.co.il', 'lotus.com.vn'],
  });
  const mentioned = extractCitations(
    brand,
    'Compare Andes with Shahar and Lotus for the next purchase.',
  );
  assert.deepEqual(mentioned.competitors_mentioned, brand.competitors);

  const unrelated = extractCitations(
    brand,
    'Andesbank is unrelated; fakeandes.com.co and shahar.co.il.evil.test are not those competitors.',
  );
  assert.deepEqual(unrelated.competitors_mentioned, []);
});

test('multi-part public suffix matching does not count embedded words or lookalike hosts', () => {
  const brand = makeBrand({
    domain: 'example.com',
    name: 'Example',
    competitors: ['acme.co.uk'],
  });
  const { competitors_mentioned } = extractCitations(
    brand,
    'AcmeBank is not this brand; fakeacme.co.uk is an unrelated domain.',
  );
  assert.deepEqual(competitors_mentioned, []);
});

test('unrelated URL metadata cannot manufacture brand or competitor mentions', () => {
  const brand = makeBrand({ domain: 'acme.com', name: 'Acme', competitors: ['rival.com'] });
  for (const response of [
    'https://tracker.example/?target=acme.com',
    'https://tracker.example/?next=https://acme.com',
    'https://tracker.example/redirect/Acme',
    'https://tracker.example/article#acme.com',
    'https://tracker.example/search?q=Acme',
    'https://tracker.example/?utm_source=rival.com',
    'https://tracker.example/rival.com/redirect',
    'https://rival.com@tracker.example/docs',
  ]) {
    const result = extractCitations(brand, response);
    assert.equal(result.brand_mentioned, 0, response);
    assert.deepEqual(result.competitors_mentioned, [], response);
    assert.equal(result.brand_cited_with_link, 0, response);
  }
});

test('real citation hosts remain linked evidence; visible prose gives mention evidence', () => {
  const brand = makeBrand({ domain: 'acme.com', name: 'Acme', competitors: ['rival.com'] });
  for (const [response, expectedMention] of [
    ['https://acme.com/docs', 0],
    ['https://docs.acme.com/guide', 0],
    ['[Acme](https://tracker.example/?target=elsewhere)', 1],
    ['Acme is useful. https://tracker.example/?target=rival.com', 1],
  ] as const) {
    const result = extractCitations(brand, response);
    assert.equal(result.brand_mentioned, expectedMention, response);
    assert.deepEqual(result.competitors_mentioned, [], response);
  }
  assert.equal(extractCitations(brand, 'https://docs.acme.com/guide').brand_cited_with_link, 1);
  assert.deepEqual(
    extractCitations(brand, 'https://shop.rival.com/docs').competitors_mentioned,
    [],
  );
  assert.deepEqual(
    extractCitations(brand, '[Rival](https://tracker.example/guide)').competitors_mentioned,
    ['rival.com'],
  );
});

test('URL schemes are case-insensitive for evidence and mention scoring', () => {
  const brand = makeBrand({ domain: 'acme.com', name: 'Acme', competitors: ['rival.com'] });
  for (const raw of [
    'HTTPS://tracker.example/?q=Acme',
    'HTTP://tracker.example/?target=rival.com',
    'Https://tracker.example/redirect/acme.com',
  ]) {
    const result = extractCitations(brand, raw);
    assert.equal(result.brand_mentioned, 0, raw);
    assert.deepEqual(result.competitors_mentioned, [], raw);
    assert.equal(result.brand_cited_with_link, 0, raw);
  }
  const linked = extractCitations(brand, 'HTTPS://ACME.COM/docs');
  assert.equal(linked.brand_mentioned, 0);
  assert.equal(linked.brand_cited_with_link, 1);
  assert.deepEqual(linked.cited_urls, ['acme.com']);
  const rival = extractCitations(brand, 'HtTp://SHOP.RIVAL.COM/guide');
  assert.deepEqual(rival.competitors_mentioned, []);
  assert.deepEqual(rival.cited_urls, ['shop.rival.com']);
});

test('visible HTML character references preserve brand and competitor mentions without creating links', () => {
  const brand = makeBrand({
    domain: 'vendor.example',
    name: 'Smith & Sons',
    aliases: [],
    exclude_terms: ['vendor'],
    competitors: ['notion.so'],
  });
  const visible = extractCitations(brand, 'Compare Smith &amp; Sons with N&#111;tion and Smith &#x26; Sons.');
  assert.equal(visible.brand_mentioned, 1);
  assert.deepEqual(visible.competitors_mentioned, ['notion.so']);
  assert.equal(visible.brand_cited_with_link, 0);

  const hidden = extractCitations(brand,
    '<span data-label="Smith &amp; Sons">Other provider</span> https:&#x2F;&#x2F;vendor.example');
  assert.equal(hidden.brand_mentioned, 0);
  assert.equal(hidden.brand_cited_with_link, 0);
  assert.deepEqual(hidden.cited_urls, []);

  // Decoding should happen once, not turn double-encoded markup into a brand mention.
  assert.equal(extractCitations(brand, 'Smith &amp;amp; Sons').brand_mentioned, 0);
});

test('hidden Markdown reference IDs do not count as brand or competitor mentions', () => {
  const brand = makeBrand({ domain: 'acme.com', name: 'Acme', competitors: ['rival.com'] });
  const response = [
    'See [an independent guide][Acme] and [another guide][Rival].',
    '',
    '[Acme]: https://neutral.example.org/guide',
    '[Rival]: https://neutral.example.org/other',
  ].join('\n');
  const evidence = extractCitations(brand, response);
  assert.equal(evidence.brand_mentioned, 0);
  assert.deepEqual(evidence.competitors_mentioned, []);
  assert.equal(evidence.brand_cited_with_link, 0);
  assert.deepEqual(evidence.cited_urls, ['neutral.example.org']);

  const visible = extractCitations(
    brand,
    '[Acme][guide] is compared with [Rival][] and [the rest][guide].\n\n' +
      '[guide]: https://neutral.example.org/guide\n[Rival]: https://neutral.example.org/other',
  );
  assert.equal(visible.brand_mentioned, 1);
  assert.deepEqual(visible.competitors_mentioned, ['rival.com']);
});

test('nested Markdown image labels and asset URLs are not answer citations or visible mentions', () => {
  const brand = makeBrand({ domain: 'acme.com', name: 'Acme', competitors: ['rival.com'] });
  for (const response of [
    '![A [Acme] logo](https://acme.com/logo.png)',
    '![The [Acme] and [Rival] logos](https://assets.example/logos.png)',
    '![A [Rival] diagram][graphic]\n\n[graphic]: https://rival.com/image.svg',
  ]) {
    const evidence = extractCitations(brand, response);
    assert.equal(evidence.brand_mentioned, 0, response);
    assert.equal(evidence.brand_cited_with_link, 0, response);
    assert.deepEqual(evidence.competitors_mentioned, [], response);
    assert.deepEqual(evidence.cited_urls, [], response);
  }

  const visible = extractCitations(
    brand,
    'Acme is compared with Rival. ![The [Acme] and [Rival] logos](https://assets.example/logos.png)',
  );
  assert.equal(visible.brand_mentioned, 1);
  assert.deepEqual(visible.competitors_mentioned, ['rival.com']);
  assert.deepEqual(visible.cited_urls, []);
});
