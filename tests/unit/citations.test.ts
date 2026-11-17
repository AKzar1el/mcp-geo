// Unit tests for the citation extractor — the core of every score this
// server produces. Pure functions, no network, no D1.
//
// Run with:
//   npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCitations, hasBrandInEngineCitations, hostMatchesDomain } from '../../src/core/openai.ts';
import type { Brand } from '../../src/db/types.ts';

const acme: Brand = {
  id: 'acme',
  user_id: 'dev-user',
  domain: 'acme.com',
  name: 'Acme Project Tool',
  category: 'Project management software',
  competitors: ['asana.com', 'monday.com', 'notion.so'],
  aliases: [],
  exclude_terms: [],
  refresh_frequency: 'weekly',
  created_at: 0,
  updated_at: 0,
};

test('brand mention by name', () => {
  const r = extractCitations(acme, 'I recommend Acme Project Tool for small teams.');
  assert.equal(r.brand_mentioned, 1);
  assert.equal(r.brand_cited_with_link, 0);
});

test('brand mention by domain root', () => {
  const r = extractCitations(acme, 'Many teams use acme for sprint planning.');
  assert.equal(r.brand_mentioned, 1);
});

test('brand mention by full domain', () => {
  const r = extractCitations(acme, 'Check out acme.com for details.');
  assert.equal(r.brand_mentioned, 1);
});

test('no mention when brand root only appears inside another word', () => {
  const r = extractCitations(acme, 'Try Acmeshop or Macme for this use case.');
  assert.equal(r.brand_mentioned, 0);
});

test('markdown link to brand domain counts as linked citation', () => {
  const r = extractCitations(
    acme,
    'Top picks: [Acme](https://acme.com) and [Asana](https://asana.com).',
  );
  assert.equal(r.brand_mentioned, 1);
  assert.equal(r.brand_cited_with_link, 1);
  assert.ok(r.cited_urls.includes('acme.com'));
  assert.ok(r.cited_urls.includes('asana.com'));
});

test('Markdown link titles are hidden metadata, not cited URLs or visible recommendations', () => {
  for (const link of [
    '[report](https://neutral.example/report "Acme Project Tool and Asana at https://acme.com/hidden")',
    "[report](https://neutral.example/report 'Acme Project Tool and Asana at https://asana.com/hidden')",
    '[report](<https://neutral.example/report> "Acme Project Tool and Asana")',
    '[report](https://neutral.example/a(b) (Acme Project Tool and Asana))',
  ]) {
    const r = extractCitations(acme, `See this ${link} for independent evidence.`);
    assert.equal(r.brand_mentioned, 0, link);
    assert.equal(r.brand_cited_with_link, 0, link);
    assert.deepEqual(r.competitors_mentioned, [], link);
    assert.deepEqual(r.cited_urls, ['neutral.example'], link);
  }

  const relative = extractCitations(acme, '[internal](/about "Acme Project Tool at https://acme.com/hidden")');
  assert.equal(relative.brand_mentioned, 0);
  assert.equal(relative.brand_cited_with_link, 0);
  assert.deepEqual(relative.cited_urls, []);

  const visible = extractCitations(
    acme,
    '[Acme Project Tool](https://acme.com/report "Independent research") and Asana are discussed.',
  );
  assert.equal(visible.brand_mentioned, 1);
  assert.equal(visible.brand_cited_with_link, 1);
  assert.deepEqual(visible.competitors_mentioned, ['asana.com']);
  assert.deepEqual(visible.cited_urls, ['acme.com']);
});

test('unused Markdown reference definitions are not visible mentions or citations', () => {
  const r = extractCitations(
    acme,
    'Other products can help.\n\n[Acme Project Tool]: https://acme.com/claims\n[Asana]: https://asana.com',
  );
  assert.equal(r.brand_mentioned, 0);
  assert.equal(r.brand_cited_with_link, 0);
  assert.deepEqual(r.competitors_mentioned, []);
  assert.deepEqual(r.cited_urls, []);
});

test('used Markdown reference links retain their source citation without hidden mentions', () => {
  const r = extractCitations(
    acme,
    'The results are documented in [independent evidence][  Proof  Link ].\n\n[proof link]: <https://acme.com/research> "Full paper"',
  );
  assert.equal(r.brand_mentioned, 0);
  assert.equal(r.brand_cited_with_link, 1);
  assert.deepEqual(r.cited_urls, ['acme.com']);
});

