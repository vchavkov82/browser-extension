import { getBrowser } from '../utils.ts';
import {
  getConfig,
  updateScopedBootstrapConfig,
} from '../config.ts';
import { getSyncState, updateSyncState } from '../cache.ts';
import {
  fetchCollections,
  createCollection,
  type ServerCollection,
} from './apiClient.ts';
import {
  detectBrowserIdentity,
  getManagedRootDescriptor,
} from '../browserIdentity.ts';
import type {
  BootstrapDiagnostic,
  BrowserIdentity,
  ManagedRootMetadata,
} from '../validators/config.ts';
import BookmarkTreeNode = chrome.bookmarks.BookmarkTreeNode;

const browser = getBrowser();

export interface BootstrapResult {
  browserIdentity: BrowserIdentity;
  managedRoot: ManagedRootMetadata;
  browserRootFolder: BookmarkTreeNode;
  serverCollection: ServerCollection;
  createdBrowserFolder: boolean;
  createdServerCollection: boolean;
}

function buildDiagnostic(
  phase: string,
  message: string
): BootstrapDiagnostic {
  return {
    phase,
    message,
    occurredAt: new Date().toISOString(),
  };
}

async function setBootstrapPhase(
  identity: BrowserIdentity,
  phase: string,
  partial?: {
    browserRootFolderId?: string;
    serverCollectionId?: number;
    lastError?: BootstrapDiagnostic;
    lastSuccessAt?: string;
  }
): Promise<void> {
  await updateSyncState({
    browserIdentity: identity,
    bootstrap: {
      phase,
      browserRootFolderId: partial?.browserRootFolderId,
      serverCollectionId: partial?.serverCollectionId,
      lastError: partial?.lastError,
      lastSuccessAt: partial?.lastSuccessAt,
    },
  });
}

async function getRootChildren(): Promise<BookmarkTreeNode[]> {
  const [root] = await browser.bookmarks.getTree();
  return root?.children ?? [];
}

function findManagedFolderInChildren(
  nodes: BookmarkTreeNode[] | undefined,
  parentId: string,
  managedRootName: string
): BookmarkTreeNode | undefined {
  if (!nodes) return undefined;
  return nodes.find(
    (node) => !node.url && node.parentId === parentId && node.title === managedRootName
  );
}

async function resolveBrowserRootFolder(
  descriptor: ReturnType<typeof getManagedRootDescriptor>,
  storedManagedRoot?: ManagedRootMetadata
): Promise<{
  folder: BookmarkTreeNode;
  created: boolean;
}> {
  const rootChildren = await getRootChildren();
  const container = rootChildren.find(
    (node) => node.id === descriptor.parentBookmarkContainerId
  );

  if (!container) {
    throw new Error(
      `Parent bookmark container ${descriptor.parentBookmarkContainerId} not found for ${descriptor.browserName}`
    );
  }

  if (storedManagedRoot?.browserRootFolderId) {
    try {
      const [existingFolder] = await browser.bookmarks.get(
        storedManagedRoot.browserRootFolderId
      );
      if (
        existingFolder &&
        !existingFolder.url &&
        existingFolder.parentId === descriptor.parentBookmarkContainerId &&
        existingFolder.title === descriptor.managedRootName
      ) {
        return { folder: existingFolder, created: false };
      }
    } catch {
      // Fall through to lookup/create.
    }
  }

  const matchedFolder = findManagedFolderInChildren(
    container.children,
    descriptor.parentBookmarkContainerId,
    descriptor.managedRootName
  );
  if (matchedFolder) {
    return { folder: matchedFolder, created: false };
  }

  const createdFolder = await browser.bookmarks.create({
    parentId: descriptor.parentBookmarkContainerId,
    title: descriptor.managedRootName,
  });
  return { folder: createdFolder, created: true };
}

