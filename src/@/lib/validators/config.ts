import { z } from 'zod';

export const browserIdentitySchema = z.enum(['firefox', 'edge']);

export const managedRootMetadataSchema = z.object({
  browser: browserIdentitySchema,
  browserName: z.enum(['Firefox', 'Edge']),
  managedRootName: z.enum(['Firefox', 'Edge']),
  parentBookmarkContainerId: z.string(),
  browserRootFolderId: z.string().optional(),
  serverCollectionId: z.number().optional(),
  lastResolvedAt: z.string().optional(),
});

export const bootstrapDiagnosticSchema = z.object({
  phase: z.string(),
  message: z.string(),
  occurredAt: z.string(),
});

const syncMutationCountersSchema = z.object({
  create: z.number().optional(),
  update: z.number().optional(),
  delete: z.number().optional(),
});

const syncMetricSummarySchema = z.object({
  scopedEntries: z.number().optional(),
  scopedBookmarks: z.number().optional(),
  scopedLinks: z.number().optional(),
  scopedTombstones: z.number().optional(),
  foreignCacheEntriesIgnored: z.number().optional(),
});

export const syncDiagnosticRunMetricsSchema = syncMetricSummarySchema.extend({
  runId: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
  mutated: syncMutationCountersSchema.optional(),
});

const syncPlanDiagnosticSchema = z.object({
  threshold: z.number().optional(),
  existingScopedEntries: z.number().optional(),
  existingScopedBookmarks: z.number().optional(),
  counters: syncMutationCountersSchema.optional(),
  metrics: syncMetricSummarySchema.optional(),
  reason: z.string().optional(),
});

export const syncDiagnosticSchema = z.object({
  phase: z.string(),
  lastAttemptAt: z.string().optional(),
  lastSuccessAt: z.string().optional(),
  lastError: bootstrapDiagnosticSchema.optional(),
  run: syncDiagnosticRunMetricsSchema.optional(),
  pull: syncPlanDiagnosticSchema.optional(),
  push: syncPlanDiagnosticSchema.optional(),
});

export const configSchema = z.object({
  baseUrl: z.string().url().or(z.literal('')),
  defaultCollection: z.string().optional().default('Unorganized'),
  apiKey: z.string().optional().default(''),
  syncBookmarks: z.boolean().optional().default(false),
  browserType: z.enum(['firefox', 'edge', 'chrome']).optional(),
  rootCollectionId: z.number().nullable().optional().default(null),
  rootFolderId: z.string().nullable().optional().default(null),
  browserIdentity: browserIdentitySchema.optional(),
  managedRoot: managedRootMetadataSchema.optional(),
});

export type BrowserIdentity = z.infer<typeof browserIdentitySchema>;
export type ManagedRootMetadata = z.infer<typeof managedRootMetadataSchema>;
export type BootstrapDiagnostic = z.infer<typeof bootstrapDiagnosticSchema>;
export type SyncDiagnosticRunMetrics = z.infer<typeof syncDiagnosticRunMetricsSchema>;
export type SyncDiagnostic = z.infer<typeof syncDiagnosticSchema>;
export type configType = z.infer<typeof configSchema>;
