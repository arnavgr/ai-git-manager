'use strict';

const PROVIDERS = {
  'gemini-3.8': {
    label: 'Gemini 3.8 Flash',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-3.8-flash',
    key: process.env.GEMINI_API_KEY
  },
  'gemini-3.7': {
    label: 'Gemini 3.7 Flash',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-3.7-flash',
    key: process.env.GEMINI_API_KEY
  },
  'gemini-3.6': {
    label: 'Gemini 3.6 Flash',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-3.6-flash',
    key: process.env.GEMINI_API_KEY
  },
  'gemini-3.5': {
    label: 'Gemini 3.5 Flash',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-3.5-flash',
    key: process.env.GEMINI_API_KEY
  },
  'gemini-3.5-lite': {
    label: 'Gemini 3.5 Flash-Lite',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-3.5-flash-lite',
    key: process.env.GEMINI_API_KEY
  },
  'gemini-3.1-lite': {
    label: 'Gemini 3.1 Flash-Lite',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-3.1-flash-lite',
    key: process.env.GEMINI_API_KEY
  },
  'nim-deepseek-v4': {
    label: 'NVIDIA NIM (DeepSeek V4 Flash)',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'deepseek-ai/deepseek-v4-flash-0731',
    key: process.env.NVIDIA_API_KEY,
    maxTokens: 16384,
    extraHeaders: { 'Accept': 'text/event-stream' },
    extraBody: { chat_template_kwargs: { thinking: true, reasoning_effort: 'high' } }
  },
  'nim-kimi-k3': {
    label: 'NVIDIA NIM (Kimi K3)',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'moonshotai/kimi-k3',
    key: process.env.NVIDIA_API_KEY,
    maxTokens: 16384,
    extraHeaders: { 'Accept': 'text/event-stream' },
    extraBody: { reasoning_effort: 'high' }
  },
  'openrouter': {
    label: 'OpenRouter Free',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    model: process.env.OPENROUTER_MODEL || 'openrouter/free',
    key: process.env.OPENROUTER_API_KEY,
    maxTokens: 4000,
    extraHeaders: { 'HTTP-Referer': 'https://github.com', 'X-Title': 'CloudPhone-Agent' }
  },
  'orcarouter': {
    label: 'OrcaRouter Free',
    url: 'https://api.orcarouter.ai/v1/chat/completions',
    model: process.env.ORCAROUTER_MODEL || 'orcarouter/free',
    key: process.env.ORCAROUTER_API_KEY,
    maxTokens: 4000,
    extraHeaders: { 'Accept': 'text/event-stream' }
  },
  'groq': {
    label: 'Groq (Qwen 3.8 27B)',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
    key: process.env.GROQ_API_KEY,
    maxTokens: 16384
  },
  'groq-3.6': {
    label: 'Groq (Qwen 3.6 27B)',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'qwen/qwen3.6-27b',
    key: process.env.GROQ_API_KEY,
    maxTokens: 16384
  }
};

const DEFAULT_ORDER = [
  'gemini-3.8',
  'gemini-3.7',
  'gemini-3.6',
  'gemini-3.5',
  'gemini-3.5-lite',
  'gemini-3.1-lite',
  'nim-deepseek-v4',
  'nim-kimi-k3',
  'openrouter',
  'orcarouter',
  'groq',
  'groq-3.6'
];

const RATE_LIMIT_PATTERNS = [
  /error:\s*429/i,
  /\b429\b/,
  /rate.?limit/i,
  /rate_limit/i,
  /quota/i,
  /resource.?exhausted/i,
  /too many requests/i,
  /overloaded/i
];

class RateLimitError extends Error {}
class ProviderError extends Error {}

function isRateLimitText(text) {
  return RATE_LIMIT_PATTERNS.some(p => p.test(String(text)));
}

module.exports = {
  PROVIDERS,
  DEFAULT_ORDER,
  RATE_LIMIT_PATTERNS,
  RateLimitError,
  ProviderError,
  isRateLimitText
};
