import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { api, isTauriEnvironment } from '../services/tauri';

const STORAGE_PREFIX = 'po_autoflow_ui:v1:';
const SYNC_EVENT = 'po-autoflow:ui-state-sync';
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function loadPageState<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null || raw === '') return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function savePageState<T>(key: string, value: T, syncBackend = true): void {
  if (typeof window === 'undefined') return;
  try {
    const json = JSON.stringify(value);
    window.localStorage.setItem(STORAGE_PREFIX + key, json);
    if (syncBackend && isTauriEnvironment()) {
      const existing = pendingTimers.get(key);
      if (existing) clearTimeout(existing);
      pendingTimers.set(
        key,
        setTimeout(() => {
          pendingTimers.delete(key);
          api.saveUiState(key, json).catch(() => {});
        }, 350)
      );
    }
  } catch {
    // Ignore storage quota or serialization errors safely
  }
}

export function notifyPageStateSync(key: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { key } }));
}

export function usePersistedState<T>(
  key: string,
  fallback: T
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => loadPageState<T>(key, fallback));

  useEffect(() => {
    savePageState(key, state, true);
  }, [key, state]);

  useEffect(() => {
    const handler = (ev: Event) => {
      const custom = ev as CustomEvent<{ key?: string }>;
      if (custom.detail?.key === key) {
        setState(loadPageState<T>(key, fallback));
      }
    };
    window.addEventListener(SYNC_EVENT, handler);
    return () => window.removeEventListener(SYNC_EVENT, handler);
  }, [key, fallback]);

  return [state, setState];
}

export async function hydrateUiStateFromBackend(): Promise<void> {
  if (typeof window === 'undefined' || !isTauriEnvironment()) return;
  try {
    const remote = await api.getUiState();
    const entries = Object.entries(remote || {});
    for (const [k, vJson] of entries) {
      if (window.localStorage.getItem(STORAGE_PREFIX + k) === null) {
        window.localStorage.setItem(STORAGE_PREFIX + k, vJson);
        notifyPageStateSync(k);
      }
    }
  } catch {
    // Non-fatal: localStorage remains source
  }
}

export function cleanupDeletedJobFromPersistedState(deletedJobId: string): void {
  if (!deletedJobId || typeof window === 'undefined') return;

  for (const singleKey of ['app.selectedJobId', 'overview.selectedId', 'assistant.focusJobId']) {
    const current = loadPageState<string>(singleKey, '');
    if (current === deletedJobId) {
      savePageState(singleKey, '', true);
      notifyPageStateSync(singleKey);
    }
  }

  for (const mapKey of ['inspector.pageByJob', 'overview.docIndexByJob']) {
    const record = loadPageState<Record<string, number>>(mapKey, {});
    if (record && typeof record === 'object' && deletedJobId in record) {
      const next = { ...record };
      delete next[deletedJobId];
      savePageState(mapKey, next, true);
      notifyPageStateSync(mapKey);
    }
  }
}