test('reference-style Markdown image assets cannot count as visible answer evidence', () => {
  const r = extractCitations(
    acme,
    '![Acme Project Tool][logo]\n\n[logo]: https://acme.com/logo.svg',
  );
  assert.equal(r.brand_mentioned, 0);
  assert.equal(r.brand_cited_with_link, 0);
  assert.deepEqual(r.cited_urls, []);
});

test('shortcut Markdown references preserve visible labels and linked source evidence', () => {
  const r = extractCitations(
    acme,
    'Try [Acme Project Tool] for planning.\n\n[Acme Project Tool]: https://acme.com',
  );
  assert.equal(r.brand_mentioned, 1);
  assert.equal(r.brand_cited_with_link, 1);
  assert.deepEqual(r.cited_urls, ['acme.com']);
});

test('Markdown image assets are not source citations, but ordinary links remain evidence', () => {
  const imageOnly = extractCitations(
    acme,
    '![screenshot](https://acme.com/media/logo.svg) ![icon](https://asana.com/icon.png)',
  );
  assert.equal(imageOnly.brand_cited_with_link, 0);
  assert.deepEqual(imageOnly.cited_urls, []);
  for (const image of [
    '![screenshot](https://acme.com/assets/logo_(dark).svg)',
    '![screenshot](https://acme.com/assets/logo.svg "brand asset")',
  ]) {
    const result = extractCitations(acme, image);
    assert.equal(result.brand_cited_with_link, 0, image);
    assert.deepEqual(result.cited_urls, [], image);
  }

  const withSource = extractCitations(
    acme,
    '![screenshot](https://acme.com/media/logo.svg) [source](https://acme.com/research)',
  );
  assert.equal(withSource.brand_cited_with_link, 1);
  assert.deepEqual(withSource.cited_urls, ['acme.com']);
});

test('Markdown image alt labels do not become visible brand or competitor mentions', () => {
  for (const image of [
    '![Acme Project Tool](https://neutral.example/logo.svg) ![Asana](https://neutral.example/icon.png)',
    '![Acme Project Tool](https://neutral.example/logo_(dark).svg "Acme Project Tool logo")',
  ]) {
    const result = extractCitations(acme, image);
    assert.equal(result.brand_mentioned, 0, image);
    assert.deepEqual(result.competitors_mentioned, [], image);
    assert.deepEqual(result.cited_urls, [], image);
  }

  const visible = extractCitations(
    acme,
    '![Acme Project Tool](https://neutral.example/logo.svg) Compare [Asana](https://asana.com) with Acme Project Tool.',
  );
  assert.equal(visible.brand_mentioned, 1);
  assert.deepEqual(visible.competitors_mentioned, ['asana.com']);
  assert.deepEqual(visible.cited_urls, ['asana.com']);
});

test('relative and embedded Markdown image labels are not visible recommendation evidence', () => {
  for (const image of [
    '![Acme Project Tool](./images/brand.svg)',
    '![Acme Project Tool](assets/logo_(small).svg)',
    '![Asana](/assets/logo.png)',
    '![Asana](<./icons/asana.svg>)',
    '![Acme Project Tool](data:image/png;base64,AAAA)',
    '![Asana](../assets/logo.svg "Asana logo")',
  ]) {
    const result = extractCitations(acme, image);
    assert.equal(result.brand_mentioned, 0, image);
    assert.deepEqual(result.competitors_mentioned, [], image);
    assert.deepEqual(result.cited_urls, [], image);
  }

  const visible = extractCitations(
    acme,
    '![Acme Project Tool](./assets/logo.png) Compare [Asana](https://asana.com) with Acme Project Tool.',
  );
  assert.equal(visible.brand_mentioned, 1);
  assert.deepEqual(visible.competitors_mentioned, ['asana.com']);
  assert.deepEqual(visible.cited_urls, ['asana.com']);
});

test('HTML image assets do not count as source citations but surrounding anchors do', () => {
  for (const image of [
    '<img src="https://acme.com/media/logo.svg" alt="Logo">',
    "<IMG ALT='chart > preview' SRC='https://acme.com/charts/weekly.png' />",
    '<img src=https://asana.com/images/icon.png>',
  ]) {
    const result = extractCitations(acme, image);
    assert.equal(result.brand_cited_with_link, 0, image);
    assert.deepEqual(result.cited_urls, [], image);
  }
  const linked = extractCitations(
    acme,
    '<a href="https://acme.com/research"><img src="https://asana.com/chart.png" alt="chart"></a>',
  );
  assert.equal(linked.brand_cited_with_link, 1);
  assert.deepEqual(linked.cited_urls, ['acme.com']);
});

