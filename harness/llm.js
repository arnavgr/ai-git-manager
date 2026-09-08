'use strict';

const { RateLimitError, ProviderError, isRateLimitText } = require('./providers');

function providerDebugName(provider) {
  return `${provider.label} (${provider.model})`;
}

async function streamChatCompletion(provider, messages, tools, onFlush) {
  let streamBuffer = '';
  let lastFlushedLen = -1;
  const flushTimer = (typeof onFlush === 'function') ? setInterval(() => {
    if (streamBuffer.length > 0 && streamBuffer.length !== lastFlushedLen) {
      lastFlushedLen = streamBuffer.length;
      try { onFlush(streamBuffer); } catch {}
    }
  }, 2500) : null;

  if (!provider || !provider.url || !provider.model) {
    if (flushTimer) clearInterval(flushTimer);
    throw new ProviderError(`Invalid provider configuration for ${provider?.label || 'unknown provider'}`);
  }

  if (!provider.key) {
    if (flushTimer) clearInterval(flushTimer);
    throw new ProviderError(`${providerDebugName(provider)} has no API key configured (expected its provider secret in the GitHub Actions environment)`);
  }

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
        'Accept': 'text/event-stream, application/json',
        'Authorization': `Bearer ${provider.key}`,
        ...(provider.extraHeaders || {})
      },
      body: JSON.stringify(bodyObj)
    });
  } catch (netErr) {
    if (flushTimer) clearInterval(flushTimer);
    throw new ProviderError(`Network error reaching ${providerDebugName(provider)}: ${netErr.message}`);
  }

  if (!res.ok) {
    let errText = '';
    try { errText = await res.text(); } catch {}
    if (flushTimer) clearInterval(flushTimer);

    const details = String(errText || '').trim().slice(0, 1000);
    if (res.status === 429 || isRateLimitText(errText) || isRateLimitText(String(res.status))) {
      throw new RateLimitError(
        `HTTP ${res.status} from ${providerDebugName(provider)}${details ? `: ${details}` : ''}`
      );
    }

    throw new ProviderError(
      `HTTP ${res.status} from ${providerDebugName(provider)}${details ? `: ${details}` : ' (empty response body)'} ` +
      `\nRequest: stream=true, tools=${Array.isArray(tools) ? tools.length : 0}, max_tokens=${provider.maxTokens || 'unset'}`
    );
  }

  let contentAcc = '';
  const toolCallsAcc = {};
  let finishReason = null;

  function handleLine(rawLine) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let json;
    try { json = JSON.parse(payload); } catch { return; }

    if (json.error) {
      const msg = typeof json.error === 'string' ? json.error : (json.error.message || JSON.stringify(json.error));
      throw new Error(msg);
    }

    const choice = (json.choices && json.choices[0]) || null;
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};

    const reasoningChunk = delta.reasoning || delta.reasoning_content;
    if (typeof reasoningChunk === 'string' && reasoningChunk.length) {
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
    if (!res.body) {
      throw new Error('Provider returned an empty response body');
    }

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
    const msg = streamErr && streamErr.message ? streamErr.message : String(streamErr);
    if (isRateLimitText(msg)) {
      throw new RateLimitError(`Mid-stream rate limit from ${providerDebugName(provider)}: ${msg}`);
    }
    throw new ProviderError(`Mid-stream failure from ${providerDebugName(provider)}: ${msg}`);
  }

  if (flushTimer) clearInterval(flushTimer);

  const toolCallsList = Object.keys(toolCallsAcc)
    .map(k => parseInt(k, 10)).sort((a, b) => a - b)
    .map(k => ({ id: toolCallsAcc[k].id || ('call_' + k), type: 'function',
      function: { name: toolCallsAcc[k].name, arguments: toolCallsAcc[k].arguments } }));

  const assistantMsg = { role: 'assistant' };
  if (contentAcc) assistantMsg.content = contentAcc;
  else if (toolCallsList.length === 0) assistantMsg.content = '';
  if (toolCallsList.length > 0) assistantMsg.tool_calls = toolCallsList;

  return { message: assistantMsg, finishReason, content: contentAcc, toolCalls: toolCallsList };
}

async function callLLMWithFailover(messages, candidateKeys, startIdx, tools, onFlush, onSwitch, PROVIDERS) {
  const failed = [];
  for (let i = startIdx; i < candidateKeys.length; i++) {
    const key = candidateKeys[i];
    const provider = PROVIDERS[key];
    if (!provider) { failed.push(`${key} (unknown provider)`); continue; }
    try {
      const response = await streamChatCompletion(provider, messages, tools, onFlush);
      return { response, usedIdx: i, failed };
    } catch (e) {
      if (e instanceof RateLimitError || e instanceof ProviderError) {
        failed.push(`${provider.label}: ${e.message}`);
        const next = candidateKeys[i + 1];
        if (onSwitch) {
          onSwitch(`⚠️ ${provider.label} failed (${e.message}). ${next ? 'Switching to ' + PROVIDERS[next].label + '...' : 'No more providers.'}`);
        }
        continue;
      }
      throw e;
    }
  }
  const err = new Error('All providers failed:\n' + failed.join('\n'));
  err.allFailed = failed;
  throw err;
}

module.exports = { streamChatCompletion, callLLMWithFailover };
