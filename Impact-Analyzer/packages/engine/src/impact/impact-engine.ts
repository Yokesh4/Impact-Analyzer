import { WorkspaceIndexer } from '../indexer/workspace-indexer.js';
import { DependencyGraph } from '../graph/dependency-graph.js';
import { WorkspaceSymbol, ImpactReport, ImpactNode, RiskLevel, SymbolType, ImpactGroupedCounts, HierarchyEntry } from '../types.js';
import { RiskEngine } from '../risk/risk-engine.js';
import * as path from 'path';

export class ImpactEngine {
  private indexer: WorkspaceIndexer;
  private graph: DependencyGraph;

  constructor(indexer: WorkspaceIndexer, graph: DependencyGraph) {
    this.indexer = indexer;
    this.graph = graph;
  }

  public findSymbolAtLine(filePath: string, line: number): WorkspaceSymbol | null {
    const absPath = path.resolve(filePath);
    const fileIndex = this.indexer.files[absPath];
    if (!fileIndex) return null;

    let bestSymbol: WorkspaceSymbol | null = null;
    let minLinesSpan = Infinity;

    for (const sym of fileIndex.symbols) {
      if (line >= sym.location.startLine && line <= sym.location.endLine) {
        const span = sym.location.endLine - sym.location.startLine;
        if (span < minLinesSpan) {
          minLinesSpan = span;
          bestSymbol = sym;
        }
      }
    }
    return bestSymbol;
  }

  /**
   * Find all CSS symbols at a given line, including parent hierarchy context.
   * Used for hover UI to show the complete nesting chain.
   */
  public findAllSymbolsAtLine(filePath: string, line: number): WorkspaceSymbol[] {
    const absPath = path.resolve(filePath);
    const fileIndex = this.indexer.files[absPath];
    if (!fileIndex) return [];

    return fileIndex.symbols.filter(sym => 
      line >= sym.location.startLine && line <= sym.location.endLine
    );
  }

  /**
   * Compute grouped counts by node type for a set of affected nodes.
   */
  private computeGroupedCounts(affectedNodes: ImpactNode[]): ImpactGroupedCounts {
    const counts: ImpactGroupedCounts = {
      pages: 0,
      components: 0,
      modules: 0,
      routes: 0,
      selectors: 0
    };

    for (const node of affectedNodes) {
      switch (node.type) {
        case 'html-page':
        case 'jsp-page':
          counts.pages++;
          break;
        case 'component':
          counts.components++;
          break;
        case 'module':
          counts.modules++;
          break;
        case 'route':
          counts.routes++;
          break;
        case 'css-selector':
        case 'scss-variable':
        case 'scss-mixin':
          counts.selectors++;
          break;
      }
    }
    return counts;
  }

  /**
   * Analyze impact using hierarchical CSS propagation.
   * For CSS selectors, this aggregates downstream across the entire nesting chain
   * (parent → child → grandchild) for accurate affected page counts.
   */
  public analyzeImpact(symbolId: string): ImpactReport {
    let triggerNode = this.graph.nodes.get(symbolId);
    let triggerSymbol: WorkspaceSymbol | null = null;

    if (triggerNode) {
      const fileIndex = this.indexer.files[triggerNode.filePath];
      if (fileIndex) {
        triggerSymbol = fileIndex.symbols.find(s => s.id === symbolId) || null;
      }
    }

    // Resolve bare class to compound selector if available (parent + child grouping)
    if (triggerSymbol && triggerSymbol.metadata?.compoundSelector) {
      const compoundId = `css:${triggerSymbol.metadata.compoundSelector}`;
      if (this.graph.nodes.has(compoundId)) {
        symbolId = compoundId;
        triggerNode = this.graph.nodes.get(compoundId);
        const resolvedTriggerSymbol = triggerNode ? this.indexer.files[triggerNode.filePath]?.symbols.find(s => s.id === compoundId) : null;
        if (resolvedTriggerSymbol) {
          triggerSymbol = resolvedTriggerSymbol;
        }
      }
    }

    if (!triggerSymbol) {
      let name = symbolId;
      let type: SymbolType = 'css-selector';
      if (symbolId.startsWith('css:')) {
        name = symbolId.replace('css:', '');
        type = 'css-selector';
      } else if (symbolId.startsWith('service:')) {
        name = symbolId.replace('service:', '');
        type = 'service';
      } else if (symbolId.startsWith('selector:')) {
        name = symbolId.replace('selector:', '');
        type = 'css-selector';
      }
      triggerSymbol = {
        id: symbolId,
        name: name,
        type: type,
        location: { filePath: '', startLine: 0, startCol: 0, endLine: 0, endCol: 0 }
      };
    }

    // Use hierarchical downstream for CSS selectors, standard downstream for others
    const isCSS = symbolId.startsWith('css:');
    const downstreamIds = isCSS
      ? this.graph.getHierarchicalDownstream(symbolId)
      : this.graph.getDownstream(symbolId);

    const affectedNodes: ImpactNode[] = [];
    let maxRiskScore = 0;
    const riskMap: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3, critical: 4 };
    const scoreToRisk: Record<number, RiskLevel> = { 1: 'low', 2: 'medium', 3: 'high', 4: 'critical' };
    const seenIds = new Set<string>();

