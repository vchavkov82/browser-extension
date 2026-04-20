// Maps browser bookmark folders <-> Linkwarden collections bidirectionally.
// Persists mapping in chrome.storage.local.
// Each browser instance (Firefox / Edge) owns a dedicated root collection so
// the two sync engines never touch each other's data.

import { getBrowser, getStorageItem, setStorageItem } from '../utils.ts';
import { saveConfig, getConfig } from '../config.ts';
import {
  fetchCollections,
  createCollection,
  type ServerCollection,
} from './apiClient.ts';
import BookmarkTreeNode = chrome.bookmarks.BookmarkTreeNode;

const browser = getBrowser();

const FOLDER_MAP_KEY = 'lw_folder_collection_map';

// Well-known browser folder IDs
// Chrome: "0" = root, "1" = Bookmarks Bar, "2" = Other Bookmarks, "3" = Mobile Bookmarks
// Firefox: "root________", "toolbar_____", "unfiled_____", "mobile______"
const BOOKMARKS_BAR_IDS = ['1', 'toolbar_____'];
const OTHER_BOOKMARKS_IDS = ['2', 'unfiled_____'];
const MOBILE_BOOKMARKS_IDS = ['3', 'mobile______'];

export interface FolderMapEntry {
  browserFolderId: string;
  browserFolderName: string;
  collectionId: number;
  collectionName: string;
  parentBrowserFolderId?: string;
  isManagedRoot?: boolean;
}

export interface FolderCollectionMap {
  entries: FolderMapEntry[];
}

export function isBookmarksBar(id: string): boolean {
  return BOOKMARKS_BAR_IDS.includes(id);
}

export function isOtherBookmarks(id: string): boolean {
  return OTHER_BOOKMARKS_IDS.includes(id);
}

export function isMobileBookmarks(id: string): boolean {
  return MOBILE_BOOKMARKS_IDS.includes(id);
}

export function isRootFolder(id: string): boolean {
  return (
    id === '0' ||
    id === 'root________' ||
    isBookmarksBar(id) ||
    isOtherBookmarks(id) ||
    isMobileBookmarks(id)
  );
}

export async function getFolderMap(): Promise<FolderCollectionMap> {
  const stored = await getStorageItem(FOLDER_MAP_KEY);
  return stored ? JSON.parse(stored) : { entries: [] };
}

export async function saveFolderMap(map: FolderCollectionMap): Promise<void> {
  await setStorageItem(FOLDER_MAP_KEY, JSON.stringify(map));
}

export function getCollectionIdForFolder(
  map: FolderCollectionMap,
  browserFolderId: string
): number | undefined {
  return map.entries.find((e) => e.browserFolderId === browserFolderId)
    ?.collectionId;
}

export function getBrowserFolderIdForCollection(
  map: FolderCollectionMap,
  collectionId: number
): string | undefined {
  return map.entries.find((e) => e.collectionId === collectionId)
    ?.browserFolderId;
}

export function getBookmarksBarFolderId(
  rootChildren: BookmarkTreeNode[]
): string | undefined {
  return rootChildren.find((child) => isBookmarksBar(child.id))?.id;
}

export function getOtherBookmarksFolderId(
  rootChildren: BookmarkTreeNode[]
): string | undefined {
  return rootChildren.find((child) => isOtherBookmarks(child.id))?.id;
}

// Returns the Set of collection IDs managed by this browser instance.
// Includes the root collection itself plus all descendants in the folder map.
export function getManagedCollectionIds(
  map: FolderCollectionMap,
  rootCollectionId: number
): Set<number> {
  const ids = new Set<number>([rootCollectionId]);
  for (const e of map.entries) ids.add(e.collectionId);
  return ids;
}

// Browser label for each browser type
function browserLabel(browserType: string): string {
  if (browserType === 'firefox') return 'Firefox';
  if (browserType === 'edge') return 'Edge';
  return 'Chrome';
}

