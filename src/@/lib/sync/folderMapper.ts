// Maps browser bookmark folders <-> Linkwarden collections bidirectionally.
// Persists mapping in chrome.storage.local.

import { getBrowser, getStorageItem, setStorageItem } from '../utils.ts';
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

// Extracts all user-created sub-folders from browser bookmark tree
function extractFolders(
  nodes: BookmarkTreeNode[],
  parentId?: string
): Array<{ id: string; title: string; parentId?: string }> {
  const folders: Array<{ id: string; title: string; parentId?: string }> = [];
  for (const node of nodes) {
    if (!node.url && node.children) {
      // It's a folder
      if (!isRootFolder(node.id)) {
        folders.push({ id: node.id, title: node.title, parentId });
      }
      // Recurse into sub-folders (but not root-level special folders as parents)
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

// Build a path key for matching: "parent > child > folder"
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

// Full reconciliation: sync browser folders <-> server collections
export async function reconcileFolderMap(
  baseUrl: string,
  apiKey: string
): Promise<FolderCollectionMap> {
  const [root] = await browser.bookmarks.getTree();
  const serverCollections = await fetchCollections(baseUrl, apiKey);

  const collectionsById = new Map(
    serverCollections.map((c) => [c.id, c])
  );
  const collectionsByPath = new Map(
    serverCollections.map((c) => [
      buildCollectionPath(c, collectionsById),
      c,
    ])
  );

  const existingMap = await getFolderMap();
  const newMap: FolderCollectionMap = { entries: [] };

  // Ensure "Mobile Bookmarks" collection exists on server
  let mobileCollection = serverCollections.find(
    (c) => c.name === 'Mobile Bookmarks' && !c.parentId
  );

  // Extract user-created folders from all top-level bookmark nodes
  const allFolders: Array<{
    id: string;
    title: string;
    parentId?: string;
  }> = [];
  if (root.children) {
    for (const topLevel of root.children) {
      if (topLevel.children) {
        allFolders.push(...extractFolders(topLevel.children));
      }
    }
  }
  const foldersById = new Map(allFolders.map((folder) => [folder.id, folder]));

  // Match browser folders → server collections (or create new ones)
  for (const folder of allFolders) {
    // Check existing mapping first
    const existingEntry = existingMap.entries.find(
      (e) => e.browserFolderId === folder.id
    );
    if (existingEntry) {
      // Verify collection still exists
      if (collectionsById.has(existingEntry.collectionId)) {
        newMap.entries.push(existingEntry);
        continue;
      }
    }

    // Try matching by full path so nested folders map correctly.
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

    // Create new collection on server
    const parentEntry = folder.parentId
      ? newMap.entries.find((e) => e.browserFolderId === folder.parentId)
      : undefined;

    try {
      const newCollection = await createCollection(baseUrl, apiKey, {
        name: folder.title,
        parentId: parentEntry?.collectionId,
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

  // Create browser folders for unmatched server collections
  const mappedCollectionIds = new Set(newMap.entries.map((e) => e.collectionId));

  // Find "Other Bookmarks" folder as the default parent for new folders
  const otherBookmarksId = getOtherBookmarksFolderId(root.children || []) || '2';

  for (const collection of serverCollections) {
    if (mappedCollectionIds.has(collection.id)) continue;
    if (collection.name === 'Unorganized') continue; // Don't create folder for default

    // Create browser folder
    try {
      const parentMapEntry = collection.parentId
        ? newMap.entries.find((e) => e.collectionId === collection.parentId)
        : undefined;

      const newFolder = await browser.bookmarks.create({
        parentId: parentMapEntry?.browserFolderId || otherBookmarksId,
        title: collection.name,
      });

      newMap.entries.push({
        browserFolderId: newFolder.id,
        browserFolderName: collection.name,
        collectionId: collection.id,
        collectionName: collection.name,
        parentBrowserFolderId:
          parentMapEntry?.browserFolderId || otherBookmarksId,
      });
    } catch (err) {
      console.error(
        `Failed to create browser folder for collection "${collection.name}":`,
        err
      );
    }
  }

  // Handle Mobile Bookmarks collection
  if (!mobileCollection) {
    try {
      mobileCollection = await createCollection(baseUrl, apiKey, {
        name: 'Mobile Bookmarks',
      });
    } catch (err) {
      console.error('Failed to create Mobile Bookmarks collection:', err);
    }
  }

  await saveFolderMap(newMap);
  return newMap;
}
