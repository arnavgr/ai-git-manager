'use strict';

const { getState, setState, setTurnActive } = require('./kv');

(async () => {
  try {
    setTurnActive(false);
    const state = (await getState()) || {};
    state.status = 'exited';
    state.model_info = 'Runner disconnected';
    if (!state.last_agent || !state.last_agent.includes('terminated')) {
      state.last_agent = 'Session ended.\n\n' + (state.last_agent || '');
    }
    await setState(state);
  } catch (e) { console.error('Finalization failed:', e); }
})();
