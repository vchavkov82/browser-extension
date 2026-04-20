// Core bidirectional sync engine.
// Implements timestamp-gated state reconciliation with union-favoring conflict resolution.

import { getConfig } from '../config.ts';
import { bootstrapManagedRoot, type BootstrapResult } from './bootstrap.ts';
import {
  type BookmarkSyncEntry,
  getSyncState,
  updateSyncState,
  getSyncMaps,
  saveSyncEntries,
  createBookmarkInBrowser,
  updateBookmarkInBrowser,
  removeBookmarkFromBrowser,
  moveBookmarkInBrowser,
  getBrowserBookmarkTree,
  collectBookmarks,
} from '../cache.ts';
import {
  fetchSyncStatus,
  fetchLinksSince,
  bulkCreateLinks,
  bulkDeleteLinks,
  updateLink,
  pinLink,
  unpinLink,
  type SyncLink,
} from './apiClient.ts';
import {
  reconcileFolderMap,
  getManagedCollectionIds,
  getFolderMap,
  getCollectionIdForFolder,
  getBrowserFolderIdForCollection,
  getBookmarksBarFolderId,
  isBookmarksBar,
  findFolderById,
  type FolderCollectionMap,
} from './folderMapper.ts';

export interface SyncResult {
  pulled: number;
  pushed: number;
  deleted: number;
  errors: string[];
  bootstrap?: BootstrapResult;
}

export async function performSync(options?: {
  fullSync?: boolean;
}): Promise<SyncResult> {
  const state = await getSyncState();

  // Guard: prevent re-entrant sync
  if (state.syncInProgress) {
    return { pulled: 0, pushed: 0, deleted: 0, errors: ['Sync already in progress'] };
  }

  const config = await getConfig();
  if (!config.baseUrl || !config.apiKey) {
    return { pulled: 0, pushed: 0, deleted: 0, errors: ['Not configured'] };
  }

  const { baseUrl, apiKey } = config;
  const result: SyncResult = { pulled: 0, pushed: 0, deleted: 0, errors: [] };

  await updateSyncState({ syncInProgress: true, suppressBrowserEvents: true });

  try {
    // 1. Get server time and check for changes
    const status = await fetchSyncStatus(baseUrl, apiKey);
    const since =
      options?.fullSync || !state.lastSyncTimestamp
        ? undefined
        : state.lastSyncTimestamp;

    // 2. Bootstrap managed root + reconcile scoped folder map
    const bootstrap = await bootstrapManagedRoot();
    result.bootstrap = bootstrap;
    const rootCollectionId = bootstrap.managedRoot.serverCollectionId;
    const rootFolderId = bootstrap.managedRoot.browserRootFolderId;
    if (!rootCollectionId || !rootFolderId) {
      throw new Error('Managed root bootstrap completed without required ids');
    }
    const folderMap = await reconcileFolderMap(
      baseUrl,
      apiKey,
      rootCollectionId,
      rootFolderId
    );
    const managedCollectionIds = getManagedCollectionIds(folderMap, rootCollectionId);

    // 3. PULL: Server → Browser
    const syncEntries = await pullFromServer(
      baseUrl,
      apiKey,
      since,
      folderMap,
      result,
      managedCollectionIds,
      rootFolderId
    );

    // 4. PUSH: Browser → Server
    await pushToServer(baseUrl, apiKey, folderMap, syncEntries, result, managedCollectionIds, rootFolderId);

    // 5. Finalize
    await saveSyncEntries(syncEntries);
    await updateSyncState({
      lastSyncTimestamp: status.serverTime,
      syncInProgress: false,
      suppressBrowserEvents: false,
    });
  } catch (err) {
    result.errors.push(
      err instanceof Error ? err.message : 'Unknown sync error'
    );
    await updateSyncState({
      syncInProgress: false,
      suppressBrowserEvents: false,
    });
  }

  return result;
}