test('URLs in Markdown code examples are not evidence of a linked source', () => {
  const examples = [
    'Example response:\n```json\n{"source":"https://acme.com/research"}\n```',
    'Example terminal command: `curl https://acme.com/api`',
    'Example variable: ``https://acme.com/reference``',
    'Example configuration:\n~~~yaml\nurl: https://asana.com/sample\n~~~',
    'Unfinished example:\n```json\n{"source":"https://acme.com/research"}',
  ];
  for (const example of examples) {
    const result = extractCitations(acme, example);
    assert.equal(result.brand_cited_with_link, 0, example);
    assert.deepEqual(result.cited_urls, [], example);
  }

  const withRealLink = extractCitations(
    acme,
    'Sample: `https://asana.com/example`\nActual source: [research](https://acme.com/research)',
  );
  assert.equal(withRealLink.brand_cited_with_link, 1);
  assert.deepEqual(withRealLink.cited_urls, ['acme.com']);
});

test('indented Markdown code examples are not AI mention or citation evidence', () => {
  for (const sample of [
    '    Acme Project Tool vs Asana: https://acme.com/example',
    '\tAcme Project Tool vs Asana: https://acme.com/example',
    'Example output:\n\n    Acme Project Tool vs Asana\n    [report](https://acme.com/example)',
  ]) {
    const result = extractCitations(acme, sample);
    assert.equal(result.brand_mentioned, 0, sample);
    assert.equal(result.brand_cited_with_link, 0, sample);
    assert.deepEqual(result.competitors_mentioned, [], sample);
    assert.deepEqual(result.cited_urls, [], sample);
  }

  const visible = extractCitations(
    acme,
    'Example:\n\n    Acme Project Tool at https://acme.com/example\n\nVisible: Asana [study](https://neutral.example/report)',
  );
  assert.equal(visible.brand_mentioned, 0);
  assert.equal(visible.brand_cited_with_link, 0);
  assert.deepEqual(visible.competitors_mentioned, ['asana.com']);
  assert.deepEqual(visible.cited_urls, ['neutral.example']);

  // Four-space continuation without a blank line remains paragraph text.
  const paragraph = extractCitations(acme, 'Recommended:\n    Acme Project Tool at https://acme.com');
  assert.equal(paragraph.brand_mentioned, 1);
  assert.equal(paragraph.brand_cited_with_link, 1);

  const listContinuation = extractCitations(
    acme,
    '- The recommendation is:\n    Acme Project Tool at https://acme.com',
  );
  assert.equal(listContinuation.brand_mentioned, 1);
  assert.equal(listContinuation.brand_cited_with_link, 1);

  // A loose-list paragraph is still rendered, but code indented four extra
  // columns inside the same list must remain invisible to evidence scoring.
  const looseList = extractCitations(acme, '- Recommendation:\n\n    Acme Project Tool at https://acme.com');
  assert.equal(looseList.brand_mentioned, 1);
  assert.equal(looseList.brand_cited_with_link, 1);
  const nestedCode = extractCitations(acme, '- Example:\n\n      Acme Project Tool at https://acme.com');
  assert.equal(nestedCode.brand_mentioned, 0);
  assert.equal(nestedCode.brand_cited_with_link, 0);
});

test('thematic breaks and setext headings end paragraphs before indented code evidence', () => {
  for (const markdown of [
    'Context before a rule\n***\n    Acme Project Tool beats Asana: https://acme.com/example',
    'Context before a rule\n_ _ _\n    Acme Project Tool beats Asana: https://acme.com/example',
    'Heading text\n---\n    Acme Project Tool beats Asana: https://acme.com/example',
  ]) {
    const result = extractCitations(acme, markdown);
    assert.equal(result.brand_mentioned, 0, markdown);
    assert.equal(result.brand_cited_with_link, 0, markdown);
    assert.deepEqual(result.competitors_mentioned, [], markdown);
    assert.deepEqual(result.cited_urls, [], markdown);
  }

  const realEvidence = extractCitations(
    acme,
    'Intro\n***\n    Acme Project Tool: https://acme.com/hidden\nAsana is recommended. [proof](https://neutral.example/visible)',
  );
  assert.equal(realEvidence.brand_mentioned, 0);
  assert.deepEqual(realEvidence.competitors_mentioned, ['asana.com']);
  assert.deepEqual(realEvidence.cited_urls, ['neutral.example']);
});

