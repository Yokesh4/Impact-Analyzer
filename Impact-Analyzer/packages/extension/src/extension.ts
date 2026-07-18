import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { WorkspaceIndexer, IndexingResult, DependencyGraph, ImpactEngine, ImpactReport, WorkspaceSymbol, RiskEngine, ImpactGroupedCounts } from '@impact-guard/engine';

let indexer: WorkspaceIndexer;
let graph: DependencyGraph;
let impactEngine: ImpactEngine;
let diagnosticCollection: vscode.DiagnosticCollection;
let treeDataProvider: ImpactTreeProvider;
let statusBarItem: vscode.StatusBarItem;

// Highlight decoration type for sidebar click highlighting
let highlightDecorationType: vscode.TextEditorDecorationType;
let highlightClearTimeout: ReturnType<typeof setTimeout> | null = null;

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

  // Create highlight decoration for sidebar click
  highlightDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 213, 79, 0.35)',
    borderColor: 'rgba(255, 152, 0, 0.6)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderRadius: '3px',
    isWholeLine: false,
    overviewRulerColor: 'rgba(255, 152, 0, 0.8)',
    overviewRulerLane: vscode.OverviewRulerLane.Center
  });

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(shield) Impact Guard: Initializing...';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  treeDataProvider = new ImpactTreeProvider();
  vscode.window.registerTreeDataProvider('impact-guard-view', treeDataProvider);

  diagnosticCollection = vscode.languages.createDiagnosticCollection('impact-guard');
  context.subscriptions.push(diagnosticCollection);

  const cacheFilePath = path.join(workspaceRoot, '.impact-guard-cache.json');

  // Ask user which indexing mode to use
  const config = vscode.workspace.getConfiguration('impactGuard');
  const configuredMode = config.get<string>('indexingMode') || 'prompt';

  if (configuredMode === 'prompt') {
    promptIndexingMode(context, workspaceRoot, cacheFilePath);
  } else {
    runIndexing(context, workspaceRoot, cacheFilePath, configuredMode as 'full' | 'style-focused');
  }

  // Register file save watcher
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const ext = path.extname(doc.fileName).toLowerCase();
      if (['.ts', '.html', '.css', '.scss', '.less', '.jsp'].includes(ext)) {
        statusBarItem.text = '$(sync~spin) Impact Guard: Re-indexing...';
        try {
          const changed = await indexer.indexFile(doc.fileName, true);
          if (changed) {
            graph.buildGraph(indexer);
            indexer.saveCache(cacheFilePath);
          }
          updateStatusBarActive();
          triggerLineAnalysisForActiveEditor();
        } catch (err) {
          console.error('Error during Impact Guard file save auto-indexing:', err);
          statusBarItem.text = '$(warning) Impact Guard: Re-index failed';
          statusBarItem.tooltip = `Error: ${err instanceof Error ? err.message : String(err)}`;
          statusBarItem.command = 'impact-guard.rebuildIndex';
        }
      }
    })
  );

  // Register commands
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
      const config = vscode.workspace.getConfiguration('impactGuard');
      const mode = config.get<string>('indexingMode') || 'prompt';
      if (mode === 'prompt') {
        promptIndexingMode(context, workspaceRoot, cacheFilePath);
      } else {
        runIndexing(context, workspaceRoot, cacheFilePath, mode as 'full' | 'style-focused');
      }
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
    }),

    // Open file and highlight the matched class range
    vscode.commands.registerCommand('impact-guard.openAndHighlight', async (filePath: string, startLine: number, startCol: number, endLine: number, endCol: number) => {
      if (!filePath) return;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      
      const start = new vscode.Position(Math.max(0, startLine - 1), Math.max(0, startCol - 1));
      const end = new vscode.Position(Math.max(0, endLine - 1), Math.max(0, endCol - 1));
      const range = new vscode.Range(start, end);

      // Set selection and reveal the range
      editor.selection = new vscode.Selection(start, end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

      // Apply highlight decoration
      editor.setDecorations(highlightDecorationType, [{ range }]);

      // Auto-clear highlight after 5 seconds
      if (highlightClearTimeout) {
        clearTimeout(highlightClearTimeout);
      }
      highlightClearTimeout = setTimeout(() => {
        editor.setDecorations(highlightDecorationType, []);
        highlightClearTimeout = null;
      }, 5000);
    }),

    vscode.commands.registerCommand('impact-guard.showIndexingLog', () => {
      const result = indexer.getLastIndexingResult();
      if (!result) {
        vscode.window.showInformationMessage('No indexing has been performed yet.');
        return;
      }
      let msg = `Indexing Mode: ${result.mode === 'style-focused' ? 'Style-Focused' : 'Full Workspace'}\n`;
      msg += `Files: ${result.successCount}/${result.totalFiles} indexed successfully\n`;
      if (result.errorCount > 0) {
        msg += `\nErrors (${result.errorCount}):\n`;
        for (const err of result.errors.slice(0, 10)) {
          msg += `  - ${path.basename(err.filePath)}: ${err.error}\n`;
        }
        if (result.errors.length > 10) {
          msg += `  ... and ${result.errors.length - 10} more\n`;
        }
      }
      vscode.window.showInformationMessage(msg, { modal: true });
    }),

    vscode.commands.registerCommand('impact-guard.switchIndexingMode', async () => {
      promptIndexingMode(context, workspaceRoot, cacheFilePath);
    })
  );

  // Register command aliases to handle platform runner issues (slicing "command:impact" and appending line number)
  context.subscriptions.push(
    vscode.commands.registerCommand('-guard.analyzeSymbol', async (symbolId?: string) => {
      vscode.commands.executeCommand('impact-guard.analyzeSymbol', symbolId);
    }),
    vscode.commands.registerCommand('-guard.analyzeFile', async () => {
      vscode.commands.executeCommand('impact-guard.analyzeFile');
    }),
    vscode.commands.registerCommand('-guard.analyzeWorkspace', async () => {
      vscode.commands.executeCommand('impact-guard.analyzeWorkspace');
    }),
    vscode.commands.registerCommand('-guard.rebuildIndex', async () => {
      vscode.commands.executeCommand('impact-guard.rebuildIndex');
    }),
    vscode.commands.registerCommand('-guard.showDependencyGraph', () => {
      vscode.commands.executeCommand('impact-guard.showDependencyGraph');
    }),
    vscode.commands.registerCommand('-guard.exportReport', async () => {
      vscode.commands.executeCommand('impact-guard.exportReport');
    }),
    vscode.commands.registerCommand('-guard.showIndexingLog', () => {
      vscode.commands.executeCommand('impact-guard.showIndexingLog');
    }),
    vscode.commands.registerCommand('-guard.switchIndexingMode', () => {
      vscode.commands.executeCommand('impact-guard.switchIndexingMode');
    })
  );

  // Register dynamic line number handlers for CodeLens execution in the mock runner
  for (let line = 1; line <= 3000; line++) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`-guard.analyzeSymbol/${line}`, () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const symbol = impactEngine.findSymbolAtLine(editor.document.fileName, line);
          if (symbol) {
            runImpactAnalysis(symbol.id);
            vscode.commands.executeCommand('impact-guard-view.focus');
          } else {
            vscode.window.showWarningMessage(`No symbol found at line ${line}.`);
          }
        }
      }),
      vscode.commands.registerCommand(`impact-guard.analyzeSymbol/${line}`, () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const symbol = impactEngine.findSymbolAtLine(editor.document.fileName, line);
          if (symbol) {
            runImpactAnalysis(symbol.id);
            vscode.commands.executeCommand('impact-guard-view.focus');
          } else {
            vscode.window.showWarningMessage(`No symbol found at line ${line}.`);
          }
        }
      })
    );
  }

  const docSelector: vscode.DocumentFilter[] = [
    { scheme: 'file', language: 'typescript' },
    { scheme: 'file', language: 'html' },
    { scheme: 'file', language: 'css' },
    { scheme: 'file', language: 'scss' },
    { scheme: 'file', language: 'less' },
    { scheme: 'file', language: 'jsp' },
    { scheme: 'file', pattern: '**/*.jsp' }
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

      // Clear highlight on cursor move
      if (highlightClearTimeout) {
        clearTimeout(highlightClearTimeout);
        highlightClearTimeout = null;
      }
      editor.setDecorations(highlightDecorationType, []);
    })
  );
}