async function pullFromServer(
  baseUrl: string,
  apiKey: string,
  since: string | undefined,
  folderMap: FolderCollectionMap,
  result: SyncResult,
  managedCollectionIds: Set<number>,
  rootFolderId: string
): Promise<BookmarkSyncEntry[]> {
  const { links, tombstones } = await fetchLinksSince(
    baseUrl,
    apiKey,
    since
  );
  const maps = await getSyncMaps();
  const entries = [...maps.byServerId.values()];

  // Process server links
  for (const link of links) {
    if (!link.url) continue;
    if (!managedCollectionIds.has(link.collectionId)) continue;

    const existingEntry = maps.byServerId.get(link.id);
    const isPinned = link.pinnedBy.length > 0;

    if (existingEntry) {
      // Link exists in cache — check if server version is newer
      const serverUpdated = new Date(link.updatedAt).getTime();
      const cachedUpdated = new Date(existingEntry.serverUpdatedAt).getTime();

      if (serverUpdated > cachedUpdated) {
        // Server is newer — update browser bookmark
        try {
          await updateBookmarkInBrowser(existingEntry.browserBookmarkId, {
            url: link.url,
            title: link.name,
          });

          // Handle pin state change
          const targetFolderId = await getResolvedTargetFolderId(
            link,
            isPinned,
            folderMap,
            rootFolderId
          );
          if (targetFolderId) {
            await moveBookmarkInBrowser(existingEntry.browserBookmarkId, {
              parentId: targetFolderId,
            });
          }

          // Update cache entry
          existingEntry.url = link.url;
          existingEntry.name = link.name;
          existingEntry.collectionId = link.collectionId;
          existingEntry.isPinned = isPinned;
          existingEntry.serverUpdatedAt = link.updatedAt;
          existingEntry.syncedAt = new Date().toISOString();
          result.pulled++;
        } catch (err) {
          result.errors.push(`Pull update failed for link ${link.id}: ${err}`);
        }
      }
    } else {
      // New server link — create browser bookmark
      const targetFolderId = await getResolvedTargetFolderId(
        link,
        isPinned,
        folderMap,
        rootFolderId
      );

      try {
        const bookmark = await createBookmarkInBrowser(
          link.url,
          link.name,
          targetFolderId || undefined
        );

        entries.push({
          serverId: link.id,
          browserBookmarkId: bookmark.id,
          collectionId: link.collectionId,
          url: link.url,
          name: link.name,
          isPinned,
          serverUpdatedAt: link.updatedAt,
          syncedAt: new Date().toISOString(),
        });
        result.pulled++;
      } catch (err) {
        result.errors.push(`Pull create failed for link ${link.id}: ${err}`);
      }
    }
  }

  // Process tombstones (server-side deletes)
  for (const tombstone of tombstones) {
    const entry = maps.byServerId.get(tombstone.entityId);
    if (!entry || !managedCollectionIds.has(entry.collectionId)) continue;
    try {
      await removeBookmarkFromBrowser(entry.browserBookmarkId);
      // Remove from entries
      const idx = entries.findIndex(
        (e) => e.serverId === tombstone.entityId
      );
      if (idx !== -1) entries.splice(idx, 1);
      result.deleted++;
    } catch (err) {
      result.errors.push(
        `Pull delete failed for tombstone ${tombstone.entityId}: ${err}`
      );
    }
  }

  return entries;
}

