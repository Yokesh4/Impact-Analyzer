import * as fs from 'fs';
import * as path from 'path';
import { FileIndex, IndexerCache, WorkspaceSymbol, WorkspaceReference } from '../types.js';
import { parseTypeScript } from '../parser/ts-parser.js';
import { parseHTML } from '../parser/html-parser.js';
import { parseCSS } from '../parser/css-parser.js';
import { ImportResolver } from '../parser/import-resolver.js';

export interface IndexingResult {
  totalFiles: number;
  successCount: number;
  errorCount: number;
  errors: { filePath: string; error: string }[];
  mode: 'full' | 'style-focused';
}

export class WorkspaceIndexer {
  public files: Record<string, FileIndex> = {};
  public workspaceRoot: string = '';
  private lastIndexingResult: IndexingResult | null = null;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = this.normalizePath(workspaceRoot);
  }

  private normalizePath(p: string): string {
    const resolved = path.resolve(p);
    if (resolved && resolved.length > 1 && resolved[1] === ':') {
      return resolved[0].toLowerCase() + resolved.slice(1);
    }
    return resolved;
  }

  private healAbsolutePath(cachedPath: string, cacheFilePath: string): string {
    if (!path.isAbsolute(cachedPath)) {
      return cachedPath;
    }
    const normalizedCached = this.normalizePath(cachedPath);

    const currentCacheDir = this.normalizePath(path.dirname(cacheFilePath));
    const packagesIdx = normalizedCached.indexOf('/packages/');
    if (packagesIdx !== -1) {
      const rel = normalizedCached.substring(packagesIdx + 1);
      return this.normalizePath(path.resolve(this.workspaceRoot, rel));
    }

    const parts = normalizedCached.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const subPath = parts.slice(i).join('/');
      const candidate = this.normalizePath(path.resolve(this.workspaceRoot, subPath));
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return normalizedCached;
  }

  /**
   * Get the result of the last indexing operation.
   */
  public getLastIndexingResult(): IndexingResult | null {
    return this.lastIndexingResult;
  }

  public async indexWorkspace(progressCallback?: (percentage: number, msg: string) => void, customFiles?: string[]): Promise<IndexingResult> {
    const allFiles = customFiles || this.findFiles(this.workspaceRoot);
    const totalFiles = allFiles.length;
    let processed = 0;
    const concurrency = 15;
    const errors: { filePath: string; error: string }[] = [];
    let successCount = 0;

    // Process files in parallel batches of size `concurrency`
    for (let i = 0; i < allFiles.length; i += concurrency) {
      const chunk = allFiles.slice(i, i + concurrency);
      await Promise.all(chunk.map(async (filePath) => {
        try {
          await this.indexFile(filePath);
          successCount++;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error(`Error indexing file: ${filePath}`, err);
          errors.push({ filePath, error: errorMsg });
        }
        processed++;
        if (progressCallback) {
          progressCallback(Math.round((processed / totalFiles) * 100), `Indexed ${path.basename(filePath)}`);
        }
      }));
    }

    this.lastIndexingResult = {
      totalFiles,
      successCount,
      errorCount: errors.length,
      errors,
      mode: 'full'
    };

    return this.lastIndexingResult;
  }

  /**
   * Style-focused indexing: only index style files reachable from the given
   * open/entry-point files via @import chains, plus all HTML/JSP files for
   * reference matching. Skips TS files unless they have inline styles.
   */
  public async indexStyleFocused(
    openStyleFiles: string[],
    progressCallback?: (percentage: number, msg: string) => void
  ): Promise<IndexingResult> {
    const resolver = new ImportResolver(this.workspaceRoot);
    const errors: { filePath: string; error: string }[] = [];
    
    // Step 1: Resolve @import chains from open style files
    const importedStyleFiles = resolver.resolveImportChain(openStyleFiles);
    
    // Step 2: Find all HTML/JSP files in workspace (needed for reference matching)
    const htmlJspFiles = this.findFilesByExtensions(this.workspaceRoot, ['.html', '.jsp']);
    
    // Step 3: Combine — style files + HTML/JSP
    const allFiles = [...new Set([...importedStyleFiles, ...htmlJspFiles])];
    
    const totalFiles = allFiles.length;
    let processed = 0;
    let successCount = 0;
    const concurrency = 15;

    for (let i = 0; i < allFiles.length; i += concurrency) {
      const chunk = allFiles.slice(i, i + concurrency);
      await Promise.all(chunk.map(async (filePath) => {
        try {
          await this.indexFile(filePath);
          successCount++;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error(`Error indexing file: ${filePath}`, err);
          errors.push({ filePath, error: errorMsg });
        }
        processed++;
        if (progressCallback) {
          progressCallback(Math.round((processed / totalFiles) * 100), `Indexed ${path.basename(filePath)}`);
        }
      }));
    }

    this.lastIndexingResult = {
      totalFiles,
      successCount,
      errorCount: errors.length,
      errors,
      mode: 'style-focused'
    };

    return this.lastIndexingResult;
  }

  public async indexFile(filePath: string, force: boolean = false): Promise<boolean> {
    const absolutePath = this.normalizePath(filePath);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(absolutePath);
    } catch (err) {
      this.removeFile(absolutePath);
      return true;
    }
    
    const lastModified = stat.mtimeMs;

    const existing = this.files[absolutePath];
    if (!force && existing && existing.lastModified === lastModified) {
      return false; // File has not changed
    }

    const content = await fs.promises.readFile(absolutePath, 'utf-8');
    const ext = path.extname(absolutePath).toLowerCase();

    let symbols: WorkspaceSymbol[] = [];
    let references: WorkspaceReference[] = [];
    let imports: string[] | undefined;

    if (ext === '.ts') {
      const parsed = parseTypeScript(absolutePath, content);
      symbols = parsed.symbols;
      references = parsed.references;
    } else if (ext === '.html' || ext === '.jsp') {
      const parsed = parseHTML(absolutePath, content);
      symbols = parsed.symbols;
      references = parsed.references;
    } else if (ext === '.css' || ext === '.scss' || ext === '.less') {
      const parsed = parseCSS(absolutePath, content);
      symbols = parsed.symbols;
      references = parsed.references;
      imports = parsed.imports;
    }

    this.files[absolutePath] = {
      filePath: absolutePath,
      lastModified,
      symbols,
      references,
      imports
    };

    return true;
  }

  public removeFile(filePath: string): void {
    const absolutePath = this.normalizePath(filePath);
    delete this.files[absolutePath];
  }

  private findFiles(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    
    const list = fs.readdirSync(dir);
    const ignoredDirs = [
      'node_modules', '.git', 'dist', '.angular', 'out',
      '.vscode', '.idea', 'build', 'coverage', '.cache',
      'tmp', 'temp', 'vendor', 'docker', '.docker'
    ];
    for (const file of list) {
      if (ignoredDirs.includes(file)) {
        continue;
      }
      const absolutePath = path.join(dir, file);
      const stat = fs.statSync(absolutePath);
      if (stat && stat.isDirectory()) {
        results.push(...this.findFiles(absolutePath));
      } else {
        const ext = path.extname(absolutePath).toLowerCase();
        if (['.ts', '.html', '.css', '.scss', '.less', '.jsp'].includes(ext)) {
          results.push(this.normalizePath(absolutePath));
        }
      }
    }
    return results;
  }

  /**
   * Find files matching specific extensions recursively.
   */
  private findFilesByExtensions(dir: string, extensions: string[]): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    const ignoredDirs = [
      'node_modules', '.git', 'dist', '.angular', 'out',
      '.vscode', '.idea', 'build', 'coverage', '.cache',
      'tmp', 'temp', 'vendor', 'docker', '.docker'
    ];

    const list = fs.readdirSync(dir);
    for (const file of list) {
      if (ignoredDirs.includes(file)) continue;
      const absolutePath = path.join(dir, file);
      try {
        const stat = fs.statSync(absolutePath);
        if (stat.isDirectory()) {
          results.push(...this.findFilesByExtensions(absolutePath, extensions));
        } else {
          const ext = path.extname(absolutePath).toLowerCase();
          if (extensions.includes(ext)) {
            results.push(this.normalizePath(absolutePath));
          }
        }
      } catch {
        // Skip files that can't be stat'd
      }
    }
    return results;
  }

  private toRelative(absolutePath: string): string {
    const normalizedAbs = this.normalizePath(absolutePath);
    const relative = path.relative(this.workspaceRoot, normalizedAbs);
    return relative.replace(/\\/g, '/');
  }

  private toAbsolute(relativePath: string): string {
    const normalizedRel = relativePath.replace(/\\/g, '/');
    if (path.isAbsolute(normalizedRel)) {
      return this.normalizePath(normalizedRel);
    }
    return this.normalizePath(path.resolve(this.workspaceRoot, normalizedRel));
  }

  private serializeFileIndex(fileIndex: FileIndex): FileIndex {
    return {
      filePath: this.toRelative(fileIndex.filePath),
      lastModified: fileIndex.lastModified,
      symbols: (fileIndex.symbols || []).map(sym => ({
        ...sym,
        location: {
          ...sym.location,
          filePath: sym.location?.filePath ? this.toRelative(sym.location.filePath) : ''
        }
      })),
      references: (fileIndex.references || []).map(ref => ({
        ...ref,
        location: {
          ...ref.location,
          filePath: ref.location?.filePath ? this.toRelative(ref.location.filePath) : ''
        }
      })),
      imports: fileIndex.imports
    };
  }

  private deserializeFileIndex(fileIndex: FileIndex, cacheFilePath?: string): FileIndex {
    const resolvePath = (p: string) => {
      if (p && cacheFilePath) {
        const healed = this.healAbsolutePath(p, cacheFilePath);
        return this.toAbsolute(healed);
      }
      return this.toAbsolute(p || '');
    };

    return {
      filePath: resolvePath(fileIndex.filePath),
      lastModified: fileIndex.lastModified || 0,
      symbols: (fileIndex.symbols || []).map(sym => ({
        ...sym,
        location: {
          ...sym.location,
          filePath: sym.location?.filePath ? resolvePath(sym.location.filePath) : ''
        }
      })),
      references: (fileIndex.references || []).map(ref => ({
        ...ref,
        location: {
          ...ref.location,
          filePath: ref.location?.filePath ? resolvePath(ref.location.filePath) : ''
        }
      })),
      imports: fileIndex.imports
    };
  }

  public saveCache(cacheFilePath: string): void {
    const serializedFiles: Record<string, FileIndex> = {};
    for (const [absPath, fileIndex] of Object.entries(this.files)) {
      const relKey = this.toRelative(absPath);
      serializedFiles[relKey] = this.serializeFileIndex(fileIndex);
    }
    const data: IndexerCache = {
      version: '1.0.0',
      files: serializedFiles
    };
    fs.writeFileSync(cacheFilePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  public loadCache(cacheFilePath: string): boolean {
    if (!fs.existsSync(cacheFilePath)) {
      return false;
    }
    try {
      const content = fs.readFileSync(cacheFilePath, 'utf-8');
      const data: IndexerCache = JSON.parse(content);
      if (data.version === '1.0.0') {
        const deserializedFiles: Record<string, FileIndex> = {};
        for (const [relPath, fileIndex] of Object.entries(data.files)) {
          const healedRelPath = this.healAbsolutePath(relPath, cacheFilePath);
          const absKey = this.toAbsolute(healedRelPath);
          deserializedFiles[absKey] = this.deserializeFileIndex(fileIndex, cacheFilePath);
        }
        this.files = deserializedFiles;
        return true;
      }
    } catch (e) {
      console.error('Failed to load index cache:', e);
    }
    return false;
  }
}