// ─── Indexing Mode Prompt ─────────────────────────────────────────

async function promptIndexingMode(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  cacheFilePath: string
) {
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: '$(telescope) Style-Focused (Recommended)',
        description: 'Index only open style files and their @import chains — fast & accurate',
        detail: 'Scans .less, .css, .scss files currently open + their imports + all HTML/JSP pages',
        value: 'style-focused' as const
      },
      {
        label: '$(globe) Full Workspace',
        description: 'Index all supported files in the workspace — comprehensive',
        detail: 'Scans all .ts, .html, .css, .scss, .less, .jsp files',
        value: 'full' as const
      }
    ],
    {
      placeHolder: 'Select Impact Guard indexing mode',
      title: 'Impact Guard — Choose Indexing Strategy'
    }
  );

  if (choice) {
    runIndexing(context, workspaceRoot, cacheFilePath, choice.value);
  } else {
    // Default to style-focused if dismissed
    runIndexing(context, workspaceRoot, cacheFilePath, 'style-focused');
  }
}

async function runIndexing(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  cacheFilePath: string,
  mode: 'full' | 'style-focused'
) {
  statusBarItem.text = '$(sync~spin) Impact Guard: Indexing...';
  statusBarItem.tooltip = `Mode: ${mode === 'style-focused' ? 'Style-Focused' : 'Full Workspace'}`;

  vscode.window.withProgress({
    location: vscode.ProgressLocation.Window,
    title: "Impact Guard Indexing",
    cancellable: false
  }, async (progress) => {
    try {
      let loaded = indexer.loadCache(cacheFilePath);
      if (!loaded) {
        let result: IndexingResult;

        if (mode === 'style-focused') {
          // Collect open style files
          const openStyleFiles = getOpenStyleFiles();
          
          if (openStyleFiles.length === 0) {
            // Fallback: find all root style files in workspace
            const filePaths = await findWorkspaceStyleFiles();
            result = await indexer.indexStyleFocused(filePaths, (percentage, msg) => {
              progress.report({ message: `${percentage}% - ${msg}` });
            });
          } else {
            result = await indexer.indexStyleFocused(openStyleFiles, (percentage, msg) => {
              progress.report({ message: `${percentage}% - ${msg}` });
            });
          }
        } else {
          const filePaths = await findWorkspaceFiles();
          result = await indexer.indexWorkspace((percentage, msg) => {
            progress.report({ message: `${percentage}% - ${msg}` });
          }, filePaths);
        }

        indexer.saveCache(cacheFilePath);
      }
      graph.buildGraph(indexer);
      updateStatusBarActive();
    } catch (err) {
      console.error('Error during Impact Guard activation indexing:', err);
      const result = indexer.getLastIndexingResult();
      if (result && result.successCount > 0) {
        // Partial success — graph may still be usable
        try {
          graph.buildGraph(indexer);
          statusBarItem.text = `$(shield) Impact Guard: Active (${result.errorCount} warnings)`;
          statusBarItem.tooltip = `${result.successCount}/${result.totalFiles} files indexed. Click to view errors.`;
          statusBarItem.command = 'impact-guard.showIndexingLog';
        } catch {
          setStatusBarError();
        }
      } else {
        setStatusBarError();
      }
    }
  });
}

