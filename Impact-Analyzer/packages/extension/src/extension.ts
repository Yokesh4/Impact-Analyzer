import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { WorkspaceIndexer, DependencyGraph, ImpactEngine, ImpactReport, WorkspaceSymbol, RiskEngine } from '@impact-guard/engine';

let indexer: WorkspaceIndexer;
let graph: DependencyGraph;
let impactEngine: ImpactEngine;
let diagnosticCollection: vscode.DiagnosticCollection;
let treeDataProvider: ImpactTreeProvider;
let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
  console.log('Impact Guard is activating...');

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    vscode.window.showInformationMessage('Open a workspace folder to activate Impact Guard.');
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  indexer = new WorkspaceIndexer(workspaceRoot);
  graph = new DependencyGraph();
  impactEngine = new ImpactEngine(indexer, graph);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(shield) Impact Guard: Indexing...';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  treeDataProvider = new ImpactTreeProvider();
  vscode.window.registerTreeDataProvider('impact-guard-view', treeDataProvider);

  diagnosticCollection = vscode.languages.createDiagnosticCollection('impact-guard');
  context.subscriptions.push(diagnosticCollection);

  const cacheFilePath = path.join(workspaceRoot, '.impact-guard-cache.json');
  
  vscode.window.withProgress({
    location: vscode.ProgressLocation.Window,
    title: "Impact Guard Indexing",
    cancellable: false
  }, async (progress) => {
    let loaded = indexer.loadCache(cacheFilePath);
    if (!loaded) {
      const filePaths = await findWorkspaceFiles();
      await indexer.indexWorkspace((percentage, msg) => {
        progress.report({ message: `${percentage}% - ${msg}` });
      }, filePaths);
      indexer.saveCache(cacheFilePath);
    }
    graph.buildGraph(indexer);
    
    statusBarItem.text = '$(shield) Impact Guard: Active';
    statusBarItem.tooltip = 'Click to show dependency graph';
    statusBarItem.command = 'impact-guard.showDependencyGraph';
  });

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const ext = path.extname(doc.fileName).toLowerCase();
      if (['.ts', '.html', '.css', '.scss', '.less'].includes(ext)) {
        statusBarItem.text = '$(sync~spin) Impact Guard: Re-indexing...';
        const changed = await indexer.indexFile(doc.fileName, true);
        if (changed) {
          graph.buildGraph(indexer);
          indexer.saveCache(cacheFilePath);
        }
        statusBarItem.text = '$(shield) Impact Guard: Active';
        triggerLineAnalysisForActiveEditor();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('impact-guard.analyzeSymbol', async (symbolId?: string) => {
      let id = symbolId;
      if (!id) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const symbol = getSymbolAtCursor(editor);
          if (symbol) {
            id = symbol.id;
          }
        }
      }
      if (id) {
        runImpactAnalysis(id);
        vscode.commands.executeCommand('impact-guard-view.focus');
      } else {
        vscode.window.showWarningMessage('No Impact Guard symbols found under cursor.');
      }
    }),

    vscode.commands.registerCommand('impact-guard.analyzeFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      runFileAnalysis(editor.document.fileName);
    }),

    vscode.commands.registerCommand('impact-guard.analyzeWorkspace', async () => {
      vscode.window.showInformationMessage('Analyzing workspace downstream impacts...');
      runWorkspaceAnalysis();
    }),

    vscode.commands.registerCommand('impact-guard.rebuildIndex', async () => {
      statusBarItem.text = '$(sync~spin) Impact Guard: Rebuilding...';
      const filePaths = await findWorkspaceFiles();
      await indexer.indexWorkspace(undefined, filePaths);
      graph.buildGraph(indexer);
      indexer.saveCache(cacheFilePath);
      statusBarItem.text = '$(shield) Impact Guard: Active';
      vscode.window.showInformationMessage('Impact Guard Workspace Index rebuilt.');
    }),

    vscode.commands.registerCommand('impact-guard.showDependencyGraph', () => {
      vscode.window.showInformationMessage(`Total Nodes: ${graph.nodes.size}, Total Connections: ${graph.edges.size}`);
    }),

    vscode.commands.registerCommand('impact-guard.exportReport', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const symbol = getSymbolAtCursor(editor);
      if (!symbol) return;
      
      const report = impactEngine.analyzeImpact(symbol.id);
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(workspaceRoot, 'impact-report.md')),
        filters: { 'Markdown': ['md'], 'JSON': ['json'] }
      });
      if (uri) {
        const isJson = uri.fsPath.endsWith('.json');
        const output = isJson 
          ? JSON.stringify(report, null, 2) 
          : generateMarkdown(report);
        fs.writeFileSync(uri.fsPath, output, 'utf-8');
        vscode.window.showInformationMessage(`Report successfully exported to: ${path.basename(uri.fsPath)}`);
      }
    })
  );

  const docSelector: vscode.DocumentFilter[] = [
    { scheme: 'file', language: 'typescript' },
    { scheme: 'file', language: 'html' },
    { scheme: 'file', language: 'css' },
    { scheme: 'file', language: 'scss' },
    { scheme: 'file', language: 'less' }
  ];

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(docSelector, new ImpactCodeLensProvider())
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(docSelector, new ImpactHoverProvider())
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      const editor = e.textEditor;
      const pos = editor.selection.active;
      const symbol = impactEngine.findSymbolAtLine(editor.document.fileName, pos.line + 1);
      if (symbol) {
        const report = impactEngine.analyzeImpact(symbol.id);
        treeDataProvider.setReport(report);
      }
    })
  );
}

