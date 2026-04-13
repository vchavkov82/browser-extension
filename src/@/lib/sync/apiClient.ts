// Sync-focused API client for bidirectional bookmark synchronization.
// Uses fetch (not axios) for MV3 service worker compatibility.

export interface SyncStatusResponse {
  serverTime: string;
  totalLinks: number;
  collections: Array<{
    id: number;
    name: string;
    linkCount: number;
    latestUpdate: string;
  }>;
}

export interface SyncLink {
  id: number;
  url: string | null;
  name: string;
  description: string;
  type: string;
  collectionId: number;
  createdAt: string;
  updatedAt: string;
  tags: Array<{ id: number; name: string }>;
  collection: {
    id: number;
    name: string;
    ownerId: number;
    parentId: number | null;
  };
  pinnedBy: Array<{ id: number }>;
}

export interface SyncTombstone {
  entityId: number;
  collectionId: number | null;
  url: string | null;
  deletedAt: string;
}

export interface SyncLinksResponse {
  links: SyncLink[];
  tombstones: SyncTombstone[];
}

export interface ServerCollection {
  id: number;
  name: string;
  ownerId: number;
  parentId: number | null;
  color: string;
  description: string;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
  parent: { id: number; name: string } | null;
  _count: { links: number };
}

function headers(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

async function jsonFetch<T>(url: string, apiKey: string): Promise<T> {
  const res = await fetch(url, { headers: headers(apiKey) });
  if (!res.ok) {
    throw new Error(`Sync API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.response;
}

export async function fetchSyncStatus(
  baseUrl: string,
  apiKey: string
): Promise<SyncStatusResponse> {
  return jsonFetch<SyncStatusResponse>(
    `${baseUrl}/api/v1/sync/status`,
    apiKey
  );
}

export async function fetchLinksSince(
  baseUrl: string,
  apiKey: string,
  since?: string,
  collectionId?: number
): Promise<SyncLinksResponse> {
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  if (collectionId) params.set('collectionId', String(collectionId));
  const qs = params.toString();
  return jsonFetch<SyncLinksResponse>(
    `${baseUrl}/api/v1/sync/links${qs ? '?' + qs : ''}`,
    apiKey
  );
}

export async function fetchCollections(
  baseUrl: string,
  apiKey: string,
  since?: string
): Promise<ServerCollection[]> {
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  const qs = params.toString();
  return jsonFetch<ServerCollection[]>(
    `${baseUrl}/api/v1/collections${qs ? '?' + qs : ''}`,
    apiKey
  );
}

export interface BulkCreateResult {
  created: SyncLink[];
  existing: SyncLink[];
  errors: Array<{ index: number; url?: string; error: string }>;
}

export async function bulkCreateLinks(
  baseUrl: string,
  apiKey: string,
  links: Array<{
    url: string;
    name: string;
    description?: string;
    tags?: Array<{ name: string }>;
    collection: { id?: number; name?: string };
  }>
): Promise<BulkCreateResult> {
  const res = await fetch(`${baseUrl}/api/v1/links`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ links }),
  });
  if (!res.ok) {
    throw new Error(`Bulk create error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.response;
}

export async function bulkDeleteLinks(
  baseUrl: string,
  apiKey: string,
  linkIds: number[]
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/v1/links`, {
    method: 'DELETE',
    headers: headers(apiKey),
    body: JSON.stringify({ linkIds }),
  });
  if (!res.ok) {
    throw new Error(`Bulk delete error ${res.status}: ${await res.text()}`);
  }
}

export async function updateLink(
  baseUrl: string,
  apiKey: string,
  linkId: number,
  data: {
    url?: string;
    name?: string;
    description?: string;
    collection?: { id?: number; name?: string };
    tags?: Array<{ name: string }>;
  }
): Promise<SyncLink> {
  const res = await fetch(`${baseUrl}/api/v1/links/${linkId}`, {
    method: 'PUT',
    headers: headers(apiKey),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error(`Update link error ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return json.response;
}

export async function pinLink(
  baseUrl: string,
  apiKey: string,
  linkId: number
): Promise<void> {
  await fetch(`${baseUrl}/api/v1/links/${linkId}`, {
    method: 'PUT',
    headers: headers(apiKey),
    body: JSON.stringify({ pinnedBy: [{}] }),
  });
}

export async function unpinLink(
  baseUrl: string,
  apiKey: string,
  linkId: number
): Promise<void> {
  await fetch(`${baseUrl}/api/v1/links/${linkId}`, {
    method: 'PUT',
    headers: headers(apiKey),
    body: JSON.stringify({ pinnedBy: [] }),
  });
}

export async function createCollection(
  baseUrl: string,
  apiKey: string,
  data: {
    name: string;
    parentId?: number;
    color?: string;
    description?: string;
  }
): Promise<ServerCollection> {
  const res = await fetch(`${baseUrl}/api/v1/collections`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error(
      `Create collection error ${res.status}: ${await res.text()}`
    );
  }
  const json = await res.json();
  return json.response;
}