    for (const id of downstreamIds) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const node = this.graph.nodes.get(id);
      if (node) {
        const pathFromTrigger = this.graph.getDownstreamPath(symbolId, id);
        const nodeDownstreamCount = this.graph.getDownstream(id).length;
        const nodeRisk = RiskEngine.calculateRisk(nodeDownstreamCount, node.type);
        
        maxRiskScore = Math.max(maxRiskScore, riskMap[nodeRisk]);

        affectedNodes.push({
          symbolId: id,
          name: node.name,
          type: node.type,
          filePath: node.filePath,
          risk: nodeRisk,
          pathFromTrigger
        });
      }
    }

    const overallRisk = scoreToRisk[maxRiskScore] || 'low';
    const groupedCounts = this.computeGroupedCounts(affectedNodes);

    // Build hierarchy chain for hover display (only for CSS)
    let hierarchyChain: HierarchyEntry[] | undefined;
    if (isCSS) {
      hierarchyChain = this.graph.getHierarchyChain(symbolId);
    }

    return {
      triggerSymbol,
      affectedNodes,
      overallRisk,
      groupedCounts,
      hierarchyChain
    };
  }

  public analyzeLineImpact(filePath: string, line: number): ImpactReport | null {
    const symbol = this.findSymbolAtLine(filePath, line);
    if (!symbol) return null;
    return this.analyzeImpact(symbol.id);
  }

  /**
   * Analyze aggregated impact for an entire file by combining the impact of all its symbols.
   */
  public analyzeFileImpact(filePath: string): ImpactReport {
    const absPath = path.resolve(filePath);
    const fileIndex = this.indexer.files[absPath];

    const fallbackSymbol: WorkspaceSymbol = {
      id: `file:${path.basename(filePath)}`,
      name: path.basename(filePath),
      type: 'css-selector',
      location: { filePath: absPath, startLine: 1, startCol: 1, endLine: 1, endCol: 1 }
    };

    if (!fileIndex || fileIndex.symbols.length === 0) {
      return {
        triggerSymbol: fallbackSymbol,
        affectedNodes: [],
        overallRisk: 'low',
        groupedCounts: { pages: 0, components: 0, modules: 0, routes: 0, selectors: 0 }
      };
    }

    const triggerSymbol: WorkspaceSymbol = {
      id: `file:${path.basename(filePath)}`,
      name: path.basename(filePath),
      type: 'css-selector',
      location: { filePath: absPath, startLine: 1, startCol: 1, endLine: 1, endCol: 1 }
    };

    const combinedAffectedNodes: ImpactNode[] = [];
    const seenIds = new Set<string>();
    let maxRiskScore = 0;
    const riskMap: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3, critical: 4 };
    const scoreToRisk: Record<number, RiskLevel> = { 1: 'low', 2: 'medium', 3: 'high', 4: 'critical' };

    for (const sym of fileIndex.symbols) {
      const report = this.analyzeImpact(sym.id);
      for (const node of report.affectedNodes) {
        if (!seenIds.has(node.symbolId)) {
          seenIds.add(node.symbolId);
          combinedAffectedNodes.push(node);
          maxRiskScore = Math.max(maxRiskScore, riskMap[node.risk]);
        }
      }
    }

    const overallRisk = scoreToRisk[maxRiskScore] || 'low';
    const groupedCounts = this.computeGroupedCounts(combinedAffectedNodes);

    return {
      triggerSymbol,
      affectedNodes: combinedAffectedNodes,
      overallRisk,
      groupedCounts
    };
  }
}
export default ImpactEngine;
