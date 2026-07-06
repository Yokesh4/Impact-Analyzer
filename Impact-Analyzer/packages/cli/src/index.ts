#!/usr/bin/env node
import * as path from 'path';
import * as fs from 'fs';
import { WorkspaceIndexer } from '@impact-guard/engine';
import { DependencyGraph } from '@impact-guard/engine';
import { ImpactEngine } from '@impact-guard/engine';
import { ImpactReport } from '@impact-guard/engine';

function printHelp() {
  console.log(`
Impact Guard CLI - Enterprise Line-Level Impact Analyzer

Usage:
  impact-guard [options]

Options:
  --workspace <path>   Path to the workspace root directory (default: current directory)
  --file <path>        Path to the modified file to analyze
  --line <number>      Line number of the change (requires --file)
  --symbol <id>        Analyze impact of a specific symbol ID
  --rebuild            Force a full re-index of the workspace (ignores cache)
  --export <file>      Export the impact report in markdown or JSON format
  --fail-on-critical   Exit with code 1 if critical risk is detected
  --help               Show this help message
`);
}

async function run() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  let workspacePath = process.cwd();
  let filePath = '';
  let lineNum = 0;
  let symbolId = '';
  let rebuild = false;
  let exportPath = '';
  let failOnCritical = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace') {
      workspacePath = path.resolve(args[++i]);
    } else if (args[i] === '--file') {
      filePath = path.resolve(args[++i]);
    } else if (args[i] === '--line') {
      lineNum = parseInt(args[++i], 10);
    } else if (args[i] === '--symbol') {
      symbolId = args[++i];
    } else if (args[i] === '--rebuild') {
      rebuild = true;
    } else if (args[i] === '--export') {
      exportPath = args[++i];
    } else if (args[i] === '--fail-on-critical') {
      failOnCritical = true;
    }
  }

  if (!fs.existsSync(workspacePath)) {
    console.error(`Workspace directory does not exist: ${workspacePath}`);
    process.exit(1);
  }

  const cachePath = path.join(workspacePath, '.impact-guard-cache.json');
  console.log(`Analyzing workspace: ${workspacePath}`);
  
  const indexer = new WorkspaceIndexer(workspacePath);
  let loaded = false;
  if (!rebuild) {
    loaded = indexer.loadCache(cachePath);
    if (loaded) {
      console.log('Loaded index from cache.');
    }
  }

  if (!loaded) {
    console.log('Indexing workspace files...');
    await indexer.indexWorkspace((percentage, msg) => {
      process.stdout.write(`\rProgress: ${percentage}% - ${msg.padEnd(50)}`);
    });
    console.log('\nIndexing complete. Saving cache...');
    indexer.saveCache(cachePath);
  }

  console.log('Building dependency graph...');
  const graph = new DependencyGraph();
  graph.buildGraph(indexer);
  console.log(`Graph build complete. Nodes: ${graph.nodes.size}, Edges: ${graph.edges.size}`);

  const impactEngine = new ImpactEngine(indexer, graph);
  let report: ImpactReport | null = null;

  if (symbolId) {
    console.log(`Running impact analysis for symbol: ${symbolId}`);
    report = impactEngine.analyzeImpact(symbolId);
  } else if (filePath && lineNum > 0) {
    console.log(`Running impact analysis for file: ${filePath} at line: ${lineNum}`);
    report = impactEngine.analyzeLineImpact(filePath, lineNum);
  } else if (filePath) {
    console.log(`Running impact analysis for file: ${filePath}`);
    const absPath = path.resolve(filePath);
    const fileIndex = indexer.files[absPath];
    if (fileIndex && fileIndex.symbols.length > 0) {
      const sym = fileIndex.symbols[0];
      console.log(`Triggering on first symbol: ${sym.id}`);
      report = impactEngine.analyzeImpact(sym.id);
    } else {
      console.log('No symbols found in this file to trigger analysis.');
    }
  } else {
    console.log('\n--- Workspace Impact Summary ---');
    console.log(`Total indexed files: ${Object.keys(indexer.files).length}`);
    console.log(`Total components   : ${Array.from(graph.nodes.values()).filter(n => n.type === 'component').length}`);
    console.log(`Total services     : ${Array.from(graph.nodes.values()).filter(n => n.type === 'service').length}`);
    console.log(`Total modules      : ${Array.from(graph.nodes.values()).filter(n => n.type === 'module').length}`);
    console.log(`Total route pages  : ${Array.from(graph.nodes.values()).filter(n => n.type === 'route').length}`);
    console.log(`Total style rules  : ${Array.from(graph.nodes.values()).filter(n => n.type === 'css-selector').length}`);
    process.exit(0);
  }

  if (report) {
    printReport(report);

    if (exportPath) {
      const isJson = exportPath.endsWith('.json');
      const output = isJson 
        ? JSON.stringify(report, null, 2) 
        : generateMarkdownReport(report);
      fs.writeFileSync(exportPath, output, 'utf-8');
      console.log(`Report successfully exported to: ${exportPath}`);
    }

    if (failOnCritical && report.overallRisk === 'critical') {
      console.error('\nFAIL: Critical impact risk detected!');
      process.exit(1);
    }
  }
}

