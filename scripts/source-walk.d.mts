export declare const DEFAULT_EXCLUDE: string[];
export declare const DEFAULT_MAX_FILES: number;
export declare const EXTENSIONS: Map<string, string>;
export declare function walkSources(
  dir: string,
  options?: {
    exclude?: string[];
    includeExts?: string[];
    maxFiles?: number;
    maxEntries?: number;
  },
): Array<{ fullPath: string; ext: string; mtime: number }>;