function updateStatusBarActive() {
  const result = indexer.getLastIndexingResult();
  const fileCount = Object.keys(indexer.files).length;
  const modeLabel = result?.mode === 'style-focused' ? 'Style-Focused' : 'Full';
  
  if (result && result.errorCount > 0) {
    statusBarItem.text = `$(shield) Impact Guard: Active (${result.errorCount} warnings)`;
    statusBarItem.tooltip = `${modeLabel} · ${fileCount} files indexed · ${result.errorCount} errors. Click to view log.`;
    statusBarItem.command = 'impact-guard.showIndexingLog';
  } else {
    statusBarItem.text = `$(shield) Impact Guard: Active`;
    statusBarItem.tooltip = `${modeLabel} · ${fileCount} files indexed. Click to show dependency graph.`;
    statusBarItem.command = 'impact-guard.showDependencyGraph';
  }
}

function setStatusBarError() {
  statusBarItem.text = '$(error) Impact Guard: Failed';
  statusBarItem.tooltip = 'Indexing failed completely. Click to retry.';
  statusBarItem.command = 'impact-guard.rebuildIndex';
}

function getOpenStyleFiles(): string[] {
  const styleExts = ['.less', '.css', '.scss', '.sass'];
  const openFiles: string[] = [];
  
  for (const doc of vscode.workspace.textDocuments) {
    const ext = path.extname(doc.fileName).toLowerCase();
    if (styleExts.includes(ext) && !doc.isUntitled) {
      openFiles.push(doc.fileName);
    }
  }
  
  return openFiles;
}