function printReport(report: ImpactReport) {
  console.log('\n=========================================');
  console.log('         IMPACT ANALYSIS REPORT          ');
  console.log('=========================================');
  if (report.triggerSymbol) {
    console.log(`Trigger Symbol : ${report.triggerSymbol.name} (${report.triggerSymbol.type})`);
    if (report.triggerSymbol.location && report.triggerSymbol.location.filePath) {
      console.log(`Location       : ${report.triggerSymbol.location.filePath}:${report.triggerSymbol.location.startLine}`);
    }
  } else {
    console.log(`Trigger Symbol : Unknown / External`);
  }
  console.log(`Overall Risk   : ${report.overallRisk.toUpperCase()}`);
  console.log(`Impacted Count : ${report.affectedNodes.length} nodes\n`);

  if (report.affectedNodes.length > 0) {
    console.log('Affected Downstream Nodes:');
    for (const node of report.affectedNodes) {
      console.log(`  - [${node.risk.toUpperCase()}] ${node.name} (${node.type})`);
      console.log(`    Path: ${node.pathFromTrigger.join(' -> ')}`);
    }
  } else {
    console.log('No downstream impacts detected.');
  }
  console.log('=========================================\n');
}

function generateMarkdownReport(report: ImpactReport): string {
  let md = `# Impact Guard Analysis Report\n\n`;
  if (report.triggerSymbol) {
    md += `**Trigger Symbol:** \`${report.triggerSymbol.name}\` (${report.triggerSymbol.type})\n`;
    if (report.triggerSymbol.location && report.triggerSymbol.location.filePath) {
      md += `**Location:** \`${report.triggerSymbol.location.filePath}:${report.triggerSymbol.location.startLine}\`\n\n`;
    }
  }
  md += `## Summary\n\n`;
  md += `- **Overall Risk:** **${report.overallRisk.toUpperCase()}**\n`;
  md += `- **Impacted Count:** ${report.affectedNodes.length} nodes\n\n`;
  md += `## Impacted Downstream Nodes\n\n`;
  
  if (report.affectedNodes.length > 0) {
    md += `| Risk | Node Name | Type | Impact Path |\n`;
    md += `| --- | --- | --- | --- |\n`;
    for (const node of report.affectedNodes) {
      md += `| **${node.risk.toUpperCase()}** | ${node.name} | ${node.type} | \`${node.pathFromTrigger.join(' -> ')}\` |\n`;
    }
  } else {
    md += `*No downstream impacts detected.*\n`;
  }
  return md;
}

run().catch(err => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
