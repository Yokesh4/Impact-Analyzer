import * as fs from 'fs';
import * as path from 'path';
import { FileIndex, IndexerCache, WorkspaceSymbol, WorkspaceReference } from '../types.js';
import { parseTypeScript } from '../parser/ts-parser.js';
import { parseHTML } from '../parser/html-parser.js';
import { parseCSS } from '../parser/css-parser.js';

export class WorkspaceIndexer {
  public files: Record<string, FileIndex> = {};
  private workspaceRoot: string = '';

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  public async indexWorkspace(progressCallback?: (percentage: number, msg: string) => void): Promise<void> {
    const allFiles = this.findFiles(this.workspaceRoot);
    const totalFiles = allFiles.length;
    let processed = 0;
    const concurrency = 15;

    // Process files in parallel batches of size `concurrency`
    for (let i = 0; i < allFiles.length; i += concurrency) {
      const chunk = allFiles.slice(i, i + concurrency);
      await Promise.all(chunk.map(async (filePath) => {
        try {
          await this.indexFile(filePath);
        } catch (err) {
          console.error(`Error indexing file: ${filePath}`, err);
        }
        processed++;
        if (progressCallback) {
          progressCallback(Math.round((processed / totalFiles) * 100), `Indexed ${path.basename(filePath)}`);
        }
      }));
    }
  }

  public async indexFile(filePath: string, force: boolean = false): Promise<boolean> {
    const absolutePath = path.resolve(filePath);
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

    if (ext === '.ts') {
      const parsed = parseTypeScript(absolutePath, content);
      symbols = parsed.symbols;
      references = parsed.references;
    } else if (ext === '.html') {
      const parsed = parseHTML(absolutePath, content);
      symbols = parsed.symbols;
      references = parsed.references;
    } else if (ext === '.css' || ext === '.scss' || ext === '.less') {
      const parsed = parseCSS(absolutePath, content);
      symbols = parsed.symbols;
      references = parsed.references;
    }

    this.files[absolutePath] = {
      filePath: absolutePath,
      lastModified,
      symbols,
      references
    };

    return true;
  }

  public removeFile(filePath: string): void {
    const absolutePath = path.resolve(filePath);
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
        if (['.ts', '.html', '.css', '.scss', '.less'].includes(ext)) {
          results.push(absolutePath);
        }
      }
    }
    return results;
  }

  public saveCache(cacheFilePath: string): void {
    const data: IndexerCache = {
      version: '1.0.0',
      files: this.files
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
        this.files = data.files;
        return true;
      }
    } catch (e) {
      console.error('Failed to load index cache:', e);
    }
    return false;
  }
}
