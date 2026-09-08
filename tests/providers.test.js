'use strict';
const test = require('node:test');
const assert = require('node:assert');

process.env.ORCAROUTER_API_KEY = 'test-orca-key';
process.env.ORCAROUTER_MODEL = 'orcarouter/free';

const { PROVIDERS, DEFAULT_ORDER } = require('../harness/providers');

test('OrcaRouter provider is configured as an OpenAI-compatible free endpoint', () => {
  assert.ok(PROVIDERS.orcarouter);
  assert.strictEqual(PROVIDERS.orcarouter.label, 'OrcaRouter Free');
  assert.strictEqual(PROVIDERS.orcarouter.url, 'https://api.orcarouter.ai/v1/chat/completions');
  assert.strictEqual(PROVIDERS.orcarouter.model, 'orcarouter/free');
  assert.strictEqual(PROVIDERS.orcarouter.key, 'test-orca-key');
});

test('OrcaRouter is part of the normal fallback chain', () => {
  const orcaIndex = DEFAULT_ORDER.indexOf('orcarouter');
  const openRouterIndex = DEFAULT_ORDER.indexOf('openrouter');
  const groqIndex = DEFAULT_ORDER.indexOf('groq');

  assert.ok(orcaIndex >= 0);
  assert.ok(openRouterIndex >= 0);
  assert.ok(groqIndex >= 0);
  assert.ok(openRouterIndex < orcaIndex);
  assert.ok(orcaIndex < groqIndex);
});
