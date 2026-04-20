import { getBrowser, getStorageItem, setStorageItem } from './utils.ts';
import {
  detectBrowserIdentity,
  getManagedRootDescriptor,
} from './browserIdentity.ts';
import type {
  BootstrapDiagnostic,
  BrowserIdentity,
  SyncDiagnostic,
  SyncDiagnosticRunMetrics,
} from './validators/config.ts';
import BookmarkTreeNode = chrome.bookmarks.BookmarkTreeNode;

const browser = getBrowser();

const BOOKMARKS_METADATA_KEY = 'lw_bookmarks_metadata_cache';
const SYNC_STATE_KEY = 'lw_sync_state';

// New sync-aware metadata schema
export interface BookmarkSyncEntry {
  serverId: number;
  browserBookmarkId: string;
  collectionId: number;
  url: string;
  name: string;
  isPinned: boolean;
  serverUpdatedAt: string;
  syncedAt: string;
}

export interface SyncState {
  lastSyncTimestamp: string | null;
  syncInProgress: boolean;
  suppressBrowserEvents: boolean;
  browserIdentity?: BrowserIdentity;
  bootstrap?: {
    phase?: string;
    lastSuccessAt?: string;
    browserRootFolderId?: string;
    serverCollectionId?: number;
    lastError?: BootstrapDiagnostic;
  };
  sync?: Partial<SyncDiagnostic>;
}

function mergeSyncRunMetrics(
  current?: SyncDiagnosticRunMetrics,
  partial?: SyncDiagnosticRunMetrics
): SyncDiagnosticRunMetrics | undefined {
  if (!current && !partial) {
    return undefined;
  }

  return {
    ...(current ?? {}),
    ...(partial ?? {}),
    mutated: {
      ...(current?.mutated ?? {}),
      ...(partial?.mutated ?? {}),
    },
  };
}

export interface BrowserBookmarkRecord {
  id: string;
  url: string;
  title: string;
  parentId?: string;
}

const DEFAULT_SYNC_STATE: SyncState = {
  lastSyncTimestamp: null,
  syncInProgress: false,
  suppressBrowserEvents: false,
  browserIdentity: detectBrowserIdentity(),
  bootstrap: {
    phase: 'idle',
  },
  sync: {
    phase: 'idle',
  },
};

function getDefaultSyncState(
  identity: BrowserIdentity = detectBrowserIdentity()
): SyncState {
  const descriptor = getManagedRootDescriptor(identity);

  return {
    ...DEFAULT_SYNC_STATE,
    browserIdentity: identity,
    bootstrap: {
      phase: 'idle',
      browserRootFolderId: undefined,
      serverCollectionId: undefined,
      lastError: undefined,
      lastSuccessAt: undefined,
    },
    sync: {
      phase: 'idle',
      lastAttemptAt: undefined,
      lastSuccessAt: undefined,
      lastError: undefined,
      run: undefined,
      pull: undefined,
      push: undefined,
    },
    // keep descriptor reachable by later tasks via config; state stores ids + diagnostics
    ...(descriptor ? {} : {}),
  };
}

// --- Sync State ---

export async function getSyncState(): Promise<SyncState> {
  const stored = await getStorageItem(SYNC_STATE_KEY);
  return stored
    ? {
        ...getDefaultSyncState(),
        ...JSON.parse(stored),
        bootstrap: {
          ...getDefaultSyncState().bootstrap,
          ...JSON.parse(stored).bootstrap,
        },
        sync: {
          ...getDefaultSyncState().sync,
          ...JSON.parse(stored).sync,
          run: mergeSyncRunMetrics(
            getDefaultSyncState().sync?.run,
            JSON.parse(stored).sync?.run
          ),
        },
      }
    : getDefaultSyncState();
}