test('fenced Markdown code inside blockquotes is not visible recommendation or citation evidence', () => {
  for (const example of [
    '> Sample output:\n> ```markdown\n> Acme Project Tool beats Asana\n> [source](https://acme.com/example)\n> ```',
    '>> ~~~text\n>> Acme Project Tool and Asana at https://acme.com/example\n>> ~~~',
  ]) {
    const result = extractCitations(acme, example);
    assert.equal(result.brand_mentioned, 0, example);
    assert.equal(result.brand_cited_with_link, 0, example);
    assert.deepEqual(result.competitors_mentioned, [], example);
    assert.deepEqual(result.cited_urls, [], example);
  }

  const realEvidence = extractCitations(
    acme,
    '> ```\n> Acme Project Tool and https://acme.com/hidden\n> ```\n' +
      '> Asana is genuinely recommended. [report](https://neutral.example/report)\n\n' +
      'Acme Project Tool is also recommended. [source](https://acme.com/real)',
  );
  assert.equal(realEvidence.brand_mentioned, 1);
  assert.equal(realEvidence.brand_cited_with_link, 1);
  assert.deepEqual(realEvidence.competitors_mentioned, ['asana.com']);
  assert.deepEqual(realEvidence.cited_urls, ['neutral.example', 'acme.com']);

  const afterUnclosedQuote = extractCitations(
    acme,
    '> ```\n> Acme Project Tool and https://acme.com/hidden\n\n' +
      'Asana is recommended. [report](https://neutral.example/visible)',
  );
  assert.equal(afterUnclosedQuote.brand_mentioned, 0);
  assert.equal(afterUnclosedQuote.brand_cited_with_link, 0);
  assert.deepEqual(afterUnclosedQuote.competitors_mentioned, ['asana.com']);
  assert.deepEqual(afterUnclosedQuote.cited_urls, ['neutral.example']);

  // Quoted-looking fence delimiters inside an ordinary code fence are literal
  // code and must never close the surrounding fence early.
  const literalQuoteInsideCode = extractCitations(
    acme,
    '```\n> ```\nAcme Project Tool at https://acme.com/hidden\n```\nAsana is visible.',
  );
  assert.equal(literalQuoteInsideCode.brand_mentioned, 0);
  assert.equal(literalQuoteInsideCode.brand_cited_with_link, 0);
  assert.deepEqual(literalQuoteInsideCode.competitors_mentioned, ['asana.com']);
  assert.deepEqual(literalQuoteInsideCode.cited_urls, []);
});

test('HTML code examples and hidden comments are not linked source evidence', () => {
  const examples = [
    '<pre>curl https://acme.com/v1/search</pre>',
    '<code>https://acme.com/docs/example</code>',
    '<PRE class="language-html"><code>&lt;a href="https://acme.com/demo"&gt;</code></PRE>',
    '<!-- internal example: https://acme.com/not-a-source -->',
    '<!-- unfinished comment: https://acme.com/not-a-source',
    '<pre class="example">https://acme.com/unterminated',
  ];
  for (const example of examples) {
    const result = extractCitations(acme, example);
    assert.equal(result.brand_cited_with_link, 0, example);
    assert.deepEqual(result.cited_urls, [], example);
  }

  const withRealLink = extractCitations(
    acme,
    '<code>https://asana.com/sample</code> <a href="https://acme.com/research">Source</a>',
  );
  assert.equal(withRealLink.brand_cited_with_link, 1);
  assert.deepEqual(withRealLink.cited_urls, ['acme.com']);
});

test('HTML head metadata is not answer evidence while visible body and header remain', () => {
  const result = extractCitations(
    acme,
    '<head><title>Acme Project Tool at https://acme.com/study</title>' +
      '<meta name="description" content="Asana"></head>' +
      '<body><header>Asana is recommended.</header>' +
      '<a href="https://neutral.example/report">Read the report</a></body>',
  );
  assert.equal(result.brand_mentioned, 0);
  assert.equal(result.brand_cited_with_link, 0);
  assert.deepEqual(result.competitors_mentioned, ['asana.com']);
  assert.deepEqual(result.cited_urls, ['neutral.example']);

  const unclosedHead = extractCitations(
    acme,
    '<head><title>Acme Project Tool</title>https://acme.com/study',
  );
  assert.equal(unclosedHead.brand_mentioned, 0);
  assert.equal(unclosedHead.brand_cited_with_link, 0);
  assert.deepEqual(unclosedHead.cited_urls, []);
});

