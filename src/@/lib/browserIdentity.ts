export type BrowserIdentity = 'firefox' | 'edge';

export interface ManagedRootDescriptor {
  identity: BrowserIdentity;
  browserName: 'Firefox' | 'Edge';
  managedRootName: 'Firefox' | 'Edge';
  parentBookmarkContainerId: string;
}

interface BrowserFeaturesLike {
  sidebarAction?: unknown;
  sidebarActionConfig?: unknown;
}

type RuntimeLike = ({
  runtime?: {
    getURL?: (path?: string) => string;
  };
} & BrowserFeaturesLike);

const FIREFOX_PARENT_CONTAINER_ID = 'toolbar_____';
const EDGE_PARENT_CONTAINER_ID = '1';

export function detectBrowserIdentity(
  runtime: RuntimeLike = (globalThis.browser ?? globalThis.chrome ?? {}) as RuntimeLike
): BrowserIdentity {
  const runtimeUrl = runtime.runtime?.getURL?.('') ?? '';

  if (runtimeUrl.startsWith('moz-extension://')) {
    return 'firefox';
  }

  if (
    runtimeUrl.startsWith('chrome-extension://') ||
    runtimeUrl.startsWith('ms-browser-extension://')
  ) {
    return 'edge';
  }

  const browserFeatures = runtime as BrowserFeaturesLike;
  if (
    typeof browserFeatures.sidebarAction !== 'undefined' ||
    typeof browserFeatures.sidebarActionConfig !== 'undefined'
  ) {
    return 'firefox';
  }

  return 'edge';
}

export function getManagedRootName(
  identity: BrowserIdentity
): ManagedRootDescriptor['managedRootName'] {
  return identity === 'firefox' ? 'Firefox' : 'Edge';
}

export function getManagedRootParentBookmarkContainerId(
  identity: BrowserIdentity
): string {
  return identity === 'firefox'
    ? FIREFOX_PARENT_CONTAINER_ID
    : EDGE_PARENT_CONTAINER_ID;
}

export function getManagedRootDescriptor(
  identity: BrowserIdentity = detectBrowserIdentity()
): ManagedRootDescriptor {
  const managedRootName = getManagedRootName(identity);

  return {
    identity,
    browserName: managedRootName,
    managedRootName,
    parentBookmarkContainerId:
      getManagedRootParentBookmarkContainerId(identity),
  };
}
