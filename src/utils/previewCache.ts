import type { PagePreviewResponse } from '../types';

const MAX_CACHE_ENTRIES = 30;
const previewLruCache = new Map<string, PagePreviewResponse>();

export function makePreviewCacheKey(jobId: string, filePath: string, pageNumber: number): string {
  return `${jobId}::${filePath}::${pageNumber}`;
}

export function getCachedPreview(key: string): PagePreviewResponse | undefined {
  const hit = previewLruCache.get(key);
  if (!hit) return undefined;
  // Refresh LRU recency order
  previewLruCache.delete(key);
  previewLruCache.set(key, hit);
  return hit;
}

export function setCachedPreview(key: string, value: PagePreviewResponse): void {
  if (previewLruCache.has(key)) {
    previewLruCache.delete(key);
  } else if (previewLruCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = previewLruCache.keys().next().value;
    if (oldestKey !== undefined) {
      previewLruCache.delete(oldestKey);
    }
  }
  previewLruCache.set(key, value);
}

export function invalidateJobPreviews(jobId: string): void {
  if (!jobId) return;
  const prefix = `${jobId}::`;
  for (const key of Array.from(previewLruCache.keys())) {
    if (key.startsWith(prefix)) {
      previewLruCache.delete(key);
    }
  }
}