test('inert HTML template content cannot manufacture brand mentions or cited sources', () => {
  for (const hidden of [
    '<template><p>Acme Project Tool beats Asana</p><a href="https://acme.com/research">source</a></template>',
    '<TEMPLATE id="cached-answer"><a href="https://acme.com/research">Acme Project Tool</a>',
  ]) {
    const result = extractCitations(acme, hidden);
    assert.equal(result.brand_mentioned, 0, hidden);
    assert.equal(result.brand_cited_with_link, 0, hidden);
    assert.deepEqual(result.competitors_mentioned, [], hidden);
    assert.deepEqual(result.cited_urls, [], hidden);
  }

  const withVisibleSource = extractCitations(
    acme,
    '<template><a href="https://acme.com/hidden">Acme Project Tool</a></template>' +
      '<p>Asana is recommended.</p><a href="https://neutral.example/report">Report</a>',
  );
  assert.equal(withVisibleSource.brand_mentioned, 0);
  assert.equal(withVisibleSource.brand_cited_with_link, 0);
  assert.deepEqual(withVisibleSource.competitors_mentioned, ['asana.com']);
  assert.deepEqual(withVisibleSource.cited_urls, ['neutral.example']);
});

test('HTML script and style resources are not cited sources but visible anchors remain', () => {
  const nonSources = [
    '<script src="https://acme.com/analytics.js"></script>',
    '<script>fetch("https://asana.com/api")</script>',
    '<style>@import url("https://acme.com/theme.css");</style>',
    '<STYLE>body { background: url(https://asana.com/pattern.svg) }</STYLE>',
    '<script type="application/ld+json">{"url":"https://acme.com"}</script>',
    '<script>const endpoint = "https://acme.com/unclosed"',
  ];
  for (const answer of nonSources) {
    const result = extractCitations(acme, answer);
    assert.equal(result.brand_cited_with_link, 0, answer);
    assert.deepEqual(result.cited_urls, [], answer);
  }

  const visibleSource = extractCitations(
    acme,
    '<script src="https://asana.com/asset.js"></script><a href="https://acme.com/research">Evidence</a>',
  );
  assert.equal(visibleSource.brand_cited_with_link, 1);
  assert.deepEqual(visibleSource.cited_urls, ['acme.com']);
});

test('hidden markup and example code do not count as brand or competitor answer mentions', () => {
  const nonProse = [
    '<!-- Acme Project Tool and Asana should not count as recommendations -->',
    '<script>const choice = "Acme Project Tool"; const rival = "Asana";</script>',
    '<pre>Acme Project Tool versus Asana</pre>',
    'Example:\n```json\n{"choice":"Acme Project Tool","rival":"Asana"}\n```',
    'Use `Acme Project Tool` and `Asana` as sample identifiers.',
  ];
  for (const answer of nonProse) {
    const result = extractCitations(acme, answer);
    assert.equal(result.brand_mentioned, 0, answer);
    assert.deepEqual(result.competitors_mentioned, [], answer);
    assert.equal(result.brand_cited_with_link, 0, answer);
  }

  const visibleBrand = extractCitations(
    acme,
    '<!-- Asana --> <script>const rival = "Asana";</script> Acme Project Tool is useful.',
  );
  assert.equal(visibleBrand.brand_mentioned, 1);
  assert.deepEqual(visibleBrand.competitors_mentioned, []);

  const visibleCompetitor = extractCitations(acme, '<code>Acme Project Tool</code> Asana is a real competitor.');
  assert.equal(visibleCompetitor.brand_mentioned, 0);
  assert.deepEqual(visibleCompetitor.competitors_mentioned, ['asana.com']);
});

test('HTML attributes do not count as visible brand or competitor answer mentions', () => {
  const attributesOnly = [
    '<img src="https://neutral.example/chart.png" alt="Acme Project Tool versus Asana">',
    '<meta name="description" content="Acme Project Tool and Asana">',
    '<a href="https://neutral.example/source" title="Acme Project Tool and Asana">Read source</a>',
    '<span data-tooltip="Acme Project Tool versus Asana">Read analysis</span>',
    '<img alt="Asana > Acme Project Tool" src="/assets/compare.svg">',
  ];
  for (const answer of attributesOnly) {
    const result = extractCitations(acme, answer);
    assert.equal(result.brand_mentioned, 0, answer);
    assert.deepEqual(result.competitors_mentioned, [], answer);
  }

  const visible = extractCitations(
    acme,
    '<a href="https://neutral.example/source" title="Asana">Acme Project Tool is recommended.</a>',
  );
  assert.equal(visible.brand_mentioned, 1);
  assert.deepEqual(visible.competitors_mentioned, []);
  assert.deepEqual(visible.cited_urls, ['neutral.example']);
});

