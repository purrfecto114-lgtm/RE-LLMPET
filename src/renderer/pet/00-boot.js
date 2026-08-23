'use strict';

// 这只宠盯谁：主进程建窗口时用 ?agent= 指派。
//   all    单宠模式，Claude + Codex 都盯
//   claude / codex / dsh  分身模式里各盯一个后端
const AGENT = new URLSearchParams(location.search).get('agent') || 'all';
const AGENT_NAME = { claude: 'Claude', codex: 'Codex', dsh: 'DeepSeek Harness', unknown: 'Agent' };
const agentName = (agent) => AGENT_NAME[agent] || 'Agent';
// Capabilities are provider-owned, never inferred from a UUID, terminal, or
// future provider name. dsh may be handed off as a readable source, but
// session-launch actions are only implemented for Claude/Codex. Unknown providers
// fail closed on every mutating/session-launch action.
const SESSION_ACTIONS = {
  claude: { takeover: true },
  codex: { takeover: true },
  dsh: { takeover: false },
};
const sessionActionAllowed = (session, action) => !!(
  session && SESSION_ACTIONS[session.agent] && SESSION_ACTIONS[session.agent][action]
);

