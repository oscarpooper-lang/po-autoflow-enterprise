import type { AppSettings } from '../types';

const WORKSPACE_SUBFOLDERS: Array<{
  key: keyof Pick<
    AppSettings,
    | 'incoming_dir'
    | 'processing_dir'
    | 'sent_dir'
    | 'failed_dir'
    | 'review_dir'
    | 'temp_dir'
    | 'logs_dir'
  >;
  folderName: string;
}> = [
  { key: 'incoming_dir', folderName: 'Incoming' },
  { key: 'processing_dir', folderName: 'Processing' },
  { key: 'sent_dir', folderName: 'Sent' },
  { key: 'review_dir', folderName: 'Review' },
  { key: 'failed_dir', folderName: 'Failed' },
  { key: 'temp_dir', folderName: 'Temp' },
  { key: 'logs_dir', folderName: 'Logs' },
];

export function normalizeDirPath(path: string): string {
  return path.trim().replace(/[\\/]+$/, '');
}

/**
 * Updates workspace `root_dir` and automatically remaps workflow subfolders under the new root.
 * When `forceAll` is false, preserves custom paths that were explicitly moved outside `oldRoot`
 * (while still migrating stale `C:\PO-AutoFlow\*` defaults).
 */
export function remapWorkspacePaths(
  prev: AppSettings,
  newRootRaw: string,
  forceAll = false
): AppSettings {
  const cleanRoot = normalizeDirPath(newRootRaw);
  const oldRoot = normalizeDirPath(prev.root_dir || '');
  const next: AppSettings = { ...prev, root_dir: newRootRaw };

  if (!cleanRoot) {
    return next;
  }

  const oldPrefix = oldRoot ? `${oldRoot.toLowerCase()}\\` : '';
  for (const { key, folderName } of WORKSPACE_SUBFOLDERS) {
    const current = (prev[key] || '').trim();
    const curLow = current.toLowerCase();
    const staleDefault = `c:\\po-autoflow\\${folderName.toLowerCase()}`;
    if (
      forceAll ||
      !current ||
      (oldPrefix && curLow.startsWith(oldPrefix)) ||
      curLow === staleDefault
    ) {
      next[key] = `${cleanRoot}\\${folderName}`;
    }
  }

  return next;
}