test('HTML metadata and data attributes are not linked citations; anchor hrefs are', () => {
  for (const hidden of [
    '<meta property="og:url" content="https://acme.com/marketing">',
    '<link rel="stylesheet" href="https://acme.com/styles.css">',
    '<span data-source="https://acme.com/internal">Read analysis</span>',
    '<div title="https://acme.com/not-cited">No source link</div>',
    '<span data-html="<a href=\'https://acme.com/not-a-link\'>">Not a visible link</span>',
  ]) {
    const result = extractCitations(acme, hidden);
    assert.equal(result.brand_cited_with_link, 0, hidden);
    assert.deepEqual(result.cited_urls, [], hidden);
  }

  const linked = extractCitations(
    acme,
    '<a title="https://asana.com/not-a-source" href="https://acme.com/research">Evidence</a> ' +
      '<span data-source="https://asana.com/internal">See also https://neutral.example/report</span>',
  );
  assert.equal(linked.brand_cited_with_link, 1);
  assert.deepEqual(linked.cited_urls, ['acme.com', 'neutral.example']);

  const quoted = extractCitations(
    acme,
    '<a title=\'view href="https://asana.com/fake"\' HREF = \'https://acme.com/study\'>Study</a>',
  );
  assert.deepEqual(quoted.cited_urls, ['acme.com']);

  const autolink = extractCitations(acme, 'Sources: <https://acme.com/guide> and <https://asana.com/help>.');
  assert.equal(autolink.brand_cited_with_link, 1);
  assert.deepEqual(autolink.cited_urls, ['acme.com', 'asana.com']);
});

test('subdomain link without brand prose counts only as linked citation', () => {
  const r = extractCitations(acme, 'See https://docs.acme.com/setup for the guide.');
  assert.equal(r.brand_mentioned, 0);
  assert.equal(r.brand_cited_with_link, 1);
});

test('a source-only brand URL is not a brand mention in answer prose', () => {
  for (const answer of [
    'Reference: https://docs.acme.com/setup',
    'Reference: [source](https://acme.com/research)',
  ]) {
    const result = extractCitations(acme, answer);
    assert.equal(result.brand_mentioned, 0, answer);
    assert.equal(result.brand_cited_with_link, 1, answer);
  }
  const named = extractCitations(acme, 'Reference: [Acme](https://acme.com/research)');
  assert.equal(named.brand_mentioned, 1);
  assert.equal(named.brand_cited_with_link, 1);
});

test('a source-only competitor URL is not a competitor mention in answer prose', () => {
  const linked = extractCitations(acme, 'Reference: https://asana.com/pricing');
  assert.deepEqual(linked.competitors_mentioned, []);
  assert.ok(linked.cited_urls.includes('asana.com'));
  const named = extractCitations(acme, 'Reference: [Asana](https://asana.com/pricing)');
  assert.deepEqual(named.competitors_mentioned, ['asana.com']);
});

test('parenthesized URL path fragments are not answer-prose brand or competitor mentions', () => {
  const r = extractCitations(
    acme,
    'Sources: https://neutral.example/reviews/(other)Acme https://neutral.example/notes/(other)Asana',
  );
  assert.equal(r.brand_mentioned, 0);
  assert.deepEqual(r.competitors_mentioned, []);
  assert.equal(r.brand_cited_with_link, 0);
  assert.ok(r.cited_urls.includes('neutral.example'));
  const visibleAfterLink = extractCitations(
    acme,
    '[source](https://neutral.example)Acme Project Tool is recommended.',
  );
  assert.equal(visibleAfterLink.brand_mentioned, 1);
});

test('www link counts as linked citation', () => {
  const r = extractCitations(acme, 'Acme lives at https://www.acme.com/.');
  assert.equal(r.brand_cited_with_link, 1);
});

test('lookalike domain does NOT count as brand mention or linked citation', () => {
  const r = extractCitations(
    acme,
    'You might also like https://notacme.com which is unrelated.',
  );
  assert.equal(r.brand_mentioned, 0);
  assert.equal(r.brand_cited_with_link, 0);
});

test('lookalike and superdomain text do NOT count as competitor mentions', () => {
  const brandWithAcmeCompetitor = { ...acme, competitors: ['acme.com'] };
  const r = extractCitations(
    brandWithAcmeCompetitor,
    'Unrelated sites include https://notacme.com and acme.com.evil.io.',
  );
  assert.deepEqual(r.competitors_mentioned, []);
});

