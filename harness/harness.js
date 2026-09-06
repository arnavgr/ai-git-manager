'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { PROVIDERS, DEFAULT_ORDER } = require('./providers');
const { TOOLS, executeTool } = require('./tools');
const { WEB_SEARCH_TOOL } = require('./websearch');
const { buildSystemPrompt, buildContextSnapshot } = require('./prompt');
const { callLLMWithFailover } = require('./llm');
const { getState, setState, setTurnActive, flushThinkingKV, flushSwitchKV } = require('./kv');

const TARGET_DIR = process.env.TARGET_DIR || path.resolve(process.cwd(), 'target');
if (fs.existsSync(TARGET_DIR)) {
  process.chdir(TARGET_DIR);
}

const MAX_TOOL_TURNS = 60;
const TOOL_RESULT_MAX = 25000;

function truncate(s, max) {
  s = String(s);
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n... [truncated ' + (s.length - max) + ' chars]';
}

function pushChanges() {
  try {
    const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
    if (!status.stdout || !status.stdout.trim()) return { success: true, message: 'ℹ️ No code changes detected to push.' };
    spawnSync('git', ['add', '.'], { stdio: 'inherit' });
    const commit = spawnSync('git', ['commit', '-m', 'Live chat agent update'], { encoding: 'utf8' });
    if (commit.status !== 0) return { success: false, message: '❌ Commit failed: ' + (commit.stderr || commit.stdout || 'unknown error').trim() };
    const push = spawnSync('git', ['push', 'origin', 'HEAD'], { encoding: 'utf8' });
    if (push.status !== 0) return { success: false, message: '❌ Push failed: ' + (push.stderr || push.stdout || 'unknown error').trim() };
    return { success: true, message: '✅ Changes committed and pushed to remote.' };
  } catch (e) {
    return { success: false, message: '❌ Push error: ' + e.message };
  }
}

async function runAgentTurn(messages, candidateKeys, tools, onFlush, onSwitch) {
  let providerIdx = 0;
  const allFailed = [];
  let lastUsedKey = candidateKeys[0];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const { response, usedIdx, failed } =
      await callLLMWithFailover(messages, candidateKeys, providerIdx, tools, onFlush, onSwitch, PROVIDERS);
    allFailed.push(...failed);
    providerIdx = usedIdx;
    lastUsedKey = candidateKeys[usedIdx];

    const assistantMsg = response.message;
    messages.push(assistantMsg);

    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      for (const tc of assistantMsg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
        if (typeof onFlush === 'function') {
          onFlush(`🔧 Running tool: ${tc.function.name}...`);
        }
        let toolResult;
        // FIX: executeTool is async now (web_search awaits a network call) —
        // this used to assign the Promise object itself as toolResult instead
        // of its resolved value, and would never have caught a rejection.
        try { toolResult = await executeTool(tc.function.name, args); }
        catch (e) { toolResult = 'Tool execution error: ' + e.message; }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: truncate(toolResult, TOOL_RESULT_MAX) });
      }
      continue;
    } else {
      return {
        finalText: assistantMsg.content || '(The agent produced no final output.)',
        failedProviders: allFailed,
        providerKey: lastUsedKey
      };
    }
  }
  return {
    finalText: '⚠️ Reached the maximum number of tool-calling turns (' + MAX_TOOL_TURNS + '). Stopping to avoid an infinite loop.',
    failedProviders: allFailed,
    providerKey: lastUsedKey
  };
}

spawnSync('git', ['config', 'user.name', 'OpenClaude Agent'], { stdio: 'inherit' });
spawnSync('git', ['config', 'user.email', 'agent@arnavgr.com'], { stdio: 'inherit' });

let conversation = null;

// FIX (message-loss race): if the user sends a follow-up message while a
// turn is still in flight (KV status "thinking"), the old code always wrote
// back `msg_id: lastMsgId` — the id it started this turn with — clobbering
// whatever newer msg_id/last_user/attachment a concurrent /send had just
// written, and *rewinding* msg_id so the newer message could never trigger
// `state.msg_id > lastMsgId` again. It was silently and permanently lost.
//
// This also fixes a second, related bug: every call site used to reconstruct
// the KV object field-by-field (`{ status, last_user, msg_id, provider_choice:
// state.provider_choice || 'auto', ... }`), so any field not explicitly
// re-listed here (like the new `web_search_enabled` toggle) would quietly
// vanish after the first turn. Spreading the freshest KV read fixes both at
// once: nothing is dropped, and an in-flight newer message is preserved and
// picked up on the very next loop iteration instead of being overwritten.
async function finalizeTurn(lastMsgId, patch) {
  const latestKV = (await getState()) || {};
  const pendingNewer = Number(latestKV.msg_id) > lastMsgId;
  await setState({
    ...latestKV,
    ...patch,
    status: pendingNewer ? 'thinking' : 'waiting'
  });
  return pendingNewer;
}