export async function saveSyncState(state: SyncState): Promise<void> {
  await setStorageItem(
    SYNC_STATE_KEY,
    JSON.stringify({
      ...getDefaultSyncState(state.browserIdentity),
      ...state,
      bootstrap: {
        ...getDefaultSyncState(state.browserIdentity).bootstrap,
        ...state.bootstrap,
      },
      sync: {
        ...getDefaultSyncState(state.browserIdentity).sync,
        ...state.sync,
        run: mergeSyncRunMetrics(
          getDefaultSyncState(state.browserIdentity).sync?.run,
          state.sync?.run
        ),
      },
    })
  );
}

export async function updateSyncState(
  partial: Partial<SyncState>
): Promise<SyncState> {
  const current = await getSyncState();
  const updated = {
    ...current,
    ...partial,
    bootstrap: {
      ...current.bootstrap,
      ...partial.bootstrap,
    },
    sync: {
      ...current.sync,
      ...partial.sync,
      run: mergeSyncRunMetrics(current.sync?.run, partial.sync?.run),
    },
  };
  await saveSyncState(updated);
  return updated;
}

export async function resetBootstrapState(
  identity: BrowserIdentity = detectBrowserIdentity()
): Promise<SyncState> {
  const current = await getSyncState();
  const updated = {
    ...current,
    browserIdentity: identity,
    bootstrap: {
      ...getDefaultSyncState(identity).bootstrap,
    },
  };
  await saveSyncState(updated);
  return updated;
}

// --- Bookmark Sync Entries ---

export async function getSyncEntries(): Promise<BookmarkSyncEntry[]> {
  const stored = await getStorageItem(BOOKMARKS_METADATA_KEY);
  if (!stored) return [];
  const parsed = JSON.parse(stored);
  // Migrate from old format if needed
  if (Array.isArray(parsed) && parsed.length > 0 && 'id' in parsed[0] && !('serverId' in parsed[0])) {
    return migrateOldFormat(parsed);
  }
  return parsed;
}

export async function saveSyncEntries(
  entries: BookmarkSyncEntry[]
): Promise<void> {
  await setStorageItem(BOOKMARKS_METADATA_KEY, JSON.stringify(entries));
}

export async function clearSyncEntries(): Promise<void> {
  await setStorageItem(BOOKMARKS_METADATA_KEY, JSON.stringify([]));
}

// Lookup by server link ID
export async function getSyncEntryByServerId(
  serverId: number
): Promise<BookmarkSyncEntry | undefined> {
  const entries = await getSyncEntries();
  return entries.find((e) => e.serverId === serverId);
}

// Lookup by browser bookmark ID
export async function getSyncEntryByBookmarkId(
  bookmarkId: string
): Promise<BookmarkSyncEntry | undefined> {
  const entries = await getSyncEntries();
  return entries.find((e) => e.browserBookmarkId === bookmarkId);
}

// Lookup by URL
export async function getSyncEntryByUrl(
  url: string
): Promise<BookmarkSyncEntry | undefined> {
  const entries = await getSyncEntries();
  return entries.find((e) => e.url === url);
}

// Upsert a sync entry (by serverId)
export async function upsertSyncEntry(
  entry: BookmarkSyncEntry
): Promise<void> {
  const entries = await getSyncEntries();
  const index = entries.findIndex((e) => e.serverId === entry.serverId);
  if (index !== -1) {
    entries[index] = entry;
  } else {
    entries.push(entry);
  }
  await saveSyncEntries(entries);
}

// Remove a sync entry by server ID
export async function removeSyncEntryByServerId(
  serverId: number
): Promise<void> {
  const entries = await getSyncEntries();
  const filtered = entries.filter((e) => e.serverId !== serverId);
  await saveSyncEntries(filtered);
}

// Remove a sync entry by browser bookmark ID
export async function removeSyncEntryByBookmarkId(
  bookmarkId: string
): Promise<void> {
  const entries = await getSyncEntries();
  const filtered = entries.filter((e) => e.browserBookmarkId !== bookmarkId);
  await saveSyncEntries(filtered);
}

