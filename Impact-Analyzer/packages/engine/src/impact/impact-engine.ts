import { WorkspaceIndexer } from '../indexer/workspace-indexer.js';
import { DependencyGraph } from '../graph/dependency-graph.js';
import { WorkspaceSymbol, ImpactReport, ImpactNode, RiskLevel, SymbolType } from '../types.js';
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

  public analyzeImpact(symbolId: string): ImpactReport {
    const triggerNode = this.graph.nodes.get(symbolId);
    let triggerSymbol: WorkspaceSymbol | null = null;

    if (triggerNode) {
      const fileIndex = this.indexer.files[triggerNode.filePath];
      if (fileIndex) {
        triggerSymbol = fileIndex.symbols.find(s => s.id === symbolId) || null;
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

    const downstreamIds = this.graph.getDownstream(symbolId);
    const affectedNodes: ImpactNode[] = [];
    let maxRiskScore = 0;
    const riskMap: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3, critical: 4 };
    const scoreToRisk: Record<number, RiskLevel> = { 1: 'low', 2: 'medium', 3: 'high', 4: 'critical' };

    for (const id of downstreamIds) {
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

    return {
      triggerSymbol,
      affectedNodes,
      overallRisk
    };
  }

  public analyzeLineImpact(filePath: string, line: number): ImpactReport | null {
    const symbol = this.findSymbolAtLine(filePath, line);
    if (!symbol) return null;
    return this.analyzeImpact(symbol.id);
  }
}
export default ImpactEngine;
