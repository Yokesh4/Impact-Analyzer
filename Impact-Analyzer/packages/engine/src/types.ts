export type SymbolType =
  | 'component'
  | 'service'
  | 'module'
  | 'css-selector'
  | 'scss-variable'
  | 'scss-mixin'
  | 'input'
  | 'output'
  | 'directive'
  | 'pipe'
  | 'route';

export interface SourceLocation {
  filePath: string;
  startLine: number; // 1-indexed
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface WorkspaceSymbol {
  id: string; // Unique within workspace: e.g. "service:AuthService", "css:.btn-primary", "component:app-user-card"
  name: string; // e.g. "btn-primary", "AuthService", "disabled"
  type: SymbolType;
  location: SourceLocation;
  metadata?: Record<string, any>;
}

export interface WorkspaceReference {
  targetSymbolId: string; // ID of the referenced symbol
  location: SourceLocation; // Where the reference was found
}

export interface FileIndex {
  filePath: string;
  lastModified: number;
  symbols: WorkspaceSymbol[];
  references: WorkspaceReference[];
}

export interface DependencyNode {
  id: string;
  name: string;
  type: SymbolType | 'route';
  filePath: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: 'inject' | 'use-selector' | 'use-style' | 'import-module' | 'route-to' | 'bind-input' | 'bind-output';
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ImpactNode {
  symbolId: string;
  name: string;
  type: SymbolType | 'route';
  filePath: string;
  risk: RiskLevel;
  pathFromTrigger: string[];
}

export interface ImpactReport {
  triggerSymbol: WorkspaceSymbol | null;
  affectedNodes: ImpactNode[];
  overallRisk: RiskLevel;
}

export interface IndexerCache {
  version: string;
  files: Record<string, FileIndex>;
}
