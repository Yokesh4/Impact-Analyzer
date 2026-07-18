import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves @import chains from LESS/CSS/SCSS files.
 * Supports:
 *   - LESS: @import "file.less", @import 'file', @import (less) 'file.css'
 *   - SCSS: @import 'file', @import 'path/file'
 *   - CSS:  @import url('file.css'), @import "file.css"
 * 
 * Returns a deduplicated flat list of all transitively imported file paths.
 */
export class ImportResolver {
  private workspaceRoot: string;
  private visited: Set<string> = new Set();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Resolve the full import chain starting from one or more entry-point files.
   * Returns all transitively imported file paths (absolute, deduplicated).
   */
  public resolveImportChain(entryFiles: string[]): string[] {
    this.visited.clear();
    for (const entry of entryFiles) {
      const absPath = path.isAbsolute(entry) ? entry : path.resolve(this.workspaceRoot, entry);
      this.resolveRecursive(absPath);
    }
    return Array.from(this.visited);
  }

  private resolveRecursive(filePath: string): void {
    const normalized = this.normalizePath(filePath);
    if (this.visited.has(normalized)) return;

    // Try to find the file with various extensions if it doesn't exist directly
    const resolvedPath = this.resolveFilePath(normalized);
    if (!resolvedPath) return;

    const normalizedResolved = this.normalizePath(resolvedPath);
    this.visited.add(normalizedResolved);

    let content: string;
    try {
      content = fs.readFileSync(normalizedResolved, 'utf-8');
    } catch {
      return; // File can't be read, skip
    }

    const imports = this.extractImports(content);
    const dir = path.dirname(normalizedResolved);

    for (const importPath of imports) {
      let resolvedImport: string | null = null;

      if (path.isAbsolute(importPath)) {
        resolvedImport = this.resolveFilePath(importPath);
      } else {
        // 1. Walk up the directory structure from `dir` to `this.workspaceRoot`
        let currentDir = dir;
        while (true) {
          const candidate = path.resolve(currentDir, importPath);
          resolvedImport = this.resolveFilePath(candidate);
          if (resolvedImport) break;

          // Stop if we've reached the workspace root or can't go up further
          if (currentDir === this.workspaceRoot || currentDir === path.dirname(currentDir)) {
            break;
          }
          currentDir = path.dirname(currentDir);
        }

        // 2. Try looking in node_modules relative to the workspace root or package root
        if (!resolvedImport) {
          const candidate = path.resolve(this.workspaceRoot, 'node_modules', importPath);
          resolvedImport = this.resolveFilePath(candidate);
        }

        // 3. Fallback to workspace root directly
        if (!resolvedImport) {
          const candidate = path.resolve(this.workspaceRoot, importPath);
          resolvedImport = this.resolveFilePath(candidate);
        }

        // 4. Fallback to packages/sample-app/src
        if (!resolvedImport) {
          const sampleAppSrc = path.resolve(this.workspaceRoot, 'packages/sample-app/src');
          const candidate = path.resolve(sampleAppSrc, importPath);
          resolvedImport = this.resolveFilePath(candidate);
        }
      }

      if (resolvedImport) {
        this.resolveRecursive(resolvedImport);
      }
    }
  }

  /**
   * Extract all @import paths from a LESS/CSS/SCSS file content.
   */
  public extractImports(content: string): string[] {
    const imports: string[] = [];

    // Remove block comments to avoid false matches inside comments
    const cleanContent = content.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\r\n]/g, ' '));

    // Pattern 1: @import (options) "path" or @import (options) 'path'
    // e.g., @import (less) '../webapp/js/thirdparty/file.css';
    const importWithOptionsRegex = /@import\s*\([^)]*\)\s*['"]([^'"]+)['"]\s*;?/g;
    let match: RegExpExecArray | null;
    while ((match = importWithOptionsRegex.exec(cleanContent)) !== null) {
      imports.push(match[1]);
    }

    // Pattern 2: @import "path" or @import 'path' (without options parens)
    // e.g., @import "bootstrap/less/variables.less";
    // e.g., @import 'ctf-common';
    const importSimpleRegex = /@import\s+['"]([^'"]+)['"]\s*;?/g;
    while ((match = importSimpleRegex.exec(cleanContent)) !== null) {
      // Skip if already captured by options pattern (check for preceding parens)
      const precedingText = cleanContent.substring(Math.max(0, match.index - 20), match.index);
      if (!/\)\s*$/.test(precedingText)) {
        imports.push(match[1]);
      }
    }

    // Pattern 3: @import url('path') or @import url("path")
    const importUrlRegex = /@import\s+url\(\s*['"]([^'"]+)['"]\s*\)\s*;?/g;
    while ((match = importUrlRegex.exec(cleanContent)) !== null) {
      imports.push(match[1]);
    }

    // Deduplicate
    return [...new Set(imports)];
  }

  /**
   * Try to resolve a file path, attempting various extensions if the exact path doesn't exist.
   */
  private resolveFilePath(filePath: string): string | null {
    if (fs.existsSync(filePath)) return filePath;

    // Try common style extensions
    const extensions = ['.less', '.css', '.scss', '.sass'];
    for (const ext of extensions) {
      const withExt = filePath + ext;
      if (fs.existsSync(withExt)) return withExt;
    }

    // Try with underscore prefix (SCSS partials: _filename.scss)
    const dir = path.dirname(filePath);
    const basename = path.basename(filePath);
    for (const ext of extensions) {
      const partial = path.join(dir, `_${basename}${ext}`);
      if (fs.existsSync(partial)) return partial;
    }

    // Try index file in directory
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      for (const ext of extensions) {
        const indexFile = path.join(filePath, `index${ext}`);
        if (fs.existsSync(indexFile)) return indexFile;
      }
    }

    return null;
  }

  private normalizePath(p: string): string {
    const resolved = path.resolve(p);
    if (resolved && resolved.length > 1 && resolved[1] === ':') {
      return resolved[0].toLowerCase() + resolved.slice(1);
    }
    return resolved;
  }
}

export default ImportResolver;