async function loop() {
  let lastMsgId = 0;
  let lastActivityTime = Date.now();
  const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

  while (true) {
    let state = null;
    try {
      state = await getState();

      if (state && Number(state.msg_id) > lastMsgId) {
        lastMsgId = Number(state.msg_id);
        lastActivityTime = Date.now();
        const userMsg = String(state.last_user || '').trim();

        setTurnActive(true);
        await setState({ ...state, status: 'thinking' });

        if (userMsg === '/exit') {
          setTurnActive(false);
          await setState({ ...state, status: 'exited', model_info: 'Session terminated.', last_agent: 'Runner terminated by user.', attachment: null });
          process.exit(0);
        } else if (userMsg === '/push') {
          setTurnActive(false);
          const pushResult = pushChanges();
          await finalizeTurn(lastMsgId, { last_agent: pushResult.message, attachment: null });
          lastActivityTime = Date.now();
          continue;
        } else if (userMsg === '/revert') {
          setTurnActive(false);
          const revert = spawnSync('git', ['revert', '--no-edit', 'HEAD'], { encoding: 'utf8' });
          let msg;
          if (revert.status !== 0) msg = '❌ Revert failed: ' + (revert.stderr || revert.stdout || 'unknown error').trim();
          else { const pushResult = pushChanges(); msg = '↩️ Reverted the last commit.\n' + pushResult.message; }
          await finalizeTurn(lastMsgId, { last_agent: msg, attachment: null });
          lastActivityTime = Date.now();
          continue;
        }

        let instruction = userMsg;
        if (state.attachment && state.attachment.name && state.attachment.content) {
          try {
            const safeFileName = path.basename(state.attachment.name);
            fs.writeFileSync(path.join(process.cwd(), safeFileName), state.attachment.content, 'utf8');
            instruction = `[System Notice: The user uploaded file '${safeFileName}', which has been written to the repo root directory.]\n\n` + userMsg;
          } catch (e) { console.error('Failed to write attachment:', e); }
        }

        let candidateKeys;
        const isStrict = !!state.strict_pinning;
        if (state.provider_choice && state.provider_choice !== 'auto' && DEFAULT_ORDER.includes(state.provider_choice)) {
          if (isStrict) {
            candidateKeys = [state.provider_choice];
          } else {
            candidateKeys = [state.provider_choice, ...DEFAULT_ORDER.filter(p => p !== state.provider_choice)];
          }
        } else {
          candidateKeys = DEFAULT_ORDER.slice();
        }

        const webSearchEnabled = !!state.web_search_enabled && !!process.env.TAVILY_API_KEY;
        const tools = webSearchEnabled ? [...TOOLS, WEB_SEARCH_TOOL] : TOOLS;

        if (!conversation) {
          conversation = [{ role: 'system', content: '' }];
        }
        // FIX (stale context): the system message used to be built once and
        // never touched again, so the "REPOSITORY FILE MAP" and key-file
        // snapshots (package.json, README, etc.) baked into it went stale
        // the moment the agent created/edited anything in turn 1 — later
        // turns kept seeing the turn-0 snapshot. Rebuilding it fresh before
        // every turn keeps it accurate, and also lets the tool list/rules
        // reflect the current web_search_enabled setting.
        conversation[0].content = buildSystemPrompt(webSearchEnabled) + '\n\n' + buildContextSnapshot();
        conversation.push({ role: 'user', content: instruction });

        let finalOutput, telemetryString;
        try {
          const result = await runAgentTurn(conversation, candidateKeys, tools, flushThinkingKV, flushSwitchKV);
          finalOutput = result.finalText;
          const activeLabel = PROVIDERS[result.providerKey] ? PROVIDERS[result.providerKey].label : result.providerKey;
          telemetryString = `Active: ${activeLabel}${isStrict ? ' [STRICT PIN]' : ''}`;
          if (result.failedProviders.length > 0) telemetryString += ` | Failed/Skipped: ${result.failedProviders.join(', ')}`;
        } catch (e) {
          finalOutput = '❌ Model execution failed or quota exceeded.\n\n' + e.message;
          telemetryString = isStrict ? 'Strict model execution failed' : 'All providers failed';
        }

        const pushResult = pushChanges();
        finalOutput += '\n\n---\n' + pushResult.message;

        setTurnActive(false);
        await finalizeTurn(lastMsgId, {
          last_agent: finalOutput,
          session_id: null,
          provider: null,
          model_info: telemetryString,
          attachment: null
        });
        lastActivityTime = Date.now();
      }

      if (Date.now() - lastActivityTime > IDLE_TIMEOUT_MS) {
        setTurnActive(false);
        await setState({ ...(state || {}), status: 'exited', model_info: 'Session expired (Inactivity)', last_agent: '⏱️ Runner terminated automatically due to 30 minutes of inactivity.' });
        process.exit(0);
      }
    } catch (err) {
      console.error('Bridge runtime error:', err);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
}

loop();
