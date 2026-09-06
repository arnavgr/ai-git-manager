'use strict';

const TAVILY_URL = 'https://api.tavily.com/search';

async function webSearch(query, maxResults) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return 'Web search is not configured (no TAVILY_API_KEY set).';
  }

  const q = String(query || '').trim();
  if (!q) return 'Error: empty search query.';

  const capped = Math.min(Math.max(parseInt(maxResults, 10) || 5, 1), 10);

  let res;
  try {
    res = await fetch(TAVILY_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: q,
        max_results: capped,
        search_depth: 'basic',
        include_answer: true
      })
    });
  } catch (e) {
    return `Web search network error: ${e.message}`;
  }

  if (!res.ok) {
    let errText = '';
    try { errText = await res.text(); } catch {}
    return `Web search failed (HTTP ${res.status}): ${errText.slice(0, 300)}`;
  }

  let data;
  try { data = await res.json(); } catch (e) {
    return `Web search returned an unreadable response: ${e.message}`;
  }

  const lines = [];
  if (data.answer) lines.push(`Summary: ${data.answer}`);

  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0 && !data.answer) return 'No results found.';

  for (const r of results) {
    const snippet = String(r.content || '').slice(0, 500);
    lines.push(`\n- ${r.title || '(untitled)'} — ${r.url}\n  ${snippet}`);
  }
  return lines.join('\n');
}

const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the live web for current information — e.g. current library/framework APIs, recent error messages, version numbers, security advisories, or anything that may have changed since training. Only reach for this when the codebase and your own knowledge genuinely aren\'t enough; prefer grep_search/read_file for anything answerable from the repo itself.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        max_results: { type: 'integer', description: 'Number of results to return (1-10, default 5).' }
      },
      required: ['query']
    }
  }
};

module.exports = { webSearch, WEB_SEARCH_TOOL };