async function pushToServer(
  baseUrl: string,
  apiKey: string,
  folderMap: FolderCollectionMap,
  syncEntries: BookmarkSyncEntry[],
  result: SyncResult,
  managedCollectionIds: Set<number>,
  rootFolderId: string
): Promise<void> {
  const browserTree = await getBrowserBookmarkTree();
  const browserBookmarks: Array<{
    id: string;
    url: string;
    title: string;
    parentId?: string;
  }> = [];
  // Only collect bookmarks from the root sync folder subtree
  const rootNode = findFolderById(browserTree, rootFolderId);
  if (rootNode) collectBookmarks([rootNode], browserBookmarks);
  const maps = createSyncMaps(syncEntries);

  // Track which cache entries still have a browser bookmark
  const seenBookmarkIds = new Set<string>();

  // Bookmarks to create on server
  const toCreate: Array<{
    url: string;
    name: string;
    description: string;
    collection: { id?: number; name?: string };
    browserBookmarkId: string;
    shouldPin: boolean;
  }> = [];

  // Bookmarks to update on server
  const toUpdate: Array<{
    serverId: number;
    url: string;
    name: string;
    collectionId?: number;
    browserBookmarkId: string;
  }> = [];

  for (const bm of browserBookmarks) {
    seenBookmarkIds.add(bm.id);

    const existingEntry = maps.byBookmarkId.get(bm.id);

    if (!existingEntry) {
      // Check if we know this URL from a different bookmark ID (avoid duplicates)
      const urlEntry = maps.byUrl.get(bm.url);
      if (urlEntry) continue;

      // New bookmark — push to server
      const collectionId = bm.parentId
        ? getCollectionIdForFolder(folderMap, bm.parentId)
        : undefined;
      const shouldPin = bm.parentId ? isBookmarksBar(bm.parentId) : false;

      toCreate.push({
        url: bm.url,
        name: bm.title || bm.url,
        description: '',
        collection: collectionId
          ? { id: collectionId }
          : { name: 'Unorganized' },
        browserBookmarkId: bm.id,
        shouldPin,
      });
    } else {
      // Existing bookmark — check for changes
      const nextCollectionId = bm.parentId
        ? getCollectionIdForFolder(folderMap, bm.parentId)
        : undefined;
      if (
        existingEntry.url !== bm.url ||
        existingEntry.name !== bm.title ||
        nextCollectionId !== existingEntry.collectionId
      ) {
        toUpdate.push({
          serverId: existingEntry.serverId,
          url: bm.url,
          name: bm.title || bm.url,
          collectionId: nextCollectionId,
          browserBookmarkId: bm.id,
        });
      }

      // Check pin state change
      const shouldBePinned = bm.parentId
        ? isBookmarksBar(bm.parentId)
        : false;
      if (shouldBePinned && !existingEntry.isPinned) {
        try {
          await pinLink(baseUrl, apiKey, existingEntry.serverId);
          existingEntry.isPinned = true;
        } catch (err) {
          result.errors.push(
            `Pin failed for link ${existingEntry.serverId}: ${err}`
          );
        }
      } else if (!shouldBePinned && existingEntry.isPinned) {
        try {
          await unpinLink(baseUrl, apiKey, existingEntry.serverId);
          existingEntry.isPinned = false;
        } catch (err) {
          result.errors.push(
            `Unpin failed for link ${existingEntry.serverId}: ${err}`
          );
        }
      }
    }
  }

  // Bulk create new links
  if (toCreate.length > 0) {
    try {
      const createResult = await bulkCreateLinks(
        baseUrl,
        apiKey,
        toCreate.map((c) => ({
          url: c.url,
          name: c.name,
          description: c.description,
          collection: c.collection,
        }))
      );

      // Map created links back to browser bookmark IDs
      for (let i = 0; i < createResult.created.length; i++) {
        const created = createResult.created[i];
        // Match by URL since order may not be preserved
        const match = toCreate.find((c) => c.url === created.url);
        if (match) {
          const newEntry: BookmarkSyncEntry = {
            serverId: created.id,
            browserBookmarkId: match.browserBookmarkId,
            collectionId: created.collectionId,
            url: created.url || match.url,
            name: created.name,
            isPinned: match.shouldPin,
            serverUpdatedAt: created.updatedAt,
            syncedAt: new Date().toISOString(),
          };
          syncEntries.push(newEntry);
          maps.byServerId.set(newEntry.serverId, newEntry);
          maps.byBookmarkId.set(newEntry.browserBookmarkId, newEntry);
          maps.byUrl.set(newEntry.url, newEntry);

          if (match.shouldPin) {
            try {
              await pinLink(baseUrl, apiKey, created.id);
            } catch {
              // Non-fatal
            }
          }
        }
      }

      // Handle existing links (deduplication)
      for (const existing of createResult.existing) {
        const match = toCreate.find((c) => c.url === existing.url);
        if (match) {
          const existingEntry: BookmarkSyncEntry = {
            serverId: existing.id,
            browserBookmarkId: match.browserBookmarkId,
            collectionId: existing.collectionId,
            url: existing.url || match.url,
            name: existing.name,
            isPinned: match.shouldPin,
            serverUpdatedAt: existing.updatedAt,
            syncedAt: new Date().toISOString(),
          };
          syncEntries.push(existingEntry);
          maps.byServerId.set(existingEntry.serverId, existingEntry);
          maps.byBookmarkId.set(existingEntry.browserBookmarkId, existingEntry);
          maps.byUrl.set(existingEntry.url, existingEntry);
        }
      }

      result.pushed += createResult.created.length;
    } catch (err) {
      result.errors.push(`Bulk create failed: ${err}`);
    }
  }

  // Update changed links
  for (const upd of toUpdate) {
    try {
      const updatedLink = await updateLink(baseUrl, apiKey, upd.serverId, {
        url: upd.url,
        name: upd.name,
        collection: upd.collectionId
          ? { id: upd.collectionId }
          : { name: 'Unorganized' },
      });
      const entry = maps.byServerId.get(upd.serverId);
      if (entry) {
        if (entry.url !== updatedLink.url) {
          maps.byUrl.delete(entry.url);
        }
        entry.url = updatedLink.url || upd.url;
        entry.name = updatedLink.name;
        entry.collectionId = updatedLink.collectionId;
        entry.serverUpdatedAt = updatedLink.updatedAt;
        entry.syncedAt = new Date().toISOString();
        maps.byUrl.set(entry.url, entry);
      }
      result.pushed++;
    } catch (err) {
      result.errors.push(`Update failed for link ${upd.serverId}: ${err}`);
    }
  }

  // Delete server links for bookmarks removed from browser
  const toDelete: number[] = [];
  for (const [bookmarkId, entry] of maps.byBookmarkId) {
    if (!seenBookmarkIds.has(bookmarkId)) {
      // Only delete within this browser's managed scope
      if (!managedCollectionIds.has(entry.collectionId)) continue;
      toDelete.push(entry.serverId);
    }
  }

  if (toDelete.length > 0) {
    try {
      await bulkDeleteLinks(baseUrl, apiKey, toDelete);
      for (const id of toDelete) {
        const entry = maps.byServerId.get(id);
        if (!entry) continue;
        maps.byServerId.delete(id);
        maps.byBookmarkId.delete(entry.browserBookmarkId);
        maps.byUrl.delete(entry.url);
      }
      for (let i = syncEntries.length - 1; i >= 0; i--) {
        if (toDelete.includes(syncEntries[i].serverId)) {
          syncEntries.splice(i, 1);
        }
      }
      result.deleted += toDelete.length;
    } catch (err) {
      result.errors.push(`Bulk delete failed: ${err}`);
    }
  }
}

