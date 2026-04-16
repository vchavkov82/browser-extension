import {
  getBrowser,
  getCurrentTabInfo,
  updateBadge,
} from '../../@/lib/utils.ts';
import { getConfig, isConfigured } from '../../@/lib/config.ts';
import { postLinkFetch } from '../../@/lib/actions/links.ts';
import {
  bookmarkMetadata,
  getBookmarksMetadata,
  saveBookmarkMetadata,
  getSyncState,
} from '../../@/lib/cache.ts';
import { enqueueSyncEvent } from '../../@/lib/sync/syncQueue.ts';
import {
  initSyncScheduler,
  handleAlarm,
} from '../../@/lib/sync/syncScheduler.ts';
import { performSync } from '../../@/lib/sync/syncEngine.ts';
import ContextType = chrome.contextMenus.ContextType;
import OnClickData = chrome.contextMenus.OnClickData;
import OnInputEnteredDisposition = chrome.omnibox.OnInputEnteredDisposition;
import BookmarkTreeNode = chrome.bookmarks.BookmarkTreeNode;

const browser = getBrowser();

// --- Bookmark Sync Event Listeners ---

browser.bookmarks.onCreated.addListener(
  async (_id: string, bookmark: BookmarkTreeNode) => {
    try {
      const { syncBookmarks } = await getConfig();
      if (!syncBookmarks || !bookmark.url) return;
      const state = await getSyncState();
      if (state.suppressBrowserEvents) return;
      enqueueSyncEvent({ type: 'created', bookmarkId: bookmark.id });
    } catch (err) {
      console.error('[Sync] onCreated error:', err);
    }
  }
);

browser.bookmarks.onChanged.addListener(
  async (id: string, _changeInfo: chrome.bookmarks.BookmarkChangeInfo) => {
    try {
      const { syncBookmarks } = await getConfig();
      if (!syncBookmarks) return;
      const state = await getSyncState();
      if (state.suppressBrowserEvents) return;
      enqueueSyncEvent({ type: 'changed', bookmarkId: id });
    } catch (err) {
      console.error('[Sync] onChanged error:', err);
    }
  }
);

browser.bookmarks.onRemoved.addListener(
  async (id: string, _removeInfo: chrome.bookmarks.BookmarkRemoveInfo) => {
    try {
      const { syncBookmarks } = await getConfig();
      if (!syncBookmarks) return;
      const state = await getSyncState();
      if (state.suppressBrowserEvents) return;
      enqueueSyncEvent({ type: 'removed', bookmarkId: id });
    } catch (err) {
      console.error('[Sync] onRemoved error:', err);
    }
  }
);

browser.bookmarks.onMoved.addListener(
  async (id: string, _moveInfo: chrome.bookmarks.BookmarkMoveInfo) => {
    try {
      const { syncBookmarks } = await getConfig();
      if (!syncBookmarks) return;
      const state = await getSyncState();
      if (state.suppressBrowserEvents) return;
      enqueueSyncEvent({ type: 'moved', bookmarkId: id });
    } catch (err) {
      console.error('[Sync] onMoved error:', err);
    }
  }
);

// --- Alarms (periodic sync) ---

browser.alarms.onAlarm.addListener(async (alarm) => {
  try {
    await handleAlarm(alarm);
  } catch (err) {
    console.error('[Sync] Alarm handler error:', err);
  }
});

// --- Context Menus ---

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  await genericOnClick(info, tab);
});

async function genericOnClick(
  info: OnClickData,
  tab: chrome.tabs.Tab | undefined
) {
  const { syncBookmarks, baseUrl } = await getConfig();
  const configured = await isConfigured();
  if (!tab?.url || !tab?.title || !configured) {
    return;
  }
  switch (info.menuItemId) {
    case 'save-all-tabs': {
      const tabs = await browser.tabs.query({ currentWindow: true });
      const config = await getConfig();

      for (const tab of tabs) {
        if (
          tab.url &&
          !tab.url.startsWith('chrome://') &&
          !tab.url.startsWith('about:')
        ) {
          try {
            if (new URL(tab.url))
              await postLinkFetch(
                config.baseUrl,
                {
                  url: tab.url,
                  name: tab.title || '',
                  description: tab.title || '',
                  collection: {
                    name: config.defaultCollection,
                  },
                  tags: [],
                },
                config.apiKey
              );
          } catch (error) {
            console.error(`Failed to save tab: ${tab.url}`, error);
          }
        }
      }
      break;
    }
    default:
      // Handle cases where sync is enabled or not
      if (syncBookmarks) {
        const config = await getConfig();
        const parentId = config.rootFolderId ?? '1';
        browser.bookmarks.create({
          parentId,
          title: tab.title,
          url: tab.url,
        });
      } else {
        const config = await getConfig();

        try {
          const newLink = await postLinkFetch(
            baseUrl,
            {
              url: tab.url,
              collection: {
                name: 'Unorganized',
              },
              tags: [],
              name: tab.title,
              description: tab.title,
            },
            config.apiKey
          );

          const newLinkJson = await newLink.json();
          const newLinkUrl: bookmarkMetadata = newLinkJson.response;
          newLinkUrl.bookmarkId = tab.id?.toString();

          await saveBookmarkMetadata(newLinkUrl);
        } catch (error) {
          console.error(error);
        }
      }
  }
}

