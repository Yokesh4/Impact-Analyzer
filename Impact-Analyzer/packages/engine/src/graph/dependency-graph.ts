import { DependencyNode, DependencyEdge, WorkspaceSymbol, FileIndex } from '../types.js';
import { WorkspaceIndexer } from '../indexer/workspace-indexer.js';
import * as path from 'path';

export class DependencyGraph {
  public nodes: Map<string, DependencyNode> = new Map();
  public edges: Map<string, Set<string>> = new Map(); // from -> Set<to>
  public incomingEdges: Map<string, Set<string>> = new Map(); // to -> Set<from>

  public clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.incomingEdges.clear();
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
      }
    }

    for (const [filePath, fileIndex] of Object.entries(indexer.files)) {
      let ownerId = '';

      const majorSymbol = fileIndex.symbols.find(s => s.type === 'component' || s.type === 'service' || s.type === 'module' || s.type === 'route');
      if (majorSymbol) {
        ownerId = majorSymbol.id;
      } else {
        ownerId = fileToComponentMap.get(filePath) || '';
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
  }
}