function findManagedCollection(
  collections: ServerCollection[],
  managedRootName: string,
  storedCollectionId?: number
): ServerCollection | undefined {
  if (storedCollectionId) {
    const storedMatch = collections.find((collection) => collection.id === storedCollectionId);
    if (
      storedMatch &&
      storedMatch.name === managedRootName &&
      storedMatch.parentId == null
    ) {
      return storedMatch;
    }
  }

  return collections.find(
    (collection) => collection.name === managedRootName && collection.parentId == null
  );
}

async function resolveServerCollection(
  baseUrl: string,
  apiKey: string,
  managedRootName: string,
  storedManagedRoot?: ManagedRootMetadata
): Promise<{
  collection: ServerCollection;
  created: boolean;
}> {
  const collections = await fetchCollections(baseUrl, apiKey);
  const existingCollection = findManagedCollection(
    collections,
    managedRootName,
    storedManagedRoot?.serverCollectionId
  );

  if (existingCollection) {
    return { collection: existingCollection, created: false };
  }

  const createdCollection = await createCollection(baseUrl, apiKey, {
    name: managedRootName,
  });
  return { collection: createdCollection, created: true };
}

export async function bootstrapManagedRoot(): Promise<BootstrapResult> {
  const identity = detectBrowserIdentity();
  const descriptor = getManagedRootDescriptor(identity);
  const config = await getConfig();
  const state = await getSyncState();

  if (!config.baseUrl || !config.apiKey) {
    const diagnostic = buildDiagnostic('preflight', 'Linkwarden sync is not configured');
    await setBootstrapPhase(identity, 'failed', { lastError: diagnostic });
    throw new Error(diagnostic.message ?? 'Linkwarden sync is not configured');
  }

  await setBootstrapPhase(identity, 'resolving-browser-root');

  try {
    const browserRoot = await resolveBrowserRootFolder(
      descriptor,
      config.managedRoot
    );

    await setBootstrapPhase(identity, 'resolving-server-collection', {
      browserRootFolderId: browserRoot.folder.id,
    });

    const serverCollection = await resolveServerCollection(
      config.baseUrl,
      config.apiKey,
      descriptor.managedRootName,
      config.managedRoot
    );

    const lastResolvedAt = new Date().toISOString();
    const managedRoot: ManagedRootMetadata = {
      browser: identity,
      browserName: descriptor.browserName,
      managedRootName: descriptor.managedRootName,
      parentBookmarkContainerId: descriptor.parentBookmarkContainerId,
      browserRootFolderId: browserRoot.folder.id,
      serverCollectionId: serverCollection.collection.id,
      lastResolvedAt,
    };

    await updateScopedBootstrapConfig({
      browserIdentity: identity,
      managedRoot,
    });
    await setBootstrapPhase(identity, 'ready', {
      browserRootFolderId: browserRoot.folder.id,
      serverCollectionId: serverCollection.collection.id,
      lastSuccessAt: lastResolvedAt,
      lastError: undefined,
    });

    console.log(
      `[Sync Bootstrap] ${descriptor.browserName} root ready: browserFolder=${browserRoot.folder.id} serverCollection=${serverCollection.collection.id} createdBrowserFolder=${browserRoot.created} createdServerCollection=${serverCollection.created}`
    );

    return {
      browserIdentity: identity,
      managedRoot,
      browserRootFolder: browserRoot.folder,
      serverCollection: serverCollection.collection,
      createdBrowserFolder: browserRoot.created,
      createdServerCollection: serverCollection.created,
    };
  } catch (error) {
    const syncState = state.bootstrap;
    const diagnostic = buildDiagnostic(
      syncState?.phase ?? 'bootstrap',
      error instanceof Error ? error.message : 'Unknown bootstrap error'
    );

    await setBootstrapPhase(identity, 'failed', {
      browserRootFolderId: config.managedRoot?.browserRootFolderId,
      serverCollectionId: config.managedRoot?.serverCollectionId,
      lastError: diagnostic,
      lastSuccessAt: syncState?.lastSuccessAt,
    });

    console.error(`[Sync Bootstrap] ${descriptor.browserName} bootstrap failed:`, error);
    throw error;
  }
}