// ─── Core Analysis Functions ──────────────────────────────────────

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
      criticalList.push(`${node.name} (${node.type}) -> affects ${downCount} areas`);
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
      const counts = report.groupedCounts;
      const countSummary = counts
        ? `${counts.pages} pages, ${counts.components} components affected`
        : `${report.affectedNodes.length} areas affected`;
      const diagnostic = new vscode.Diagnostic(
        range,
        `Impact Guard: ${report.overallRisk.toUpperCase()} risk — ${countSummary}`,
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
  
  if (report.groupedCounts) {
    const c = report.groupedCounts;
    md += `\n## Impact Summary\n\n`;
    md += `| Category | Count |\n|----------|-------|\n`;
    if (c.pages > 0) md += `| Pages | ${c.pages} |\n`;
    if (c.components > 0) md += `| Components | ${c.components} |\n`;
    if (c.modules > 0) md += `| Modules | ${c.modules} |\n`;
    if (c.routes > 0) md += `| Routes | ${c.routes} |\n`;
    if (c.selectors > 0) md += `| Style Selectors | ${c.selectors} |\n`;
  }

  md += `\n## Affected Areas\n\n`;
  
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

// ─── Risk Icon Helpers ────────────────────────────────────────────

function getRiskIcon(risk: string): vscode.ThemeIcon {
  switch (risk) {
    case 'critical': return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    case 'high': return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    case 'medium': return new vscode.ThemeIcon('info', new vscode.ThemeColor('notificationsInfoIcon.foreground'));
    default: return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
  }
}

function getRiskLabel(risk: string): string {
  switch (risk) {
    case 'critical': return 'CRITICAL';
    case 'high': return 'HIGH';
    case 'medium': return 'MEDIUM';
    default: return 'LOW';
  }
}

function getTypeIcon(type: string): vscode.ThemeIcon {
  switch (type) {
    case 'html-page':
    case 'jsp-page':
      return new vscode.ThemeIcon('globe');
    case 'component':
      return new vscode.ThemeIcon('symbol-class');
    case 'module':
      return new vscode.ThemeIcon('package');
    case 'route':
      return new vscode.ThemeIcon('symbol-interface');
    case 'css-selector':
      return new vscode.ThemeIcon('symbol-color');
    case 'service':
      return new vscode.ThemeIcon('symbol-method');
    default:
      return new vscode.ThemeIcon('file');
  }
}

// ─── Tree View ────────────────────────────────────────────────────

class TreeItemNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly description?: string,
    public readonly iconPath?: vscode.ThemeIcon,
    public readonly command?: vscode.Command,
    public readonly tooltipText?: string
  ) {
    super(label, collapsibleState);
    if (command) {
      this.command = command;
    }
    if (tooltipText) {
      this.tooltip = tooltipText;
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
      return Promise.resolve([new TreeItemNode('No active impact report. Hover/click a symbol.', vscode.TreeItemCollapsibleState.None, undefined, new vscode.ThemeIcon('info'))]);
    }

    if (!element) {
      // Root level
      const riskIcon = getRiskIcon(this.report.overallRisk);
      const triggerName = this.report.triggerSymbol?.name || 'Unknown';
      const triggerType = this.report.triggerSymbol?.type || '';
      const counts = this.report.groupedCounts;

      const rootItems: TreeItemNode[] = [
        new TreeItemNode(
          `${triggerName}`,
          vscode.TreeItemCollapsibleState.None,
          triggerType,
          new vscode.ThemeIcon('symbol-property')
        ),
        new TreeItemNode(
          `Risk: ${getRiskLabel(this.report.overallRisk)}`,
          vscode.TreeItemCollapsibleState.None,
          undefined,
          riskIcon
        )
      ];

      // Add category groups with counts (excluding non-existent files)
      const htmlPages = this.report.affectedNodes.filter(n => n.type === 'html-page' && n.filePath && fs.existsSync(n.filePath));
      const jspPages = this.report.affectedNodes.filter(n => n.type === 'jsp-page' && n.filePath && fs.existsSync(n.filePath));
      const components = this.report.affectedNodes.filter(n => n.type === 'component' && n.filePath && fs.existsSync(n.filePath));
      const modules = this.report.affectedNodes.filter(n => n.type === 'module' && n.filePath && fs.existsSync(n.filePath));
      const routes = this.report.affectedNodes.filter(n => n.type === 'route' && n.filePath && fs.existsSync(n.filePath));
      const selectors = this.report.affectedNodes.filter(n => (n.type === 'css-selector' || n.type === 'scss-variable' || n.type === 'scss-mixin') && n.filePath && fs.existsSync(n.filePath));

      if (htmlPages.length > 0) {
        rootItems.push(new TreeItemNode(
          `Affected HTML Pages (${htmlPages.length})`,
          vscode.TreeItemCollapsibleState.Collapsed,
          undefined,
          new vscode.ThemeIcon('globe')
        ));
      }
      if (jspPages.length > 0) {
        rootItems.push(new TreeItemNode(
          `Affected JSP Pages (${jspPages.length})`,
          vscode.TreeItemCollapsibleState.Collapsed,
          undefined,
          new vscode.ThemeIcon('file-code')
        ));
      }
      if (components.length > 0) {
        rootItems.push(new TreeItemNode(
          `Affected Components (${components.length})`,
          vscode.TreeItemCollapsibleState.Collapsed,
          undefined,
          new vscode.ThemeIcon('symbol-class')
        ));
      }
      if (modules.length > 0) {
        rootItems.push(new TreeItemNode(
          `Affected Modules (${modules.length})`,
          vscode.TreeItemCollapsibleState.Collapsed,
          undefined,
          new vscode.ThemeIcon('package')
        ));
      }
      if (routes.length > 0) {
        rootItems.push(new TreeItemNode(
          `Affected Routes (${routes.length})`,
          vscode.TreeItemCollapsibleState.Collapsed,
          undefined,
          new vscode.ThemeIcon('symbol-interface')
        ));
      }
      if (selectors.length > 0) {
        rootItems.push(new TreeItemNode(
          `Affected Selectors (${selectors.length})`,
          vscode.TreeItemCollapsibleState.Collapsed,
          undefined,
          new vscode.ThemeIcon('symbol-color')
        ));
      }

      // Hierarchy chain if available
      if (this.report.hierarchyChain && this.report.hierarchyChain.length > 0) {
        rootItems.push(new TreeItemNode(
          `Nesting Hierarchy (${this.report.hierarchyChain.length})`,
          vscode.TreeItemCollapsibleState.Collapsed,
          undefined,
          new vscode.ThemeIcon('list-tree')
        ));
      }

      return Promise.resolve(rootItems);
    }

    // Children for each category
    const label = element.label;

    if (label.startsWith('Affected HTML Pages')) {
      return Promise.resolve(this.buildNodeItems(
        this.report.affectedNodes.filter(n => n.type === 'html-page' && n.filePath && fs.existsSync(n.filePath)),
        new vscode.ThemeIcon('globe')
      ));
    }
    if (label.startsWith('Affected JSP Pages')) {
      return Promise.resolve(this.buildNodeItems(
        this.report.affectedNodes.filter(n => n.type === 'jsp-page' && n.filePath && fs.existsSync(n.filePath)),
        new vscode.ThemeIcon('file-code')
      ));
    }
    if (label.startsWith('Affected Components')) {
      return Promise.resolve(this.buildNodeItems(
        this.report.affectedNodes.filter(n => n.type === 'component' && n.filePath && fs.existsSync(n.filePath)),
        new vscode.ThemeIcon('symbol-class')
      ));
    }
    if (label.startsWith('Affected Modules')) {
      return Promise.resolve(this.buildNodeItems(
        this.report.affectedNodes.filter(n => n.type === 'module' && n.filePath && fs.existsSync(n.filePath)),
        new vscode.ThemeIcon('package')
      ));
    }
    if (label.startsWith('Affected Routes')) {
      return Promise.resolve(this.buildNodeItems(
        this.report.affectedNodes.filter(n => n.type === 'route' && n.filePath && fs.existsSync(n.filePath)),
        new vscode.ThemeIcon('symbol-interface')
      ));
    }
    if (label.startsWith('Affected Selectors')) {
      return Promise.resolve(this.buildNodeItems(
        this.report.affectedNodes.filter(n => (n.type === 'css-selector' || n.type === 'scss-variable' || n.type === 'scss-mixin') && n.filePath && fs.existsSync(n.filePath)),
        new vscode.ThemeIcon('symbol-color')
      ));
    }
    if (label.startsWith('Nesting Hierarchy') && this.report.hierarchyChain) {
      const items = this.report.hierarchyChain.map(entry => {
        const indent = '  '.repeat(entry.depth - 1);
        return new TreeItemNode(
          `${indent}${entry.selector}`,
          vscode.TreeItemCollapsibleState.None,
          `${entry.affectedCount} affected`,
          new vscode.ThemeIcon('list-tree')
        );
      });
      return Promise.resolve(items);
    }

    return Promise.resolve([]);
  }

  private buildNodeItems(nodes: import('@impact-guard/engine').ImpactNode[], defaultIcon: vscode.ThemeIcon): TreeItemNode[] {
    return nodes.map(n => {
      const riskIcon = getRiskIcon(n.risk);
      const relPath = n.filePath ? path.relative(indexer.workspaceRoot, n.filePath).replace(/\\/g, '/') : '';
      const displayDescription = relPath ? path.dirname(relPath) : '';
      
      const tooltipText = `File: ${relPath}\nRisk: ${n.risk.toUpperCase()}\nPath: ${n.pathFromTrigger.join(' -> ')}`;
      
      // Determine location for highlight command
      let highlightCmd: vscode.Command | undefined;
      if (n.filePath) {
        // Try to find the symbol location in the indexer
        const fileIndex = indexer.files[n.filePath];
        if (fileIndex) {
          const sym = fileIndex.symbols.find(s => s.id === n.symbolId || s.name === n.name);
          if (sym) {
            highlightCmd = {
              title: 'Open & Highlight',
              command: 'impact-guard.openAndHighlight',
              arguments: [n.filePath, sym.location.startLine, sym.location.startCol, sym.location.endLine, sym.location.endCol]
            };
          }
        }
        if (!highlightCmd) {
          highlightCmd = {
            title: 'Open & Highlight',
            command: 'impact-guard.openAndHighlight',
            arguments: [n.filePath, 1, 1, 1, 1]
          };
        }
      }

      return new TreeItemNode(
        n.name,
        vscode.TreeItemCollapsibleState.None,
        displayDescription,
        riskIcon,
        highlightCmd,
        tooltipText
      );
    });
  }
}