test('competitors detected with word boundaries', () => {
  const r = extractCitations(
    acme,
    'Asana and Monday.com are popular. Notion fans disagree. Asanapro is unrelated.',
  );
  assert.deepEqual(
    [...r.competitors_mentioned].sort(),
    ['asana.com', 'monday.com', 'notion.so'],
  );
});

test('plain competitor names are recognized for common multi-label country suffixes', () => {
  const regional = {
    ...acme,
    competitors: ['orbit.co.id', 'vireo.com.ph', 'kanji.com.my'],
  };
  const result = extractCitations(
    regional,
    'Orbit, Vireo and Kanji are popular options. Orbiter and Vireolabs are unrelated.',
  );
  assert.deepEqual(result.competitors_mentioned, regional.competitors);
});

test('multi-label country suffixes do not match unrelated longer names', () => {
  const regional = { ...acme, competitors: ['orbit.co.id', 'vireo.com.ph'] };
  const result = extractCitations(regional, 'Orbiter and Vireolabs are not those brands.');
  assert.deepEqual(result.competitors_mentioned, []);
});

test('competitor not detected when absent', () => {
  const r = extractCitations(acme, 'Acme is the only tool worth using.');
  assert.deepEqual(r.competitors_mentioned, []);
});

test('cited hosts are deduped by hostname', () => {
  const r = extractCitations(
    acme,
    'Links: https://asana.com/pricing and https://asana.com/features and [Asana](https://www.asana.com).',
  );
  assert.deepEqual(r.cited_urls, ['asana.com']);
});

test('hostMatchesDomain: exact, subdomain, lookalike, unrelated', () => {
  assert.equal(hostMatchesDomain('acme.com', 'acme.com'), true);
  assert.equal(hostMatchesDomain('docs.acme.com', 'acme.com'), true);
  assert.equal(hostMatchesDomain('notacme.com', 'acme.com'), false);
  assert.equal(hostMatchesDomain('acme.com.evil.io', 'acme.com'), false);
  assert.equal(hostMatchesDomain('asana.com', 'acme.com'), false);
  // domain stored with protocol/www noise still matches
  assert.equal(hostMatchesDomain('acme.com', 'https://www.acme.com'), true);
});

test('citation hosts accept one DNS root dot but reject repeated dots and lookalikes', () => {
  assert.equal(hostMatchesDomain('docs.acme.com.', 'acme.com'), true);
  assert.equal(hostMatchesDomain('docs.acme.com.', 'acme.com.'), true);
  assert.equal(hostMatchesDomain('docs.acme.com..', 'acme.com'), false);
  assert.equal(hostMatchesDomain('docs.acme.com.', 'acme.com..'), false);
  assert.equal(hostMatchesDomain('acme.com.evil.example.', 'acme.com'), false);

  const rootDotUrl = 'https://www.acme.com./source';
  assert.equal(hasBrandInEngineCitations('acme.com', [rootDotUrl]), true);
  for (const invalid of [
    'https://acme.com../source',
    'https://docs.acme.com../source',
    'https://acme.com..,',
    'https://acme.com.evil.example./source',
  ]) {
    assert.equal(hasBrandInEngineCitations('acme.com', [invalid]), false, invalid);
  }
  assert.equal(extractCitations(acme, 'See https://acme.com..').brand_cited_with_link, 0);
  assert.equal(extractCitations(acme, 'See https://acme.com.').brand_cited_with_link, 1);
});

test('answer-text citation sources exclude localhost and IP literals', () => {
  const result = extractCitations(
    acme,
    'Sources: https://localhost/internal https://127.0.0.1/private ' +
      'https://[::1]/debug https://acme.com../invalid ' +
      'https://docs.acme.com./guide https://example.org/report',
  );
  assert.deepEqual(result.cited_urls, ['docs.acme.com', 'example.org']);
  assert.equal(result.brand_cited_with_link, 1);
});

test('encoded root dots cannot turn repeated-dot citation hosts into brand evidence', () => {
  // URL.hostname decodes %2e in host labels; validate the decoded root-dot count.
  for (const url of [
    'https://docs.acme.com%2e%2e/source',
    'https://docs.acme.com%2E%2E/source',
    'https://docs.acme.com.../source',
  ]) {
    assert.equal(hasBrandInEngineCitations('acme.com', [url]), false, url);
  }
  assert.equal(
    hasBrandInEngineCitations('acme.com', ['https://docs.acme.com%2e/source']),
    true,
  );
});


