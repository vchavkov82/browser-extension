import { getBrowser, getStorageItem, setStorageItem } from './utils.ts';
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
}

const DEFAULT_SYNC_STATE: SyncState = {
  lastSyncTimestamp: null,
  syncInProgress: false,
  suppressBrowserEvents: false,
};

// --- Sync State ---

export async function getSyncState(): Promise<SyncState> {
  const stored = await getStorageItem(SYNC_STATE_KEY);
  return stored ? JSON.parse(stored) : { ...DEFAULT_SYNC_STATE };
}

export async function saveSyncState(state: SyncState): Promise<void> {
  await setStorageItem(SYNC_STATE_KEY, JSON.stringify(state));
}

export async function updateSyncState(
  partial: Partial<SyncState>
): Promise<SyncState> {
  const current = await getSyncState();
  const updated = { ...current, ...partial };
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

// Build Maps for fast lookups during sync
export async function getSyncMaps(): Promise<{
  byServerId: Map<number, BookmarkSyncEntry>;
  byBookmarkId: Map<string, BookmarkSyncEntry>;
  byUrl: Map<string, BookmarkSyncEntry>;
}> {
  const entries = await getSyncEntries();
  return {
    byServerId: new Map(entries.map((e) => [e.serverId, e])),
    byBookmarkId: new Map(entries.map((e) => [e.browserBookmarkId, e])),
    byUrl: new Map(entries.map((e) => [e.url, e])),
  };
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

// Walk the full bookmark tree and collect all bookmark URLs (not folders)
export function collectBookmarks(
  nodes: BookmarkTreeNode[],
  accumulator: Array<{
    id: string;
    url: string;
    title: string;
    parentId?: string;
  }>
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