// ─── CodeLens Provider ────────────────────────────────────────────

class ImpactCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
    if (!indexer) return [];
    
    const absPath = path.resolve(document.fileName);
    const fileIndex = indexer.files[absPath];
    if (!fileIndex) return [];

    const lenses: vscode.CodeLens[] = [];
    const processedLines = new Set<number>(); // Avoid duplicate CodeLens on same line

    for (const sym of fileIndex.symbols) {
      if (['component', 'service', 'module', 'css-selector', 'input', 'output'].includes(sym.type)) {
        // Skip duplicate lenses on same line
        if (processedLines.has(sym.location.startLine)) continue;
        processedLines.add(sym.location.startLine);

        const start = new vscode.Position(sym.location.startLine - 1, sym.location.startCol - 1);
        const end = new vscode.Position(sym.location.endLine - 1, sym.location.endCol - 1);
        const range = new vscode.Range(start, end);
        
        // Use hierarchical downstream for CSS selectors
        const isCSS = sym.id.startsWith('css:');
        const downstream = isCSS
          ? graph.getHierarchicalDownstream(sym.id)
          : graph.getDownstream(sym.id);
        
        const downCount = downstream.length;
        const risk = RiskEngine.calculateRisk(downCount, sym.type);

        // Compute grouped counts for professional display
        let pageCount = 0;
        let componentCount = 0;
        let otherCount = 0;
        for (const id of downstream) {
          const node = graph.nodes.get(id);
          if (node) {
            if (node.type === 'html-page' || node.type === 'jsp-page') pageCount++;
            else if (node.type === 'component') componentCount++;
            else otherCount++;
          }
        }

        // Build professional label with ThemeIcon-style prefix
        let riskIndicator = '$(pass)';
        if (risk === 'critical') riskIndicator = '$(error)';
        else if (risk === 'high') riskIndicator = '$(warning)';
        else if (risk === 'medium') riskIndicator = '$(info)';

        // Build count parts
        const countParts: string[] = [];
        if (pageCount > 0) countParts.push(`${pageCount} page${pageCount > 1 ? 's' : ''}`);
        if (componentCount > 0) countParts.push(`${componentCount} component${componentCount > 1 ? 's' : ''}`);
        if (otherCount > 0) countParts.push(`${otherCount} other${otherCount > 1 ? 's' : ''}`);
        
        const countStr = countParts.length > 0 ? countParts.join(' · ') : 'No impact';
        const title = `$(shield) Impact: ${countStr}  ${riskIndicator} ${getRiskLabel(risk)}`;

        const lens = new vscode.CodeLens(range, {
          title,
          command: 'impact-guard.analyzeSymbol',
          arguments: [sym.id]
        });
        lenses.push(lens);
      }
    }
    return lenses;
  }
}

