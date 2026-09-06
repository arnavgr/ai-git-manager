'use strict';

const { getState, setState, setTurnActive } = require('./kv');

(async () => {
  try {
    setTurnActive(false);
    const state = (await getState()) || {};
    const cleanExit = state.last_agent && /terminated/i.test(state.last_agent);
    state.status = 'exited';
    // FIX: this step runs on every run via `if: always()`, including the
    // clean /exit and idle-timeout paths, which already set a specific,
    // more useful model_info ('Session terminated.' / 'Session expired
    // (Inactivity)'). Only stamp the generic message when nothing already
    // explained why the runner stopped.
    if (!cleanExit) {
      state.model_info = 'Runner disconnected';
    }
    if (!cleanExit) {
      state.last_agent = 'Session ended.\n\n' + (state.last_agent || '');
    }
    await setState(state);
  } catch (e) { console.error('Finalization failed:', e); }
})();