// --- Extension Install / Startup ---

browser.runtime.onInstalled.addListener(async function () {
  // Create context menus
  const contexts: ContextType[] = [
    'page',
    'selection',
    'link',
    'editable',
    'image',
    'video',
    'audio',
  ];
  for (const context of contexts) {
    const title: string = 'Add link to Linkwarden';
    browser.contextMenus.create({
      title: title,
      contexts: [context],
      id: context,
    });
  }
  browser.contextMenus.create({
    id: 'save-all-tabs',
    title: 'Save all tabs to Linkwarden',
    contexts: ['page'],
  });

  const { id: tabId } = await getCurrentTabInfo();
  await updateBadge(tabId);

  // Initialize sync scheduler if configured
  const config = await getConfig();
  if (config.syncBookmarks) {
    initSyncScheduler();
    // Run initial sync on install
    performSync({ fullSync: true }).catch((err) =>
      console.error('[Sync] Initial sync failed:', err)
    );
  }
});

// --- Tab Listeners (badge updates) ---

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    await updateBadge(tabId);
  } catch (error) {
    console.error(`Error checking tab ${tabId} on activation:`, error);
  }
});

browser.tabs.onUpdated.addListener(async (tabId) => {
  try {
    await updateBadge(tabId);
  } catch (error) {
    console.error(`Error checking tab ${tabId} on activation:`, error);
  }
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    if (changeInfo.status === 'complete' && tab?.active) {
      await updateBadge(tabId);
    }
  } catch (error) {
    console.error(`Error checking tab ${tabId} on update:`, error);
  }
});

// On extension startup - check current tab and init sync
(async () => {
  try {
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id) {
      await updateBadge(tab.id);
    }

    // Start sync scheduler if configured
    const config = await getConfig();
    if (config.syncBookmarks) {
      initSyncScheduler();
    }
  } catch (error) {
    console.error(`Error on startup:`, error);
  }
})();

// --- Omnibox ---

browser.omnibox.onInputStarted.addListener(async () => {
  const configured = await isConfigured();
  const description = configured
    ? 'Search links in linkwarden'
    : 'Please configure the extension first';

  browser.omnibox.setDefaultSuggestion({
    description: description,
  });
});

browser.omnibox.onInputChanged.addListener(
  async (
    text: string,
    suggest: (arg0: { content: string; description: string }[]) => void
  ) => {
    const configured = await isConfigured();

    if (!configured) {
      return;
    }

    const currentBookmarks = await getBookmarksMetadata();

    const searchedBookmarks = currentBookmarks.filter((bookmark) => {
      return bookmark.name?.includes(text) || bookmark.url.includes(text);
    });

    const bookmarkSuggestions = searchedBookmarks.map((bookmark) => {
      return {
        content: bookmark.url,
        description: bookmark.name || bookmark.url,
      };
    });
    suggest(bookmarkSuggestions);
  }
);

browser.omnibox.onInputEntered.addListener(
  async (content: string, disposition: OnInputEnteredDisposition) => {
    if (!(await isConfigured()) || !content) {
      return;
    }

    const isUrl = /^http(s)?:\/\//.test(content);
    const url = isUrl ? content : `lk`;

    if (disposition === 'currentTab') {
      const tabInfo = await getCurrentTabInfo();
      if (tabInfo.url === 'edge://newtab/') {
        disposition = 'newForegroundTab';
      }
    }

    switch (disposition) {
      case 'currentTab':
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        await browser.tabs.update({ url });
        break;
      case 'newForegroundTab':
        await browser.tabs.create({ url });
        break;
      case 'newBackgroundTab':
        await browser.tabs.create({ url, active: false });
        break;
    }
  }
);
