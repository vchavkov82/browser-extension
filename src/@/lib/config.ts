import { getStorageItem, setStorageItem, detectBrowserType } from './utils.ts';
import {
  configSchema,
  type BrowserIdentity,
  type ManagedRootMetadata,
  type configType,
} from './validators/config.ts';
import {
  detectBrowserIdentity,
  getManagedRootDescriptor,
} from './browserIdentity.ts';

const DEFAULTS: configType = {
  baseUrl: '',
  apiKey: '',
  defaultCollection: 'Unorganized',
  syncBookmarks: false,
  browserType: undefined,
  rootCollectionId: null,
  rootFolderId: null,
};

const CONFIG_KEY = 'linkwarden_config';

function mergeManagedRoot(
  current?: ManagedRootMetadata,
  partial?: Partial<ManagedRootMetadata>
): ManagedRootMetadata | undefined {
  if (!current && !partial) {
    return undefined;
  }

  return {
    ...(current ?? {}),
    ...(partial ?? {}),
  } as ManagedRootMetadata;
}

function withDerivedDefaults(config: configType): configType {
  const browserType = config.browserType ?? detectBrowserType();
  const browserIdentity = config.browserIdentity;

  return {
    ...config,
    browserType,
    ...(browserIdentity
      ? {
          managedRoot: mergeManagedRoot(
            {
              ...getManagedRootDescriptor(browserIdentity),
              browser: browserIdentity,
            },
            config.managedRoot
          ),
        }
      : {}),
  };
}

export async function getConfig(): Promise<configType> {
  const config = await getStorageItem(CONFIG_KEY);
  const parsed = configSchema.parse(config ? JSON.parse(config) : DEFAULTS);
  return withDerivedDefaults(parsed);
}

export async function saveConfig(config: Partial<configType>) {
  const current = await getConfig();
  return await setStorageItem(
    CONFIG_KEY,
    JSON.stringify(withDerivedDefaults(configSchema.parse({ ...current, ...config })))
  );
}

export async function updateScopedBootstrapConfig(params: {
  browserIdentity: BrowserIdentity;
  managedRoot?: Partial<ManagedRootMetadata>;
}): Promise<configType> {
  const current = await getConfig();
  const descriptor = getManagedRootDescriptor(params.browserIdentity);
  const currentManagedRoot =
    current.browserIdentity === params.browserIdentity
      ? current.managedRoot
      : undefined;

  const nextManagedRoot = mergeManagedRoot(
    {
      browser: params.browserIdentity,
      browserName: descriptor.browserName,
      managedRootName: descriptor.managedRootName,
      parentBookmarkContainerId: descriptor.parentBookmarkContainerId,
    },
    mergeManagedRoot(currentManagedRoot, params.managedRoot)
  );

  const nextConfig: configType = {
    ...current,
    browserIdentity: params.browserIdentity,
    managedRoot: nextManagedRoot,
    rootCollectionId:
      nextManagedRoot?.serverCollectionId ?? current.rootCollectionId ?? null,
    rootFolderId:
      nextManagedRoot?.browserRootFolderId ?? current.rootFolderId ?? null,
  };

  await saveConfig(nextConfig);
  return getConfig();
}

export async function resetScopedBootstrapConfig(
  browserIdentity: BrowserIdentity = detectBrowserIdentity()
): Promise<configType> {
  const descriptor = getManagedRootDescriptor(browserIdentity);
  const current = await getConfig();
  const nextConfig: configType = {
    ...current,
    browserIdentity,
    managedRoot: {
      browser: browserIdentity,
      browserName: descriptor.browserName,
      managedRootName: descriptor.managedRootName,
      parentBookmarkContainerId: descriptor.parentBookmarkContainerId,
    },
    rootCollectionId: null,
    rootFolderId: null,
  };

  await saveConfig(nextConfig);
  return getConfig();
}

export async function isConfigured() {
  const config = await getConfig();
  return (
    !!config.baseUrl &&
    config.baseUrl !== '' &&
    !!config.apiKey &&
    config.apiKey !== ''
  );
}

export async function clearConfig() {
  return await setStorageItem(CONFIG_KEY, JSON.stringify(DEFAULTS));
}