// ─── Hover Provider ───────────────────────────────────────────────

class ImpactHoverProvider implements vscode.HoverProvider {
  provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
    if (!indexer || !impactEngine) return null;

    const line = position.line + 1;
    const symbol = impactEngine.findSymbolAtLine(document.fileName, line);
    if (!symbol) return null;

    // Get all symbols on this line for hierarchy context
    const allSymbolsAtLine = impactEngine.findAllSymbolsAtLine(document.fileName, line);

    // Compute impact using hierarchical analysis
    const isCSS = symbol.id.startsWith('css:');
    const downstream = isCSS
      ? graph.getHierarchicalDownstream(symbol.id)
      : graph.getDownstream(symbol.id);
    const downCount = downstream.length;
    const risk = RiskEngine.calculateRisk(downCount, symbol.type);
    const report = impactEngine.analyzeImpact(symbol.id);

    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;
    markdown.supportThemeIcons = true;
    
    // ─── Header ───
    markdown.appendMarkdown(`### $(shield) Impact Guard — Analysis\n\n`);
    
    // ─── Trigger Info ───
    markdown.appendMarkdown(`$(symbol-property) **Trigger:** \`${symbol.name}\` _(${symbol.type})_\n\n`);

    // ─── Hierarchy Chain (for CSS selectors) ───
    if (isCSS && report.hierarchyChain && report.hierarchyChain.length > 0) {
      markdown.appendMarkdown(`---\n\n`);
      markdown.appendMarkdown(`$(list-tree) **Selector Hierarchy:**\n\n`);
      
      // Show current selector as root
      markdown.appendMarkdown(`\`${symbol.name}\`\n\n`);
      
      for (const entry of report.hierarchyChain) {
        const indent = '&nbsp;&nbsp;'.repeat(entry.depth);
        markdown.appendMarkdown(`${indent}$(arrow-right) \`${entry.selector}\` _(${entry.affectedCount} affected)_\n\n`);
      }
    }