export function buildScopedSyncEntryMaps(entries: BookmarkSyncEntry[]): {
  byServerId: Map<number, BookmarkSyncEntry>;
  byBookmarkId: Map<string, BookmarkSyncEntry>;
  byUrl: Map<string, BookmarkSyncEntry>;
} {
  return {
    byServerId: new Map(entries.map((e) => [e.serverId, e])),
    byBookmarkId: new Map(entries.map((e) => [e.browserBookmarkId, e])),
    byUrl: new Map(entries.map((e) => [e.url, e])),
  };
}

// Build Maps for fast lookups during sync
export async function getSyncMaps(): Promise<{
  byServerId: Map<number, BookmarkSyncEntry>;
  byBookmarkId: Map<string, BookmarkSyncEntry>;
  byUrl: Map<string, BookmarkSyncEntry>;
}> {
  const entries = await getSyncEntries();
  return buildScopedSyncEntryMaps(entries);
}

// --- Browser Bookmarks Helpers ---

export async function createBookmarkInBrowser(
  url: string,
  title: string,
  parentId?: string
): Promise<BookmarkTreeNode> {
  return await browser.bookmarks.create({ url, title, parentId });
}

export async function updateBookmarkInBrowser(
  bookmarkId: string,
  changes: { url?: string; title?: string }
): Promise<BookmarkTreeNode> {
  return await browser.bookmarks.update(bookmarkId, changes);
}

export async function removeBookmarkFromBrowser(
  bookmarkId: string
): Promise<void> {
  try {
    await browser.bookmarks.remove(bookmarkId);
  } catch (err) {
    // Bookmark may already be removed
    console.warn(`Failed to remove bookmark ${bookmarkId}:`, err);
  }
}

export async function moveBookmarkInBrowser(
  bookmarkId: string,
  destination: { parentId?: string; index?: number }
): Promise<BookmarkTreeNode> {
  return await browser.bookmarks.move(bookmarkId, destination);
}

export async function getBrowserBookmarkTree(): Promise<BookmarkTreeNode[]> {
  const [root] = await browser.bookmarks.getTree();
  return root.children || [];
}

export function findBookmarkNodeById(
  nodes: BookmarkTreeNode[],
  nodeId: string
): BookmarkTreeNode | undefined {
  for (const node of nodes) {
    if (node.id === nodeId) {
      return node;
    }
    if (node.children) {
      const match = findBookmarkNodeById(node.children, nodeId);
      if (match) {
        return match;
      }
    }
  }
  return undefined;
}

export function collectBookmarks(
  nodes: BookmarkTreeNode[],
  accumulator: BrowserBookmarkRecord[]
): void {
  for (const node of nodes) {
    if (node.url) {
      accumulator.push({
        id: node.id,
        url: node.url,
        title: node.title,
        parentId: node.parentId,
      });
    } else if (node.children) {
      collectBookmarks(node.children, accumulator);
    }
  }
}

export function collectBookmarksInSubtree(
  rootNode: BookmarkTreeNode | undefined
): BrowserBookmarkRecord[] {
  if (!rootNode?.children) {
    return [];
  }

  const bookmarks: BrowserBookmarkRecord[] = [];
  collectBookmarks(rootNode.children, bookmarks);
  return bookmarks;
}

export function getBrowserDescendantFolderIds(
  rootNode: BookmarkTreeNode | undefined
): Set<string> {
  const folderIds = new Set<string>();

  if (!rootNode) {
    return folderIds;
  }

  const visit = (node: BookmarkTreeNode): void => {
    if (!node.url) {
      folderIds.add(node.id);
      for (const child of node.children ?? []) {
        visit(child);
      }
    }
  };

  visit(rootNode);
  return folderIds;
}

export function isBookmarkInsideManagedRoot(
  bookmarkId: string,
  tree: BookmarkTreeNode[],
  browserRootFolderId?: string
): boolean {
  if (!browserRootFolderId) {
    return false;
  }

  const rootNode = findBookmarkNodeById(tree, browserRootFolderId);
  if (!rootNode) {
    return false;
  }

  const bookmark = findBookmarkNodeById([rootNode], bookmarkId);
  return Boolean(bookmark?.url);
}