function getSymbolAtCursor(editor: vscode.TextEditor): WorkspaceSymbol | null {
  const line = editor.selection.active.line + 1;
  return impactEngine.findSymbolAtLine(editor.document.fileName, line);
}

function runImpactAnalysis(symbolId: string) {
  const report = impactEngine.analyzeImpact(symbolId);
  treeDataProvider.setReport(report);
  updateDiagnostics(report);
}

function runFileAnalysis(filePath: string) {
  const absPath = path.resolve(filePath);
  const fileIndex = indexer.files[absPath];
  if (!fileIndex || fileIndex.symbols.length === 0) {
    vscode.window.showInformationMessage('No symbols tracked in this file.');
    return;
  }
  const sym = fileIndex.symbols[0];
  runImpactAnalysis(sym.id);
}

function runWorkspaceAnalysis() {
  const criticalList: string[] = [];
  for (const [id, node] of graph.nodes.entries()) {
    const downCount = graph.getDownstream(id).length;
    if (downCount > 10) {
      criticalList.push(`${node.name} (${node.type}) -> affects ${downCount} downstreams`);
    }
  }
  if (criticalList.length > 0) {
    vscode.window.showWarningMessage(`Found ${criticalList.length} High-Risk symbols in workspace:\n` + criticalList.slice(0, 5).join('\n'));
  } else {
    vscode.window.showInformationMessage('Workspace risk analysis complete. No high-risk nodes found.');
  }
}

function triggerLineAnalysisForActiveEditor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const pos = editor.selection.active;
  const symbol = impactEngine.findSymbolAtLine(editor.document.fileName, pos.line + 1);
  if (symbol) {
    const report = impactEngine.analyzeImpact(symbol.id);
    treeDataProvider.setReport(report);
    updateDiagnostics(report);
  }
}

function updateDiagnostics(report: ImpactReport) {
  diagnosticCollection.clear();
  if (report.overallRisk === 'critical' || report.overallRisk === 'high') {
    if (report.triggerSymbol && report.triggerSymbol.location.filePath) {
      const fileUri = vscode.Uri.file(report.triggerSymbol.location.filePath);
      const start = new vscode.Position(report.triggerSymbol.location.startLine - 1, report.triggerSymbol.location.startCol - 1);
      const end = new vscode.Position(report.triggerSymbol.location.endLine - 1, report.triggerSymbol.location.endCol - 1);
      const range = new vscode.Range(start, end);
      const diagnostic = new vscode.Diagnostic(
        range,
        `Impact Guard Warning: Modifying this symbol carries a ${report.overallRisk.toUpperCase()} risk. Downstream affected count: ${report.affectedNodes.length}.`,
        report.overallRisk === 'critical' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
      );
      diagnosticCollection.set(fileUri, [diagnostic]);
    }
  }
}

function generateMarkdown(report: ImpactReport): string {
  let md = `# Impact Guard Analysis Report\n\n`;
  if (report.triggerSymbol) {
    md += `**Trigger Symbol:** \`${report.triggerSymbol.name}\` (${report.triggerSymbol.type})\n`;
  }
  md += `**Overall Risk:** **${report.overallRisk.toUpperCase()}**\n`;
  md += `**Impacted Count:** ${report.affectedNodes.length} nodes\n\n`;
  md += `## Affected Downstream Nodes\n\n`;
  
  if (report.affectedNodes.length > 0) {
    for (const node of report.affectedNodes) {
      md += `- **[${node.risk.toUpperCase()}]** ${node.name} (${node.type})\n`;
      md += `  Path: \`${node.pathFromTrigger.join(' -> ')}\`\n`;
    }
  } else {
    md += `*No downstream impacts detected.*\n`;
  }
  return md;
}

class TreeItemNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly description?: string,
    public readonly iconPath?: vscode.ThemeIcon,
    public readonly command?: vscode.Command
  ) {
    super(label, collapsibleState);
    if (command) {
      this.command = command;
    }
  }
}

class ImpactTreeProvider implements vscode.TreeDataProvider<TreeItemNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<TreeItemNode | undefined | null | void> = new vscode.EventEmitter<TreeItemNode | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TreeItemNode | undefined | null | void> = this._onDidChangeTreeData.event;

  private report: ImpactReport | null = null;

  public setReport(report: ImpactReport) {
    this.report = report;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeItemNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItemNode): Thenable<TreeItemNode[]> {
    if (!this.report) {
      return Promise.resolve([new TreeItemNode('No active impact report. Hover/click a symbol.', vscode.TreeItemCollapsibleState.None)]);
    }

    if (!element) {
      const rootItems = [
        new TreeItemNode(`Trigger: ${this.report.triggerSymbol?.name || 'Unknown'}`, vscode.TreeItemCollapsibleState.None, this.report.triggerSymbol?.type, new vscode.ThemeIcon('symbol-property')),
        new TreeItemNode(`Overall Risk: ${this.report.overallRisk.toUpperCase()}`, vscode.TreeItemCollapsibleState.None, undefined, new vscode.ThemeIcon('warning')),
        new TreeItemNode(`Affected Components (${this.report.affectedNodes.filter(n => n.type === 'component').length})`, vscode.TreeItemCollapsibleState.Collapsed, undefined, new vscode.ThemeIcon('symbol-class')),
        new TreeItemNode(`Affected Modules (${this.report.affectedNodes.filter(n => n.type === 'module').length})`, vscode.TreeItemCollapsibleState.Collapsed, undefined, new vscode.ThemeIcon('package')),
        new TreeItemNode(`Affected Routes (${this.report.affectedNodes.filter(n => n.type === 'route').length})`, vscode.TreeItemCollapsibleState.Collapsed, undefined, new vscode.ThemeIcon('symbol-interface'))
      ];
      return Promise.resolve(rootItems);
    }

    const label = element.label;
    if (label.startsWith('Affected Components')) {
      const items = this.report.affectedNodes
        .filter(n => n.type === 'component')
        .map(n => {
          let emoji = '🟢';
          if (n.risk === 'critical') emoji = '🔴';
          else if (n.risk === 'high') emoji = '🟠';
          else if (n.risk === 'medium') emoji = '🟡';
          
          return new TreeItemNode(
            `${emoji} ${n.name}`,
            vscode.TreeItemCollapsibleState.None,
            path.basename(n.filePath),
            new vscode.ThemeIcon('symbol-class'),
            {
              title: 'Open File',
              command: 'vscode.open',
              arguments: [vscode.Uri.file(n.filePath)]
            }
          );
        });
      return Promise.resolve(items);
    }
    if (label.startsWith('Affected Modules')) {
      const items = this.report.affectedNodes
        .filter(n => n.type === 'module')
        .map(n => {
          let emoji = '🟢';
          if (n.risk === 'critical') emoji = '🔴';
          else if (n.risk === 'high') emoji = '🟠';
          else if (n.risk === 'medium') emoji = '🟡';

          return new TreeItemNode(
            `${emoji} ${n.name}`,
            vscode.TreeItemCollapsibleState.None,
            path.basename(n.filePath),
            new vscode.ThemeIcon('package'),
            {
              title: 'Open File',
              command: 'vscode.open',
              arguments: [vscode.Uri.file(n.filePath)]
            }
          );
        });
      return Promise.resolve(items);
    }
    if (label.startsWith('Affected Routes')) {
      const items = this.report.affectedNodes
        .filter(n => n.type === 'route')
        .map(n => {
          let emoji = '🟢';
          if (n.risk === 'critical') emoji = '🔴';
          else if (n.risk === 'high') emoji = '🟠';
          else if (n.risk === 'medium') emoji = '🟡';

          const cmd = n.filePath ? {
            title: 'Open Routing Config',
            command: 'vscode.open',
            arguments: [vscode.Uri.file(n.filePath)]
          } : undefined;

          return new TreeItemNode(
            `${emoji} ${n.name}`,
            vscode.TreeItemCollapsibleState.None,
            'Route Definition',
            new vscode.ThemeIcon('symbol-interface'),
            cmd
          );
        });
      return Promise.resolve(items);
    }

    return Promise.resolve([]);
  }
}

class ImpactCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
    if (!indexer) return [];
    
    const absPath = path.resolve(document.fileName);
    const fileIndex = indexer.files[absPath];
    if (!fileIndex) return [];

    const lenses: vscode.CodeLens[] = [];
    for (const sym of fileIndex.symbols) {
      if (['component', 'service', 'module', 'css-selector', 'input', 'output'].includes(sym.type)) {
        const start = new vscode.Position(sym.location.startLine - 1, sym.location.startCol - 1);
        const end = new vscode.Position(sym.location.endLine - 1, sym.location.endCol - 1);
        const range = new vscode.Range(start, end);
        
        const downstream = graph.getDownstream(sym.id);
        const downCount = downstream.length;
        const risk = RiskEngine.calculateRisk(downCount, sym.type);

        let emoji = '🟢';
        if (risk === 'critical') emoji = '🔴';
        else if (risk === 'high') emoji = '🟠';
        else if (risk === 'medium') emoji = '🟡';

        const lens = new vscode.CodeLens(range, {
          title: `🛡️ Impact: ${downCount} downstream usages | ${emoji} ${risk.toUpperCase()} Risk`,
          command: 'impact-guard.analyzeSymbol',
          arguments: [sym.id]
        });
        lenses.push(lens);
      }
    }
    return lenses;
  }
}

class ImpactHoverProvider implements vscode.HoverProvider {
  provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
    if (!indexer || !impactEngine) return null;

    const line = position.line + 1;
    const symbol = impactEngine.findSymbolAtLine(document.fileName, line);
    if (!symbol) return null;

    const downstream = graph.getDownstream(symbol.id);
    const downCount = downstream.length;
    const risk = RiskEngine.calculateRisk(downCount, symbol.type);

    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;
    
    let emoji = '🟢';
    if (risk === 'critical') emoji = '🔴';
    else if (risk === 'high') emoji = '🟠';
    else if (risk === 'medium') emoji = '🟡';

    markdown.appendMarkdown(`### $(shield) Impact Guard Summary\n\n`);
    markdown.appendMarkdown(`- **Symbol Name:** \`${symbol.name}\` (${symbol.type})\n`);
    markdown.appendMarkdown(`- **Usage Count:** ${downCount} downstream files/nodes affected\n`);
    markdown.appendMarkdown(`- **Risk Level:** **${emoji} ${risk.toUpperCase()}**\n\n`);
    
    if (downCount > 0) {
      markdown.appendMarkdown(`**Affected Items:**\n`);
      for (const id of downstream.slice(0, 5)) {
        const node = graph.nodes.get(id);
        if (node) {
          markdown.appendMarkdown(`- \`${node.name}\` (${node.type})\n`);
        }
      }
      
      const argsStr = encodeURIComponent(JSON.stringify([symbol.id]));
      if (downCount > 5) {
        markdown.appendMarkdown(`\n👉 **[Show all ${downCount} affected items in Sidebar...](command:impact-guard.analyzeSymbol?${argsStr})**\n`);
      } else {
        markdown.appendMarkdown(`\n👉 **[Reveal impact path in Sidebar...](command:impact-guard.analyzeSymbol?${argsStr})**\n`);
      }
    }
    
    return new vscode.Hover(markdown);
  }
}

export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}

async function findWorkspaceFiles(): Promise<string[]> {
  const config = vscode.workspace.getConfiguration('impactGuard');
  const extraExcludes = config.get<string[]>('exclude') || [];
  
  // Build exclude glob
  let excludeGlob = '**/node_modules/**';
  if (extraExcludes.length > 0) {
    const formattedExcludes = extraExcludes.map(p => {
      let cleaned = p.trim().replace(/^\/|\\/, '').replace(/\/|\\$/, '');
      return `**/${cleaned}/**`;
    });
    excludeGlob = `{**/node_modules/**,${formattedExcludes.join(',')}}`;
  }

  const uris = await vscode.workspace.findFiles(
    '**/*.{ts,html,css,scss,less}',
    excludeGlob
  );
  return uris.map(uri => uri.fsPath);
}
