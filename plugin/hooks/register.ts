import type { Register } from 'claude-code';
import {
  configure,
  onAgentSpawn,
  onCommandRun,
  onModelCommand,
  onPromptCompose,
  onPromptSubmit,
  onRenderBand,
  onRenderPane,
  onSessionCompact,
  onSessionEnd,
  onSessionStart,
  onToolCall,
  onTurnComplete,
  onTurnStart,
  onTurnStep,
} from '../features/hooks.tsx';

// Subscriptions only; the logic lives in core/ (pure) and features/ ($).
export const register: Register = (on, options) => {
  configure(options);
  on('session.start', onSessionStart);
  on('session.end', onSessionEnd);
  on('session.compact', onSessionCompact);
  on('turn.start', onTurnStart);
  on('turn.complete', onTurnComplete);
  on('turn.step', onTurnStep);
  on('agent.spawn', onAgentSpawn);
  on('tool.call', onToolCall);
  on('prompt.compose', onPromptCompose);
  on('prompt.submit', onPromptSubmit);
  on('command.run', { command: 'agento' }, onCommandRun);
  on('command.run', { command: 'model' }, onModelCommand);
  on('ui.render', { component: 'AbovePrompt' }, onRenderBand);
  on('ui.render', { component: 'Pane', requestId: 'agento' }, onRenderPane);
};
