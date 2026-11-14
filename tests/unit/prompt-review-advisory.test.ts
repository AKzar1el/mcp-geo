import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Brand, Db, Prompt } from '../../src/db/types.ts';
import { registerLocalManagementTools } from '../../src/core/tools.ts';

type PromptReview = {
  category_missing: boolean;
  category_change_pending: boolean;
  prompts_naming_brand: number;
  review_recommended: boolean;
  note: string;
};

async function listPrompts(category: string | null, texts: string[], categoryChangePending = false) {
  const brand = {
    id: 'acme', name: 'Acme', domain: 'acme.com', category,
    aliases: [], exclude_terms: [], category_prompt_review_pending: categoryChangePending,
  } as Brand;
  const prompts = texts.map((text, index) => ({
    id: `p${index}`, text, intent_stage: null, shape: null,
    created_at: Date.UTC(2026, 10, 11),
  })) as Prompt[];
  let handler: ((input: { brand_id: string }) => Promise<{
    structuredContent: { prompt_review: PromptReview; count: number };
  }>) | undefined;
  const server = {
    registerTool(name: string, _config: unknown, callback: unknown) {
      if (name === 'list_prompts') handler = callback as typeof handler;
      return {};
    },
  } as unknown as McpServer;
  const db = {
    getBrand: async () => brand,
    getActivePrompts: async () => prompts,
  } as unknown as Db;
  registerLocalManagementTools(server, { db, env: {} });
  assert.ok(handler);
  return (await handler({ brand_id: brand.id })).structuredContent;
}

test('list_prompts flags missing category and brand-anchored questions before paid scans', async () => {
  const result = await listPrompts(null, [
    'Why should I choose Acme over its competitors?',
    'What tools are best for managing projects?',
  ]);
  assert.equal(result.count, 2);
  assert.deepEqual({
    category_missing: result.prompt_review.category_missing,
    prompts_naming_brand: result.prompt_review.prompts_naming_brand,
    review_recommended: result.prompt_review.review_recommended,
  }, { category_missing: true, prompts_naming_brand: 1, review_recommended: true });
  assert.match(result.prompt_review.note, /review/i);
  assert.match(result.prompt_review.note, /provider/i);
});

test('list_prompts does not claim neutral category prompts are audit-validated', async () => {
  const result = await listPrompts('Project management', [
    'What software is best for scheduling client projects?',
    'Which project management platforms suit small teams?',
  ]);
  assert.equal(result.prompt_review.category_missing, false);
  assert.equal(result.prompt_review.prompts_naming_brand, 0);
  assert.equal(result.prompt_review.review_recommended, false);
  assert.match(result.prompt_review.note, /not.*validat/i);
});

test('list_prompts does not label longer unrelated words as brand mentions', async () => {
  const result = await listPrompts('Design', ['AcmeWare design app comparison']);
  assert.equal(result.prompt_review.prompts_naming_brand, 0);
});

test('list_prompts warns of persisted category changes even for neutral-looking old buyer questions', async () => {
  const result = await listPrompts('CRM software', ['Which project platform suits a remote team?'], true);
  assert.equal(result.prompt_review.category_missing, false);
  assert.equal(result.prompt_review.prompts_naming_brand, 0);
  assert.equal(result.prompt_review.category_change_pending, true);
  assert.equal(result.prompt_review.review_recommended, true);
  assert.match(result.prompt_review.note, /category changed/i);
  assert.match(result.prompt_review.note, /set_prompts/);
});