// Find a folder by ID anywhere in the bookmark tree (depth-first).
export function findFolderById(
  nodes: BookmarkTreeNode[],
  id: string
): BookmarkTreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findFolderById(node.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

// Ensure this browser's root collection + browser folder exist.
// Idempotent — safe to call on every sync.
export async function ensureRootCollection(
  baseUrl: string,
  apiKey: string,
  browserType: string
): Promise<{ collectionId: number; folderId: string }> {
  const config = await getConfig();
  const label = browserLabel(browserType);

  // Fast path: both IDs already cached — verify the browser folder still exists
  if (config.rootCollectionId && config.rootFolderId) {
    const rootTree = await browser.bookmarks.getTree();
    const folderStillExists = !!findFolderById(rootTree, config.rootFolderId);
    if (folderStillExists) {
      return {
        collectionId: config.rootCollectionId,
        folderId: config.rootFolderId,
      };
    }
    // Folder was deleted — clear cache and fall through to re-bootstrap
    await saveConfig({ ...config, rootCollectionId: null, rootFolderId: null });
  }

  // --- Server collection ---
  const serverCollections = await fetchCollections(baseUrl, apiKey);
  let rootCollection = serverCollections.find(
    (c) => c.name === label && !c.parentId
  );
  if (!rootCollection) {
    rootCollection = await createCollection(baseUrl, apiKey, { name: label });
  }

  // --- Browser folder ---
  const rootTree = await browser.bookmarks.getTree();
  const otherBookmarksId =
    getOtherBookmarksFolderId(rootTree[0].children || []) || '2';

  // Look for an existing folder named after the browser directly under Other Bookmarks
  const otherNode = findFolderById(rootTree, otherBookmarksId);
  let rootBrowserFolder = otherNode?.children?.find(
    (n) => !n.url && n.title === label
  );
  if (!rootBrowserFolder) {
    rootBrowserFolder = await browser.bookmarks.create({
      parentId: otherBookmarksId,
      title: label,
    });
  }

  // Persist to config
  await saveConfig({
    ...config,
    rootCollectionId: rootCollection.id,
    rootFolderId: rootBrowserFolder.id,
  });

  return {
    collectionId: rootCollection.id,
    folderId: rootBrowserFolder.id,
  };
}

// Extracts all user-created sub-folders that are descendants of the given nodes.
function extractFolders(
  nodes: BookmarkTreeNode[],
  parentId?: string
): Array<{ id: string; title: string; parentId?: string }> {
  const folders: Array<{ id: string; title: string; parentId?: string }> = [];
  for (const node of nodes) {
    if (!node.url && node.children) {
      if (!isRootFolder(node.id)) {
        folders.push({ id: node.id, title: node.title, parentId });
      }
      folders.push(
        ...extractFolders(
          node.children,
          isRootFolder(node.id) ? undefined : node.id
        )
      );
    }
  }
  return folders;
}

function buildFolderPath(
  folder: { id: string; title: string; parentId?: string },
  foldersById: Map<string, { id: string; title: string; parentId?: string }>
): string {
  const parts: string[] = [folder.title];
  let current = folder;
  while (current.parentId) {
    const parent = foldersById.get(current.parentId);
    if (!parent) break;
    parts.unshift(parent.title);
    current = parent;
  }
  return parts.join(' > ');
}

function buildCollectionPath(
  collection: ServerCollection,
  collectionsById: Map<number, ServerCollection>
): string {
  const parts: string[] = [collection.name];
  let current = collection;
  while (current.parentId) {
    const parent = collectionsById.get(current.parentId);
    if (!parent) break;
    parts.unshift(parent.name);
    current = parent;
  }
  return parts.join(' > ');
}

// Returns the root collection ID and all its descendants as a flat Set.
export function getCollectionDescendantIds(
  allCollections: ServerCollection[],
  rootId: number
): Set<number> {
  const ids = new Set<number>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of allCollections) {
      if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) {
        ids.add(c.id);
        changed = true;
      }
    }
  }
  return ids;
}

export function getScopedServerCollections(
  collections: ServerCollection[],
  rootCollectionId: number
): ServerCollection[] {
  const allowedIds = getCollectionDescendantIds(collections, rootCollectionId);
  return collections.filter((collection) => allowedIds.has(collection.id));
}

export function isFolderMapEntryInScope(
  entry: FolderMapEntry,
  params: {
    allowedBrowserFolderIds?: ReadonlySet<string>;
    allowedCollectionIds?: ReadonlySet<number>;
  }
): boolean {
  if (
    params.allowedBrowserFolderIds &&
    !params.allowedBrowserFolderIds.has(entry.browserFolderId)
  ) {
    return false;
  }

  if (
    params.allowedCollectionIds &&
    !params.allowedCollectionIds.has(entry.collectionId)
  ) {
    return false;
  }

  if (
    entry.parentBrowserFolderId &&
    params.allowedBrowserFolderIds &&
    !params.allowedBrowserFolderIds.has(entry.parentBrowserFolderId)
  ) {
    return false;
  }

  return true;
}

