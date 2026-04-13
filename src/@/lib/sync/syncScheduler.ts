// Periodic sync scheduler using chrome.alarms API.
// Quick check every 5 minutes, full sync every 30 minutes.

import { getBrowser } from '../utils.ts';
import { getConfig } from '../config.ts';
import { performSync, hasServerChanges } from './syncEngine.ts';

const browser = getBrowser();

const ALARM_QUICK = 'lw-sync-quick';
const ALARM_FULL = 'lw-sync-full';

export function initSyncScheduler(): void {
  // Create alarms
  browser.alarms.create(ALARM_QUICK, { periodInMinutes: 5 });
  browser.alarms.create(ALARM_FULL, { periodInMinutes: 30 });

  console.log('[Sync Scheduler] Initialized: quick=5m, full=30m');
}

export function stopSyncScheduler(): void {
  browser.alarms.clear(ALARM_QUICK);
  browser.alarms.clear(ALARM_FULL);
  console.log('[Sync Scheduler] Stopped');
}

export async function handleAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  const config = await getConfig();
  if (!config.syncBookmarks || !config.baseUrl || !config.apiKey) return;

  if (alarm.name === ALARM_QUICK) {
    // Quick check: only sync if server has changes
    try {
      const changed = await hasServerChanges();
      if (changed) {
        console.log('[Sync Scheduler] Server changes detected, syncing...');
        await performSync({ fullSync: false });
      }
    } catch (err) {
      console.error('[Sync Scheduler] Quick sync failed:', err);
    }
  } else if (alarm.name === ALARM_FULL) {
    // Full bidirectional sync
    try {
      console.log('[Sync Scheduler] Full sync starting...');
      const result = await performSync({ fullSync: true });
      console.log(
        `[Sync Scheduler] Full sync complete: pulled=${result.pulled}, pushed=${result.pushed}, deleted=${result.deleted}, errors=${result.errors.length}`
      );
    } catch (err) {
      console.error('[Sync Scheduler] Full sync failed:', err);
    }
  }
}
