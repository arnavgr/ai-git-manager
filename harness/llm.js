'use strict';

const { RateLimitError, ProviderError, isRateLimitText } = require('./providers');

async function streamChatCompletion(provider, messages, tools, onFlush) {
  let streamBuffer = '';
  let lastFlushedLen = -1;
  const flushTimer = (typeof onFlush === 'function') ? setInterval(() => {
    if (streamBuffer.length > 0 && streamBuffer.length !== lastFlushedLen) {
      lastFlushedLen = streamBuffer.length;
      try { onFlush(streamBuffer); } catch {}
    }
  }, 2500) : null;

  const bodyObj = {
    model: provider.model,
    messages,
    tools,
    stream: true,
    ...(provider.extraBody || {})
  };
  if (provider.maxTokens) bodyObj.max_tokens = provider.maxTokens;

  let res;
  try {
    res = await fetch(provider.url, {
      method: 'POST',
      signal: AbortSignal.timeout(600000),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.key}`,
        ...(provider.extraHeaders || {})
      },
      body: JSON.stringify(bodyObj)
    });
  } catch (netErr) {
    if (flushTimer) clearInterval(flushTimer);
    throw new ProviderError(`Network error reaching ${provider.label}: ${netErr.message}`);
  }

  if (res.status === 429) {
    if (flushTimer) clearInterval(flushTimer);
    throw new RateLimitError(`HTTP 429 (rate limit) from ${provider.label}`);
  }
  if (!res.ok) {
    let errText = '';
    try { errText = await res.text(); } catch {}
    if (flushTimer) clearInterval(flushTimer);
    if (isRateLimitText(errText) || isRateLimitText(String(res.status))) {
      throw new RateLimitError(`Quota/rate-limit error from ${provider.label} (HTTP ${res.status})`);
    }
    throw new ProviderError(`HTTP ${res.status} from ${provider.label}: ${String(errText).slice(0, 400)}`);
  }

  let contentAcc = '';
  let reasoningAcc = '';
  const toolCallsAcc = {};
  let finishReason = null;

  function handleLine(rawLine) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let json;
    try { json = JSON.parse(payload); } catch { return; }
    const choice = (json.choices && json.choices[0]) || null;
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};

    const reasoningChunk = delta.reasoning || delta.reasoning_content;
    if (typeof reasoningChunk === 'string' && reasoningChunk.length) {
      reasoningAcc += reasoningChunk;
      streamBuffer += reasoningChunk;
    }

    if (typeof delta.content === 'string' && delta.content.length) {
      contentAcc += delta.content;
      streamBuffer += delta.content;
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = (tc && tc.index !== undefined && tc.index !== null) ? tc.index : 0;
        if (!toolCallsAcc[idx]) toolCallsAcc[idx] = { id: '', name: '', arguments: '' };
        if (tc.id) toolCallsAcc[idx].id = tc.id;
        if (tc.function && tc.function.name) toolCallsAcc[idx].name += tc.function.name;
        if (tc.function && typeof tc.function.arguments === 'string') {
          toolCallsAcc[idx].arguments += tc.function.arguments;
        }
      }
    }
  }

  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf8');
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const ln of lines) handleLine(ln);
    }
    buffer += decoder.decode();
    if (buffer.trim()) for (const ln of buffer.split('\n')) handleLine(ln);
  } catch (streamErr) {
    if (flushTimer) clearInterval(flushTimer);
    if (isRateLimitText(streamErr && streamErr.message)) {
      throw new RateLimitError(`Mid-stream rate limit from ${provider.label}: ${streamErr.message}`);
    }
    throw new ProviderError(`Mid-stream failure from ${provider.label}: ${streamErr && streamErr.message}`);
  }

  if (flushTimer) clearInterval(flushTimer);

  const toolCallsList = Object.keys(toolCallsAcc)
    .map(k => parseInt(k, 10)).sort((a, b) => a - b)
    .map(k => ({ id: toolCallsAcc[k].id || ('call_' + k), type: 'function',
      function: { name: toolCallsAcc[k].name, arguments: toolCallsAcc[k].arguments } }));

  const assistantMsg = { role: 'assistant' };
  if (contentAcc) assistantMsg.content = contentAcc;
  else if (toolCallsList.length === 0) assistantMsg.content = '';
  if (reasoningAcc) assistantMsg.reasoning_content = reasoningAcc;
  if (toolCallsList.length > 0) assistantMsg.tool_calls = toolCallsList;

  return { message: assistantMsg, finishReason, content: contentAcc, toolCalls: toolCallsList };
}

async function callLLMWithFailover(messages, candidateKeys, startIdx, tools, onFlush, onSwitch, PROVIDERS) {
  const failed = [];
  for (let i = startIdx; i < candidateKeys.length; i++) {
    const key = candidateKeys[i];
    const provider = PROVIDERS[key];
    if (!provider || !provider.key) { failed.push(provider ? provider.label : key); continue; }
    try {
      const response = await streamChatCompletion(provider, messages, tools, onFlush);
      return { response, usedIdx: i, failed };
    } catch (e) {
      if (e instanceof RateLimitError || e instanceof ProviderError) {
        failed.push(provider.label);
        const next = candidateKeys[i + 1];
        if (onSwitch) {
          onSwitch(`⚠️ ${provider.label} failed (${e.message}). ${next ? 'Switching to ' + PROVIDERS[next].label + '...' : 'No more providers.'}`);
        }
        continue;
      }
      throw e;
    }
  }
  const err = new Error('All providers failed: ' + failed.join(', '));
  err.allFailed = failed;
  throw err;
}

module.exports = { streamChatCompletion, callLLMWithFailover };
