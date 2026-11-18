import { useSyncExternalStore } from 'react';
import type { AiAssistantResponse, AiChatStatus, ChatHistoryMessage } from '../types';
import { api } from '../services/tauri';
import { loadPageState, savePageState } from './persistedState';

export interface AiConversationTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  hadVisionImage?: boolean;
  response?: AiAssistantResponse;
  error?: string;
}

export interface AiChatStoreSnapshot {
  turns: AiConversationTurn[];
  isSending: boolean;
  sendingStartedAt: number | null;
  sendingWithVision: boolean;
  hasUnreadReply: boolean;
  status: AiChatStatus | null;
}

const TURNS_STORAGE_KEY = 'assistant.turns';

let currentVisibleTab = 'overview';
let warmInProgress = false;

let snapshot: AiChatStoreSnapshot = {
  turns: loadPageState<AiConversationTurn[]>(TURNS_STORAGE_KEY, []),
  isSending: false,
  sendingStartedAt: null,
  sendingWithVision: false,
  hasUnreadReply: false,
  status: null,
};

const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function updateSnapshot(updater: (prev: AiChatStoreSnapshot) => AiChatStoreSnapshot) {
  snapshot = updater(snapshot);
  emitChange();
}

function persistTurns(nextTurns: AiConversationTurn[]) {
  const capped = nextTurns.slice(-30);
  savePageState(TURNS_STORAGE_KEY, capped, true);
}

if (typeof window !== 'undefined') {
  window.addEventListener('po-autoflow:ui-state-sync', (ev: Event) => {
    const custom = ev as CustomEvent<{ key?: string }>;
    if (custom.detail?.key === TURNS_STORAGE_KEY && !snapshot.isSending) {
      const hydrated = loadPageState<AiConversationTurn[]>(TURNS_STORAGE_KEY, []);
      if (hydrated.length > 0 && snapshot.turns.length === 0) {
        updateSnapshot((prev) => ({ ...prev, turns: hydrated }));
      }
    }
  });
}

export function setCurrentUiTabForAiStore(tab: string): void {
  currentVisibleTab = tab;
  if (tab === 'assistant' && snapshot.hasUnreadReply) {
    updateSnapshot((prev) => ({ ...prev, hasUnreadReply: false }));
  }
}

export async function refreshAiChatStatus(warmIfReady = false): Promise<void> {
  try {
    const s = await api.getAiChatStatus();
    updateSnapshot((prev) => ({ ...prev, status: s }));
    if (
      warmIfReady &&
      s.ready &&
      s.provider === 'builtin' &&
      !s.server_running &&
      !warmInProgress
    ) {
      warmInProgress = true;
      api
        .warmAiChatServer()
        .then((warmed) => {
          updateSnapshot((prev) => ({ ...prev, status: warmed }));
        })
        .catch(() => {})
        .finally(() => {
          warmInProgress = false;
        });
    }
  } catch {
    // Non-fatal in browser preview mode
  }
}

export async function stopAiChatServerFromStore(): Promise<void> {
  await api.stopAiChatServer();
  await refreshAiChatStatus(false);
}

export function clearAiChatHistory(): void {
  persistTurns([]);
  updateSnapshot((prev) => ({
    ...prev,
    turns: [],
    hasUnreadReply: false,
  }));
}

export async function sendAiChatPrompt(params: {
  prompt: string;
  focusJobId?: string | null;
  includePageImage: boolean;
  attachedImageUrl?: string | null;
  attachedPage: number;
}): Promise<void> {
  const trimmed = params.prompt.trim();
  if (!trimmed || snapshot.isSending) return;

  const userTurn: AiConversationTurn = {
    id: `user-${Date.now()}`,
    role: 'user',
    text: trimmed,
    timestamp: new Date().toLocaleTimeString(),
    hadVisionImage: params.includePageImage,
  };

  const priorHistory: ChatHistoryMessage[] = snapshot.turns.slice(-8).map((t) => ({
    role: t.role,
    content: t.text,
  }));

  const turnsAfterUser = [...snapshot.turns, userTurn].slice(-30);
  persistTurns(turnsAfterUser);

  updateSnapshot((prev) => ({
    ...prev,
    turns: turnsAfterUser,
    isSending: true,
    sendingStartedAt: Date.now(),
    sendingWithVision: params.includePageImage,
    hasUnreadReply: false,
  }));

  try {
    const response = await api.askAiAssistant({
      prompt: trimmed,
      history: priorHistory,
      focusJobId: params.focusJobId || null,
      includePageImage: params.includePageImage,
      attachedImageDataUrl: params.includePageImage ? params.attachedImageUrl : null,
      attachedPageNumber: params.attachedPage,
    });

    const assistantTurn: AiConversationTurn = {
      id: `ai-${Date.now()}`,
      role: 'assistant',
      text: response.answer,
      timestamp: new Date().toLocaleTimeString(),
      response,
    };

    const nextTurns = [...snapshot.turns, assistantTurn].slice(-30);
    persistTurns(nextTurns);

    updateSnapshot((prev) => ({
      ...prev,
      turns: nextTurns,
      isSending: false,
      sendingStartedAt: null,
      sendingWithVision: false,
      hasUnreadReply: currentVisibleTab !== 'assistant',
    }));
    refreshAiChatStatus(false);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const errTurn: AiConversationTurn = {
      id: `err-${Date.now()}`,
      role: 'assistant',
      text: '',
      error: msg,
      timestamp: new Date().toLocaleTimeString(),
    };
    const nextTurns = [...snapshot.turns, errTurn].slice(-30);
    persistTurns(nextTurns);

    updateSnapshot((prev) => ({
      ...prev,
      turns: nextTurns,
      isSending: false,
      sendingStartedAt: null,
      sendingWithVision: false,
      hasUnreadReply: currentVisibleTab !== 'assistant',
    }));
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): AiChatStoreSnapshot {
  return snapshot;
}

export function useAiChatState(): AiChatStoreSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
