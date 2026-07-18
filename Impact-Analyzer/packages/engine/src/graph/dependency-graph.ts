import { DependencyNode, DependencyEdge, WorkspaceSymbol, FileIndex } from '../types.js';
import { WorkspaceIndexer } from '../indexer/workspace-indexer.js';
import * as path from 'path';

export class DependencyGraph {
  public nodes: Map<string, DependencyNode> = new Map();
  public edges: Map<string, Set<string>> = new Map(); // from -> Set<to>
  public incomingEdges: Map<string, Set<string>> = new Map(); // to -> Set<from>

  /** Maps a bare class (e.g. "css:.parent") to all compound selectors containing it */
  public classToCompoundSelectors: Map<string, Set<string>> = new Map();

  public clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.incomingEdges.clear();
    this.classToCompoundSelectors.clear();
  }

  public addNode(node: DependencyNode): void {
    this.nodes.set(node.id, node);
  }

  public addEdge(from: string, to: string): void {
    if (!this.edges.has(from)) {
      this.edges.set(from, new Set());
    }
    this.edges.get(from)!.add(to);

    if (!this.incomingEdges.has(to)) {
      this.incomingEdges.set(to, new Set());
    }
    this.incomingEdges.get(to)!.add(from);
  }

  public getDownstream(nodeId: string): string[] {
    const visited = new Set<string>();
    const queue: string[] = [nodeId];
    const results: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      if (current !== nodeId) {
        results.push(current);
      }

      const targets = this.edges.get(current);
      if (targets) {
        for (const target of targets) {
          queue.push(target);
        }
      }
    }
    return results;
  }

  /**
   * Get hierarchical downstream for a CSS class.
   * When analyzing .parent, also includes downstream of all compound selectors
   * that contain .parent (e.g., ".parent .child", ".parent .child .grandchild"),
   * AND all bare class names extracted from those compound selectors.
   * This provides accurate affected page counts across the entire nesting hierarchy.
   */
  public getHierarchicalDownstream(nodeId: string): string[] {
    const allDownstream = new Set<string>();
    
    // Get direct downstream of this node
    const directDownstream = this.getDownstream(nodeId);
    for (const id of directDownstream) {
      allDownstream.add(id);
    }

    // If this is a CSS class, also get downstream of all compound selectors containing it
    // AND all bare class names that appear in those compound selectors
    if (nodeId.startsWith('css:')) {
      const visited = new Set<string>();
      visited.add(nodeId);
      const queue = [nodeId];

      while (queue.length > 0) {
        const current = queue.shift()!;

        // Get compound selectors containing this class
        const compoundSelectors = this.classToCompoundSelectors.get(current);
        if (compoundSelectors) {
          for (const compoundId of compoundSelectors) {
            if (!visited.has(compoundId)) {
              visited.add(compoundId);
              // Get downstream of compound selector
              const compoundDownstream = this.getDownstream(compoundId);
              for (const id of compoundDownstream) {
                allDownstream.add(id);
              }

              // Extract bare class names from the compound selector and process them too
              const selectorText = compoundId.replace('css:', '');
              const classRegex = /\.([a-zA-Z0-9_-]+)/g;
              let match: RegExpExecArray | null;
              while ((match = classRegex.exec(selectorText)) !== null) {
                const bareClassId = `css:.${match[1]}`;
                if (!visited.has(bareClassId)) {
                  visited.add(bareClassId);
                  queue.push(bareClassId);
                  // Also get direct downstream of this bare class (connects to pages)
                  const bareDownstream = this.getDownstream(bareClassId);
                  for (const id of bareDownstream) {
                    allDownstream.add(id);
                  }
                }
              }
            }
          }
        }
      }
    }

    // Remove self
    allDownstream.delete(nodeId);
    return Array.from(allDownstream);
  }

  /**
   * Get all compound selectors that a bare class participates in,
   * organized as a hierarchy chain for hover display.
   */
  public getHierarchyChain(classId: string): { selector: string; depth: number; affectedCount: number }[] {
    const chain: { selector: string; depth: number; affectedCount: number }[] = [];
    const compoundSelectors = this.classToCompoundSelectors.get(classId);
    
    if (!compoundSelectors) return chain;
    
    for (const compoundId of compoundSelectors) {
      if (compoundId === classId) continue;
      const selector = compoundId.replace('css:', '');
      const depth = (selector.match(/\./g) || []).length;
      const downstream = this.getDownstream(compoundId);
      chain.push({
        selector,
        depth,
        affectedCount: downstream.length
      });
    }
    
    // Sort by depth (shallowest first)
    chain.sort((a, b) => a.depth - b.depth);
    return chain;
  }

  public getDownstreamPath(fromId: string, toId: string): string[] {
    const visited = new Set<string>();
    const parentMap = new Map<string, string>();
    const queue: string[] = [fromId];

    visited.add(fromId);
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === toId) {
        const pathList: string[] = [];
        let curr = toId;
        while (curr !== fromId) {
          pathList.push(curr);
          curr = parentMap.get(curr)!;
        }
        pathList.push(fromId);
        return pathList.reverse();
      }

      const targets = this.edges.get(current);
      if (targets) {
        for (const target of targets) {
          if (!visited.has(target)) {
            visited.add(target);
            parentMap.set(target, current);
            queue.push(target);
          }
        }
      }
    }
    return [];
  }

  /**
   * Build CSS hierarchy edges: a change to .parent should propagate to
   * all compound selectors containing .parent as an ancestor class.
   * e.g., css:.parent → css:.parent .child → css:.parent .child .grandchild
   */
  private buildCSSHierarchyEdges(): void {
    const compoundSelectors: { id: string; classes: string[] }[] = [];

    for (const [id, node] of this.nodes.entries()) {
      if (id.startsWith('css:') && node.type === 'css-selector') {
        const selectorText = id.replace('css:', '');
        const classes: string[] = [];
        const classRegex = /\.([a-zA-Z0-9_-]+)/g;
        let match: RegExpExecArray | null;
        while ((match = classRegex.exec(selectorText)) !== null) {
          classes.push(`.${match[1]}`);
        }
        if (classes.length > 0) {
          compoundSelectors.push({ id, classes });
        }
      }
    }

    // For each compound selector, register it under every class it contains
    for (const { id, classes } of compoundSelectors) {
      for (const cls of classes) {
        const classId = `css:${cls}`;
        if (!this.classToCompoundSelectors.has(classId)) {
          this.classToCompoundSelectors.set(classId, new Set());
        }
        this.classToCompoundSelectors.get(classId)!.add(id);
      }
    }

    // Build edges: bare class → compound selector containing it
    for (const [classId, compounds] of this.classToCompoundSelectors.entries()) {
      for (const compoundId of compounds) {
        if (compoundId !== classId && this.nodes.has(classId)) {
          this.addEdge(classId, compoundId);
        }
      }
    }
  }

  public buildGraph(indexer: WorkspaceIndexer): void {
    this.clear();

    const fileToComponentMap = new Map<string, string>();
    const componentsList: { className: string; filePath: string; selector?: string }[] = [];

    for (const [filePath, fileIndex] of Object.entries(indexer.files)) {
      for (const sym of fileIndex.symbols) {
        if (sym.type === 'component') {
          componentsList.push({
            className: sym.name,
            filePath: filePath,
            selector: sym.metadata?.selector
          });
          fileToComponentMap.set(filePath, sym.id);
        }
      }
    }

    for (const [filePath, fileIndex] of Object.entries(indexer.files)) {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.html' || ext === '.css' || ext === '.scss' || ext === '.less') {
        const baseName = path.basename(filePath, ext);
        const dir = path.dirname(filePath);
        const match = componentsList.find(c => {
          return path.dirname(c.filePath) === dir && path.basename(c.filePath, '.ts') === baseName;
        });
        if (match) {
          fileToComponentMap.set(filePath, `component:${match.className}`);
        }
      }
    }

    for (const [filePath, fileIndex] of Object.entries(indexer.files)) {
      for (const sym of fileIndex.symbols) {
        this.addNode({
          id: sym.id,
          name: sym.name,
          type: sym.type,
          filePath: filePath
        });

        if (sym.type === 'component' && sym.metadata?.selector) {
          this.addEdge(sym.id, `selector:${sym.metadata.selector}`);
        }
      }
    }

    for (const [filePath, fileIndex] of Object.entries(indexer.files)) {
      let ownerId = '';
      const ext = path.extname(filePath).toLowerCase();

      if (ext === '.html' || ext === '.jsp') {
        const relPath = path.relative(indexer.workspaceRoot, filePath).replace(/\\/g, '/');
        ownerId = `page:${relPath}`;
        this.addNode({
          id: ownerId,
          name: path.basename(filePath),
          type: ext === '.jsp' ? 'jsp-page' : 'html-page',
          filePath: filePath
        });

      } else {
        const majorSymbol = fileIndex.symbols.find(s => s.type === 'component' || s.type === 'service' || s.type === 'module' || s.type === 'route');
        if (majorSymbol) {
          ownerId = majorSymbol.id;
        } else {
          ownerId = fileToComponentMap.get(filePath) || '';
        }
      }

      if (ownerId) {
        for (const sym of fileIndex.symbols) {
          if (sym.id !== ownerId && (sym.type === 'css-selector' || sym.type === 'scss-variable' || sym.type === 'scss-mixin' || sym.type === 'input' || sym.type === 'output')) {
            this.addEdge(sym.id, ownerId);
          }
        }
      }

      for (const ref of fileIndex.references) {
        if (!this.nodes.has(ref.targetSymbolId)) {
          let type: any = 'css-selector';
          let name = ref.targetSymbolId;
          if (ref.targetSymbolId.startsWith('css:')) {
            type = 'css-selector';
            name = ref.targetSymbolId.replace('css:', '');
          } else if (ref.targetSymbolId.startsWith('service:')) {
            type = 'service';
            name = ref.targetSymbolId.replace('service:', '');
          } else if (ref.targetSymbolId.startsWith('selector:')) {
            type = 'css-selector';
            name = ref.targetSymbolId.replace('selector:', '');
          } else if (ref.targetSymbolId.startsWith('input:')) {
            type = 'input';
            name = ref.targetSymbolId.replace('input:', '');
          } else if (ref.targetSymbolId.startsWith('output:')) {
            type = 'output';
            name = ref.targetSymbolId.replace('output:', '');
          }

          this.addNode({
            id: ref.targetSymbolId,
            name: name,
            type: type,
            filePath: ''
          });
        }

        if (ownerId) {
          this.addEdge(ref.targetSymbolId, ownerId);
        }
      }
    }

    for (const [filePath, fileIndex] of Object.entries(indexer.files)) {
      const moduleSymbol = fileIndex.symbols.find(s => s.type === 'module');
      if (moduleSymbol) {
        for (const ref of fileIndex.references) {
          if (ref.targetSymbolId.startsWith('module-member:')) {
            const memberName = ref.targetSymbolId.replace('module-member:', '');
            const compNode = Array.from(this.nodes.values()).find(
              n => n.name === memberName && (n.type === 'component' || n.type === 'service' || n.type === 'module')
            );
            if (compNode) {
              this.addEdge(compNode.id, moduleSymbol.id);
            }
          }
        }
      }
    }

    // Build CSS hierarchy edges for accurate parent→child→grandchild propagation
    this.buildCSSHierarchyEdges();
  }
}