export function filterFolderMapToScope(
  map: FolderCollectionMap,
  params: {
    allowedBrowserFolderIds?: ReadonlySet<string>;
    allowedCollectionIds?: ReadonlySet<number>;
  }
): FolderCollectionMap {
  return {
    entries: map.entries.filter((entry) => isFolderMapEntryInScope(entry, params)),
  };
}

// Full reconciliation scoped to this browser's root collection + browser folder.
// Only processes folders/collections that are descendants of the roots.
export async function reconcileFolderMap(
  baseUrl: string,
  apiKey: string,
  rootCollectionId: number,
  rootFolderId: string
): Promise<FolderCollectionMap> {
  const [root] = await browser.bookmarks.getTree();
  const serverCollections = await fetchCollections(baseUrl, apiKey);

  const collectionsById = new Map(serverCollections.map((c) => [c.id, c]));

  // Only work with collections in this browser's subtree
  const managedServerIds = getCollectionDescendantIds(serverCollections, rootCollectionId);
  const managedCollections = serverCollections.filter((c) => managedServerIds.has(c.id));

  const collectionsByPath = new Map(
    managedCollections.map((c) => [
      buildCollectionPath(c, collectionsById),
      c,
    ])
  );

  const existingMap = await getFolderMap();
  const newMap: FolderCollectionMap = { entries: [] };

  // Extract user-created folders that are children of the root browser folder
  const rootBrowserNode = findFolderById([root], rootFolderId);
  const allFolders: Array<{ id: string; title: string; parentId?: string }> = [];
  if (rootBrowserNode?.children) {
    allFolders.push(...extractFolders(rootBrowserNode.children, rootFolderId));
  }
  const foldersById = new Map(allFolders.map((folder) => [folder.id, folder]));

  // Match browser sub-folders → server collections (or create new server collections)
  for (const folder of allFolders) {
    const existingEntry = existingMap.entries.find(
      (e) => e.browserFolderId === folder.id
    );
    if (existingEntry && managedServerIds.has(existingEntry.collectionId)) {
      if (collectionsById.has(existingEntry.collectionId)) {
        newMap.entries.push(existingEntry);
        continue;
      }
    }

    const folderPath = buildFolderPath(folder, foldersById);
    const matchedCollection = collectionsByPath.get(folderPath);
    if (matchedCollection) {
      newMap.entries.push({
        browserFolderId: folder.id,
        browserFolderName: folder.title,
        collectionId: matchedCollection.id,
        collectionName: matchedCollection.name,
        parentBrowserFolderId: folder.parentId,
      });
      continue;
    }

    // Create new child collection under the appropriate parent
    const parentEntry = folder.parentId
      ? newMap.entries.find((e) => e.browserFolderId === folder.parentId)
      : undefined;

    try {
      const newCollection = await createCollection(baseUrl, apiKey, {
        name: folder.title,
        parentId: parentEntry?.collectionId ?? rootCollectionId,
      });
      newMap.entries.push({
        browserFolderId: folder.id,
        browserFolderName: folder.title,
        collectionId: newCollection.id,
        collectionName: newCollection.name,
        parentBrowserFolderId: folder.parentId,
      });
    } catch (err) {
      console.error(`Failed to create collection for folder "${folder.title}":`, err);
    }
  }

  // Create browser folders for unmatched managed server collections (excluding root itself)
  const mappedCollectionIds = new Set(newMap.entries.map((e) => e.collectionId));
  mappedCollectionIds.add(rootCollectionId);

  for (const collection of managedCollections) {
    if (collection.id === rootCollectionId) continue;
    if (mappedCollectionIds.has(collection.id)) continue;

    try {
      const parentMapEntry = collection.parentId
        ? newMap.entries.find((e) => e.collectionId === collection.parentId)
        : undefined;

      const newFolder = await browser.bookmarks.create({
        parentId: parentMapEntry?.browserFolderId ?? rootFolderId,
        title: collection.name,
      });

      newMap.entries.push({
        browserFolderId: newFolder.id,
        browserFolderName: collection.name,
        collectionId: collection.id,
        collectionName: collection.name,
        parentBrowserFolderId: parentMapEntry?.browserFolderId ?? rootFolderId,
      });
    } catch (err) {
      console.error(
        `Failed to create browser folder for collection "${collection.name}":`,
        err
      );
    }
  }

  await saveFolderMap(newMap);
  return newMap;
}
