import { z } from 'zod';

export const configSchema = z.object({
  baseUrl: z.string().url(),
  defaultCollection: z.string().optional().default('Unorganized'),
  apiKey: z.string(),
  syncBookmarks: z.boolean().optional().default(false),
  browserType: z.enum(['firefox', 'edge', 'chrome']).optional(),
  rootCollectionId: z.number().nullable().optional().default(null),
  rootFolderId: z.string().nullable().optional().default(null),
});

export type configType = z.infer<typeof configSchema>;
