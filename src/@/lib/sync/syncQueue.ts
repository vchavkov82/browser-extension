// Debounced sync queue that batches browser bookmark events.
// Fires an incremental push sync after 2 seconds of inactivity.

import { getSyncState } from '../cache.ts';
import { performSync } from './syncEngine.ts';
import { getConfig } from '../config.ts';

type SyncEvent = {
  type: 'created' | 'changed' | 'removed' | 'moved';
  bookmarkId: string;
  timestamp: number;
};

let eventQueue: SyncEvent[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 2000;

export function enqueueSyncEvent(event: Omit<SyncEvent, 'timestamp'>): void {
  eventQueue.push({ ...event, timestamp: Date.now() });
  resetDebounce();
}

function resetDebounce(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(flushQueue, DEBOUNCE_MS);
}

async function flushQueue(): Promise<void> {
  if (eventQueue.length === 0) return;

  // Check if we should suppress events (e.g., during pull phase)
  const state = await getSyncState();
  if (state.suppressBrowserEvents) {
    eventQueue = [];
    return;
  }

  const config = await getConfig();
  if (!config.syncBookmarks) {
    eventQueue = [];
    return;
  }

  // Clear queue before processing to avoid re-entrant issues
  const events = [...eventQueue];
  eventQueue = [];

  console.log(`[Sync Queue] Flushing ${events.length} events`);

  try {
    // Run an incremental sync (not full) — it will pick up browser changes
    await performSync({ fullSync: false });
  } catch (err) {
    console.error('[Sync Queue] Flush failed:', err);
  }
}

export function clearQueue(): void {
  eventQueue = [];
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