test('sentence-final plain brand URL counts as one normalized linked citation', () => {
  const r = extractCitations(acme, 'Useful reference: https://acme.com.');
  assert.equal(r.brand_mentioned, 0);
  assert.equal(r.brand_cited_with_link, 1);
  assert.deepEqual(r.cited_urls, ['acme.com']);
});

test('sentence-final subdomain citation remains distinct from lookalikes', () => {
  const r = extractCitations(acme, 'See https://docs.acme.com. Avoid https://acme.com.evil.io.');
  assert.equal(r.brand_mentioned, 0);
  assert.equal(r.brand_cited_with_link, 1);
  assert.deepEqual(r.cited_urls, ['docs.acme.com', 'acme.com.evil.io']);
});

test('sentence-final lookalike URL is not a brand mention or citation', () => {
  const r = extractCitations(acme, 'See https://acme.com.evil.io.');
  assert.equal(r.brand_mentioned, 0);
  assert.equal(r.brand_cited_with_link, 0);
  assert.deepEqual(r.cited_urls, ['acme.com.evil.io']);
});

test('brand link beyond 20 distinct cited hosts still counts', () => {
  const otherLinks = Array.from(
    { length: 20 },
    (_, i) => `https://other${i}.example/article`,
  ).join(' ');
  const response = `Acme Project Tool ${otherLinks} https://docs.acme.com/reference`;
  const r = extractCitations(acme, response);
  assert.equal(r.brand_mentioned, 1);
  assert.equal(r.brand_cited_with_link, 1);
  assert.equal(r.cited_urls.length, 20);
  assert.equal(r.cited_urls.includes('docs.acme.com'), false);
});

test('late lookalike host does not count as brand citation', () => {
  const otherLinks = Array.from(
    { length: 20 },
    (_, i) => `https://other${i}.example/article`,
  ).join(' ');
  const r = extractCitations(acme, `${otherLinks} https://acme.com.evil.io/article`);
  assert.equal(r.brand_cited_with_link, 0);
  assert.equal(r.cited_urls.length, 20);
});

test('native citation beyond the display evidence cap still counts the brand', () => {
  const textualHosts = Array.from({ length: 20 }, (_, i) => 'text' + i + '.example');
  const nativeLinks = [
    ...Array.from({ length: 10 }, (_, i) => 'https://native' + i + '.example/path'),
    'https://www.acme.com/late-brand-reference',
  ];
  const boundedEvidence = [...textualHosts, ...nativeLinks.map((link) => new URL(link).hostname)].slice(0, 30);
  assert.equal(boundedEvidence.length, 30);
  assert.equal(boundedEvidence.some((host) => hostMatchesDomain(host, acme.domain)), false);
  assert.equal(hasBrandInEngineCitations(acme.domain, nativeLinks), true);
});

test('native citation lookalikes and redirect text do not count as brand links', () => {
  const misleading = [
    'https://notacme.com/page',
    'https://acme.com.example.org/page',
    'https://unrelated.example/?redirect=https://acme.com',
  ];
  assert.equal(hasBrandInEngineCitations(acme.domain, misleading), false);
  assert.equal(hasBrandInEngineCitations(acme.domain, ['https://docs.acme.com/source']), true);
});

test('native citation evidence requires an actual HTTP(S) link to the brand', () => {
  const unlinked = [
    'acme.com',
    'docs.acme.com',
    'ftp://acme.com/report',
    'file://acme.com/report',
    'https://unrelated.example/?to=https://acme.com',
  ];
  for (const citation of unlinked) {
    assert.equal(hasBrandInEngineCitations(acme.domain, [citation]), false, citation);
  }
  assert.equal(hasBrandInEngineCitations(acme.domain, ['HTTP://ACME.COM/guide']), true);
  assert.equal(hasBrandInEngineCitations(acme.domain, ['https://docs.acme.com/guide']), true);
});

test('credential-bearing URLs in model answer text cannot establish a brand citation', () => {
  const result = extractCitations(acme, 'https://reader:secret@acme.com/private');
  assert.equal(result.brand_cited_with_link, 0);
  assert.equal(result.brand_mentioned, 0);
  assert.deepEqual(result.cited_urls, []);
});

test('credential-bearing native provider URLs cannot establish a brand citation', () => {
  assert.equal(
    hasBrandInEngineCitations(acme.domain, ['https://reader:secret@acme.com/private']),
    false,
  );
  assert.equal(hasBrandInEngineCitations(acme.domain, ['https://docs.acme.com/source']), true);
});