    // ─── Grouped Impact Counts ───
    markdown.appendMarkdown(`---\n\n`);
    markdown.appendMarkdown(`$(graph) **Impact Summary:**\n\n`);

    if (report.groupedCounts) {
      const c = report.groupedCounts;
      if (c.pages > 0) {
        markdown.appendMarkdown(`$(globe) **Pages:** ${c.pages}\n\n`);
      }
      if (c.components > 0) {
        markdown.appendMarkdown(`$(symbol-class) **Components:** ${c.components}\n\n`);
      }
      if (c.modules > 0) {
        markdown.appendMarkdown(`$(package) **Modules:** ${c.modules}\n\n`);
      }
      if (c.routes > 0) {
        markdown.appendMarkdown(`$(symbol-interface) **Routes:** ${c.routes}\n\n`);
      }
      if (c.selectors > 0) {
        markdown.appendMarkdown(`$(symbol-color) **Selectors:** ${c.selectors}\n\n`);
      }
      if (c.pages === 0 && c.components === 0 && c.modules === 0 && c.routes === 0 && c.selectors === 0) {
        markdown.appendMarkdown(`_No downstream impacts detected._\n\n`);
      }
    } else {
      markdown.appendMarkdown(`Total affected: ${downCount}\n\n`);
    }

    // ─── Risk Level ───
    let riskIcon = '$(pass)';
    if (risk === 'critical') riskIcon = '$(error)';
    else if (risk === 'high') riskIcon = '$(warning)';
    else if (risk === 'medium') riskIcon = '$(info)';
    
