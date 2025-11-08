/**
 * AppContext - 提供全局依赖注入容器（轻量级）
 */

import type { OpenAIClient } from '../clients/openai.js';
import type { EmbeddingClient } from '../clients/embedding.js';
import type { PhabricatorClient } from '../clients/phabricator.js';
import type { Cache } from '../cache/cache.js';
import type { StateManager } from '../state/manager.js';
import type { ContextStore, Memory } from './context.js';

export interface AppContext {
  openai: OpenAIClient;
  embedding: EmbeddingClient;
  phabricator: PhabricatorClient;
  cache: Cache;
  state: StateManager;
  contextStore: ContextStore;
  memory: Memory;
}

let currentContext: AppContext | null = null;

export function setAppContext(context: AppContext): void {
  currentContext = context;
}

export function getAppContext(): AppContext {
  if (!currentContext) {
    throw new Error('AppContext has not been initialized');
  }
  return currentContext;
}
