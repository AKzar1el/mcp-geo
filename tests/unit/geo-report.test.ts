import assert from 'node:assert/strict';
import test from 'node:test';
import type { Brand, PromptResponse } from '../../src/db/types.ts';
import { buildGeoReport, CHECK_RULES, rankActions, summariseVisibility } from '../../src/core/geo-report.ts';
import { auditSite } from '../../src/core/site-audit.ts';

const brand: Brand = {
  id: 'shop', user_id: 'u', domain: 'shop.pl', name: 'Kolorowy Sklep', category: 'książki dla dzieci',
  competitors: ['rival.pl'], aliases: [], exclude_terms: [], refresh_frequency: 'weekly',
  market: 'pl-PL', google_domain: 'google.pl', created_at: 0, updated_at: 0,
};

let seq = 0;
const row = (engine: string, prompt_id: string, prompt_text: string, mentioned: number, competitors: string[] = [], captured_at = 1_700_000_000_000): PromptResponse => ({
  id: `r${seq++}`, run_id: `run-${engine}`, prompt_id, prompt_text, engine, raw_response: '', brand_mentioned: mentioned,
  brand_cited_with_link: 0, cited_urls: [], competitors_mentioned: competitors, engine_citations: [], status: 'ok',
  error_message: null, captured_at,
});

async function audit() {
  const page = (title: string, extra = '') => `<html><head><title>${title}</title>${extra}</head><body><h1>${title}</h1></body></html>`;
  const site: Record<string, string> = {
    'https://shop.pl/robots.txt': 'User-agent: GPTBot\nDisallow: /\n\nSitemap: https://shop.pl/sm',
    'https://shop.pl/sm': '<urlset><url><loc>https://shop.pl/pl/p/a/1</loc></url></urlset>',
    'https://shop.pl/': page('Strona główna sklepu'),
    'https://shop.pl/pl/p/a/1': page('Książka pierwsza', '<meta name="description" content="Opis książki dla dzieci, który ma ponad pięćdziesiąt znaków.">'),
  };
  return auditSite((async (u: string) => (site[u] ? new Response(site[u]) : new Response('', { status: 404 }))) as typeof fetch, 'shop.pl', 5);
}

test('every scored AEO check has a rule; llms.txt has none (0 points)', async () => {
  const r = await audit();
  for (const c of r.checks) assert.equal(c.id in CHECK_RULES, c.points > 0, c.id);
});

test('site checks list failing pages', async () => {
  const r = await audit();
  const meta = r.checks.find((c) => c.id === 'meta-description')!;
  assert.deepEqual(meta.failingUrls, ['https://shop.pl/']);
  assert.deepEqual(r.checks.find((c) => c.id === 'ai-bot-access')!.failingUrls, ['https://shop.pl/robots.txt']);
  assert.deepEqual(r.checks.find((c) => c.id === 'title')!.failingUrls, []);
});

test('visibility: unbranded rate per engine, branded prompts left out, latest row per prompt wins', () => {
  const v = summariseVisibility({ ...brand, aliases: ['Kolorowy'] }, [
    { run_id: 'run-chatgpt', started_at: 1, responses: [
      row('chatgpt', 'p1', 'najlepsze książki o emocjach', 0, ['rival.pl'], 1),
      row('chatgpt', 'p1', 'najlepsze książki o emocjach', 1, [], 2),
      row('chatgpt', 'p2', 'książki dla 5-latka', 0, ['rival.pl']),
      row('chatgpt', 'p3', 'czy Kolorowy Sklep jest dobry', 1),
      row('chatgpt', 'p4', 'Kolorowy czy Rival – co wybrać?', 1),
    ] },
    { run_id: 'run-claude', started_at: 1, responses: [row('claude', 'p2', 'książki dla 5-latka', 0)] },
  ]);
  assert.equal(v.visibility.branded_prompts_excluded, 2, 'full name and alias');
  assert.deepEqual(v.visibility.per_engine.map((e) => [e.engine, e.mentioned, e.answers]), [['chatgpt', 1, 2], ['claude', 0, 1]]);
  assert.equal(v.visibility.rate, 0.333);
  assert.equal(v.visibility.runs, 2);
  assert.deepEqual(v.absent, ['książki dla 5-latka']);
  assert.deepEqual(v.losing, [{ prompt: 'książki dla 5-latka', competitors: ['rival.pl'] }]);
});

test('visibility: runs started before an identity change are skipped', () => {
  const v = summariseVisibility({ ...brand, identity_changed_at: 10 }, [
    { run_id: 'old', started_at: 5, responses: [row('claude', 'p1', 'x', 1)] },
  ]);
  assert.equal(v.visibility.rate, null);
  assert.equal(v.visibility.window, null);
});

test('report: jev-seo shape, GEO-### ranked by jev-seo rules, no overall score', async () => {
  const vis = summariseVisibility(brand, [{ run_id: 'run-chatgpt', started_at: 1, responses: [
    row('chatgpt', 'p1', 'książki o emocjach', 0, ['rival.pl']),
    row('chatgpt', 'p2', 'książki dla 5-latka', 0),
  ] }]);
  const r = buildGeoReport(brand, await audit(), vis, '0.0.0');
  assert.equal(r.schema_version, '1.0');
  assert.equal(r.tool.name, 'mlw-geo');
  assert.equal(r.scores.overall, null);
  assert.equal(r.scores.categories.ai_visibility, 0);
  assert.match(r.scores.notes.ai_visibility, /0\/2, .*n = 1 runs.*market pl-PL/);
  const [first] = r.actions;
  assert.deepEqual([first.action_id, first.id, first.priority, first.impact], ['GEO-001', 'ai-bot-access', 'P1', 100]);
  assert.deepEqual(r.actions.map((a) => a.action_id), r.actions.map((_, i) => `GEO-${String(i + 1).padStart(3, '0')}`));
  const low = r.actions.find((a) => a.id === 'ai_visibility_low')!;
  assert.equal(low.to_verify, true, 'under 20 answers');
  assert.deepEqual(low.prompts, ['książki dla 5-latka', 'książki o emocjach']);
  assert.equal(r.actions.find((a) => a.id === 'competitors_preferred')!.count, 1);
  assert.ok(!r.actions.some((a) => a.id === 'llms-txt'));
  for (const a of r.actions) assert.equal(a.status, 'to_do');
});

test('report: no scan in market means no visibility actions and a null score with the reason', async () => {
  const r = buildGeoReport(brand, await audit(), summariseVisibility(brand, []), '0.0.0');
  assert.equal(r.scores.categories.ai_visibility, null);
  assert.match(r.scores.notes.ai_visibility, /Not assessed/);
  assert.ok(r.actions.every((a) => a.origin === 'aeo'));
});

test('rankActions: a check passing site-wide is one severity lower than one failing it', () => {
  const base = { origin: 'aeo' as const, category: 'x', effort: 1, title: 't', fix: 'f', source: 's', count: 1, evidence: 'e', heuristic: false, to_verify: false, urls: [] };
  const [a, b] = rankActions([{ ...base, id: 'a', severity: 'high', reach: 1 }, { ...base, id: 'b', severity: 'low', reach: 0 }]);
  assert.deepEqual([a.priority, a.impact, a.quick_win], ['P1', 100, true]);
  assert.deepEqual([b.priority, b.impact], ['P3', 10]);
});