function createSyncMaps(entries: BookmarkSyncEntry[]): {
  byServerId: Map<number, BookmarkSyncEntry>;
  byBookmarkId: Map<string, BookmarkSyncEntry>;
  byUrl: Map<string, BookmarkSyncEntry>;
} {
  return {
    byServerId: new Map(entries.map((entry) => [entry.serverId, entry])),
    byBookmarkId: new Map(
      entries.map((entry) => [entry.browserBookmarkId, entry])
    ),
    byUrl: new Map(entries.map((entry) => [entry.url, entry])),
  };
}

async function resolveRootFolderIds(): Promise<{
  bookmarksBarId: string;
}> {
  const rootChildren = await getBrowserBookmarkTree();
  return {
    bookmarksBarId: getBookmarksBarFolderId(rootChildren) || '1',
  };
}

async function getResolvedTargetFolderId(
  link: SyncLink,
  isPinned: boolean,
  folderMap: FolderCollectionMap,
  rootFolderId: string
): Promise<string | null> {
  const { bookmarksBarId } = await resolveRootFolderIds();
  // Pinned links go to Bookmarks Bar
  if (isPinned) {
    return bookmarksBarId;
  }

  // Map collection to browser folder
  const folderId = getBrowserFolderIdForCollection(
    folderMap,
    link.collectionId
  );
  if (folderId) return folderId;

  // Default: root sync folder
  return rootFolderId;
}

// Quick check if server has changes since last sync (cheap, no full sync)
export async function hasServerChanges(): Promise<boolean> {
  const config = await getConfig();
  if (!config.baseUrl || !config.apiKey) return false;

  const state = await getSyncState();
  if (!state.lastSyncTimestamp) return true;

  // If we don't have a root collection yet, assume there may be changes
  if (!config.rootCollectionId) return true;

  try {
    const status = await fetchSyncStatus(config.baseUrl, config.apiKey);
    // Build managed collection IDs from config + stored folder map
    const folderMap = await getFolderMap();
    const managedIds = getManagedCollectionIds(folderMap, config.rootCollectionId);

    // Only trigger sync if a managed collection has changed
    for (const col of status.collections) {
      if (
        managedIds.has(col.id) &&
        new Date(col.latestUpdate).getTime() >
          new Date(state.lastSyncTimestamp).getTime()
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