    markdown.appendMarkdown(`---\n\n`);
    markdown.appendMarkdown(`${riskIcon} **Risk Level:** **${getRiskLabel(risk)}**\n\n`);

    // ─── Top Affected Items Preview ───
    if (downCount > 0) {
      const pages = report.affectedNodes.filter(n => n.type === 'html-page' || n.type === 'jsp-page');
      const components = report.affectedNodes.filter(n => n.type === 'component');
      const previewItems = [...pages, ...components].slice(0, 4);
      
      if (previewItems.length > 0) {
        markdown.appendMarkdown(`**Top Affected:**\n\n`);
        for (const item of previewItems) {
          const icon = item.type === 'html-page' || item.type === 'jsp-page' ? '$(globe)' : '$(symbol-class)';
          markdown.appendMarkdown(`${icon} \`${item.name}\`\n\n`);
        }
      }

      // ─── Show in Sidebar Link ───
      const argsStr = encodeURIComponent(JSON.stringify([symbol.id]));
      markdown.appendMarkdown(`---\n\n`);
      markdown.appendMarkdown(`$(link-external) **[Show full impact in Sidebar...](command:impact-guard.analyzeSymbol?${argsStr})**\n`);
    }
    
    return new vscode.Hover(markdown);
  }
}

// ─── Utility Functions ────────────────────────────────────────────

export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
  if (highlightClearTimeout) {
    clearTimeout(highlightClearTimeout);
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
    '**/*.{ts,html,css,scss,less,jsp}',
    excludeGlob
  );
  return uris.map(uri => uri.fsPath);
}

async function findWorkspaceStyleFiles(): Promise<string[]> {
  const config = vscode.workspace.getConfiguration('impactGuard');
  const extraExcludes = config.get<string[]>('exclude') || [];
  
  let excludeGlob = '**/node_modules/**';
  if (extraExcludes.length > 0) {
    const formattedExcludes = extraExcludes.map(p => {
      let cleaned = p.trim().replace(/^\/|\\/, '').replace(/\/|\\$/, '');
      return `**/${cleaned}/**`;
    });
    excludeGlob = `{**/node_modules/**,${formattedExcludes.join(',')}}`;
  }

  const uris = await vscode.workspace.findFiles(
    '**/*.{css,scss,less}',
    excludeGlob
  );
  return uris.map(uri => uri.fsPath);
}
