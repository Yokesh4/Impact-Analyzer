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
  | 'route'
  | 'html-page'
  | 'jsp-page';

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
  imports?: string[]; // Resolved import paths for @import chains (LESS/CSS/SCSS)
}

/** Represents a CSS selector hierarchy node for parent-child-grandchild tracking */
export interface CSSHierarchyNode {
  /** The full resolved selector (e.g., ".parent .child .grandchild") */
  fullSelector: string;
  /** Individual class names extracted from this selector */
  classNames: string[];
  /** Parent selector in the nesting chain (null if root-level) */
  parentSelector: string | null;
  /** Direct child selectors */
  children: CSSHierarchyNode[];
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

/** Grouped counts of affected items by type for clear UI display */
export interface ImpactGroupedCounts {
  pages: number;
  components: number;
  modules: number;
  routes: number;
  selectors: number;
}

/** Hierarchy entry for hover UI — shows nesting chain */
export interface HierarchyEntry {
  selector: string;
  depth: number;
  affectedCount: number;
}

export interface ImpactReport {
  triggerSymbol: WorkspaceSymbol | null;
  affectedNodes: ImpactNode[];
  overallRisk: RiskLevel;
  /** Grouped counts for professional UI display */
  groupedCounts?: ImpactGroupedCounts;
  /** Hierarchy chain for hover display (parent → child → grandchild) */
  hierarchyChain?: HierarchyEntry[];
}

export interface IndexerCache {
  version: string;
  files: Record<string, FileIndex>;
}