// Out-of-scope cache entries are intentionally ignored rather than repaired.
// Later sync phases should only reuse entries that still resolve inside the active
// managed browser root + server collection pair.
export function isSyncEntryInScope(
  entry: BookmarkSyncEntry,
  params: {
    browserTree: BookmarkTreeNode[];
    browserRootFolderId?: string;
    allowedCollectionIds?: ReadonlySet<number>;
  }
): boolean {
  if (!params.browserRootFolderId) {
    return false;
  }

  if (
    params.allowedCollectionIds &&
    !params.allowedCollectionIds.has(entry.collectionId)
  ) {
    return false;
  }

  const rootNode = findBookmarkNodeById(params.browserTree, params.browserRootFolderId);
  if (!rootNode) {
    return false;
  }

  const bookmark = findBookmarkNodeById([rootNode], entry.browserBookmarkId);
  return Boolean(bookmark?.url);
}

export function filterSyncEntriesToScope(
  entries: BookmarkSyncEntry[],
  params: {
    browserTree: BookmarkTreeNode[];
    browserRootFolderId?: string;
    allowedCollectionIds?: ReadonlySet<number>;
  }
): BookmarkSyncEntry[] {
  return entries.filter((entry) => isSyncEntryInScope(entry, params));
}

// --- Migration from old format ---

interface OldBookmarkMetadata {
  id: number;
  collectionId: number;
  bookmarkId?: string;
  url: string;
  name: string;
  description: string;
  tags: Array<{ name: string }>;
}

function migrateOldFormat(old: OldBookmarkMetadata[]): BookmarkSyncEntry[] {
  return old
    .filter((o) => o.bookmarkId && o.url)
    .map((o) => ({
      serverId: o.id,
      browserBookmarkId: o.bookmarkId!,
      collectionId: o.collectionId,
      url: o.url,
      name: o.name || '',
      isPinned: false,
      serverUpdatedAt: new Date().toISOString(),
      syncedAt: new Date().toISOString(),
    }));
}

// --- Legacy compatibility re-exports ---
// These allow existing code to keep working during transition.

export type bookmarkMetadata = OldBookmarkMetadata;

export async function getBookmarksMetadata(): Promise<OldBookmarkMetadata[]> {
  const stored = await getStorageItem(BOOKMARKS_METADATA_KEY);
  return stored ? JSON.parse(stored) : [];
}

export async function saveBookmarksMetadata(
  bookmarksMetadata: OldBookmarkMetadata[]
): Promise<void> {
  await setStorageItem(
    BOOKMARKS_METADATA_KEY,
    JSON.stringify(bookmarksMetadata)
  );
}

export async function clearBookmarksMetadata(): Promise<void> {
  await clearSyncEntries();
}

export async function saveBookmarkMetadata(
  bookmarkMetadata: OldBookmarkMetadata
): Promise<void> {
  const bookmarksMetadata = await getBookmarksMetadata();
  const index = bookmarksMetadata.findIndex((b) => b.id === bookmarkMetadata.id);
  if (index !== -1) {
    bookmarksMetadata[index] = bookmarkMetadata;
  } else {
    bookmarksMetadata.push(bookmarkMetadata);
  }
  await saveBookmarksMetadata(bookmarksMetadata);
}

export async function deleteBookmarkMetadata(
  id: string | undefined
): Promise<void> {
  if (!id) return;
  const bookmarksMetadata = await getBookmarksMetadata();
  const filtered = bookmarksMetadata.filter((b) => b.bookmarkId !== id);
  await saveBookmarksMetadata(filtered);
}

export async function getBookmarkMetadataByBookmarkId(
  bookmarkId: string
): Promise<OldBookmarkMetadata | undefined> {
  const bookmarksMetadata = await getBookmarksMetadata();
  return bookmarksMetadata.find((b) => b.bookmarkId === bookmarkId);
}

export async function getBookmarkMetadataByUrl(
  url: string
): Promise<OldBookmarkMetadata | undefined> {
  const bookmarksMetadata = await getBookmarksMetadata();
  return bookmarksMetadata.find((b) => b.url === url);
}
