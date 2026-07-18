import { WorkspaceSymbol, WorkspaceReference, SourceLocation } from '../types.js';

export interface CSSParseResult {
  symbols: WorkspaceSymbol[];
  references: WorkspaceReference[];
  imports: string[];
}

export function parseCSS(filePath: string, content: string): CSSParseResult {
  const rawContent = content;
  // Replace single-line and multi-line comments with spaces to preserve line and column offsets
  content = content.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\r\n]/g, ' '));
  content = content.replace(/\/\/.*/g, match => match.replace(/[^\r\n]/g, ' '));

  const symbols: WorkspaceSymbol[] = [];
  const references: WorkspaceReference[] = [];
  const imports: string[] = [];

  // Extract @import paths from raw content (before comment stripping)
  const importWithOptionsRegex = /@import\s*\([^)]*\)\s*['"]([^'"]+)['"]\s*;?/g;
  const importSimpleRegex = /@import\s+['"]([^'"]+)['"]\s*;?/g;
  const importUrlRegex = /@import\s+url\(\s*['"]([^'"]+)['"]\s*\)\s*;?/g;
  let importMatch: RegExpExecArray | null;

  while ((importMatch = importWithOptionsRegex.exec(rawContent)) !== null) {
    imports.push(importMatch[1]);
  }
  while ((importMatch = importSimpleRegex.exec(rawContent)) !== null) {
    const precedingText = rawContent.substring(Math.max(0, importMatch.index - 20), importMatch.index);
    if (!/\)\s*$/.test(precedingText)) {
      imports.push(importMatch[1]);
    }
  }
  while ((importMatch = importUrlRegex.exec(rawContent)) !== null) {
    imports.push(importMatch[1]);
  }

  let currentOffset = 0;
  let currentLine = 1;
  let currentCol = 1;

  function getLineCol(targetIndex: number): { line: number; col: number } {
    if (targetIndex < currentOffset) {
      currentOffset = 0;
      currentLine = 1;
      currentCol = 1;
    }
    while (currentOffset < targetIndex && currentOffset < content.length) {
      const char = content[currentOffset];
      if (char === '\n') {
        currentLine++;
        currentCol = 1;
      } else if (char !== '\r') {
        currentCol++;
      }
      currentOffset++;
    }
    return { line: currentLine, col: currentCol };
  }

  let index = 0;
  const length = content.length;
  const selectorStack: { raw: string; resolved: string; start: number; symbolsCreated: WorkspaceSymbol[]; parentResolved: string }[] = [];

  while (index < length) {
    const char = content[index];

    if (char === '/' && content[index + 1] === '/') {
      while (index < length && content[index] !== '\n') {
        index++;
      }
      continue;
    }
    if (char === '/' && content[index + 1] === '*') {
      index += 2;
      while (index < length && !(content[index] === '*' && content[index + 1] === '/')) {
        index++;
      }
      index += 2;
      continue;
    }

    if (char === '$' || char === '@' || (char === '-' && content[index + 1] === '-')) {
      let startIdx = index;
      let name = '';
      while (index < length && (/[a-zA-Z0-9_-]/.test(content[index]) || (index === startIdx && (char === '$' || char === '@' || char === '-')))) {
        name += content[index];
        index++;
      }
      if (name === '-') {
        if (content[index] === '-') {
          name += '-';
          index++;
          while (index < length && /[a-zA-Z0-9_-]/.test(content[index])) {
            name += content[index];
            index++;
          }
        }
      }

      let checkIdx = index;
      while (checkIdx < length && /\s/.test(content[checkIdx])) {
        checkIdx++;
      }

      if (content[checkIdx] === ':') {
        index = checkIdx + 1;
        let valStart = index;
        while (index < length && content[index] !== ';' && content[index] !== '\n' && content[index] !== '}') {
          index++;
        }
        const val = content.substring(valStart, index).trim();
        const startLoc = getLineCol(startIdx);
        const endLoc = getLineCol(index);
        
        symbols.push({
          id: `var:${name}`,
          name: name,
          type: 'scss-variable',
          location: {
            filePath,
            startLine: startLoc.line,
            startCol: startLoc.col,
            endLine: endLoc.line,
            endCol: endLoc.col
          },
          metadata: { value: val }
        });
      } else {
        if (name.startsWith('@mixin') || name.startsWith('@include') || name.startsWith('@import') || name.startsWith('@media')) {
          if (name === '@mixin') {
            while (index < length && /\s/.test(content[index])) index++;
            let mStart = index;
            let mixinName = '';
            while (index < length && /[a-zA-Z0-9_-]/.test(content[index])) {
              mixinName += content[index];
              index++;
            }
            if (mixinName) {
              const startLoc = getLineCol(mStart);
              const endLoc = getLineCol(index);
              symbols.push({
                id: `mixin:${mixinName}`,
                name: mixinName,
                type: 'scss-mixin',
                location: {
                  filePath,
                  startLine: startLoc.line,
                  startCol: startLoc.col,
                  endLine: endLoc.line,
                  endCol: endLoc.col
                }
              });
            }
          } else if (name === '@include') {
            while (index < length && /\s/.test(content[index])) index++;
            let mStart = index;
            let mixinName = '';
            while (index < length && /[a-zA-Z0-9_-]/.test(content[index])) {
              mixinName += content[index];
              index++;
            }
            if (mixinName) {
              const startLoc = getLineCol(mStart);
              const endLoc = getLineCol(index);
              references.push({
                targetSymbolId: `mixin:${mixinName}`,
                location: {
                  filePath,
                  startLine: startLoc.line,
                  startCol: startLoc.col,
                  endLine: endLoc.line,
                  endCol: endLoc.col
                }
              });
            }
          }
        } else if (name.startsWith('$') || name.startsWith('@') || name.startsWith('--')) {
          const startLoc = getLineCol(startIdx);
          const endLoc = getLineCol(index);
          references.push({
            targetSymbolId: `var:${name}`,
            location: {
              filePath,
              startLine: startLoc.line,
              startCol: startLoc.col,
              endLine: endLoc.line,
              endCol: endLoc.col
            }
          });
        }
      }
      continue;
    }

    if (char === '{') {
      let scanStart = index - 1;
      while (scanStart >= 0 && content[scanStart] !== ';' && content[scanStart] !== '}' && content[scanStart] !== '{') {
        scanStart--;
      }
      let rawSelector = content.substring(scanStart + 1, index).trim();
      rawSelector = rawSelector
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*/g, '')
        .trim();

      if (rawSelector.startsWith('@media') || rawSelector.startsWith('@keyframes') || rawSelector.startsWith('@supports')) {
        selectorStack.push({ raw: rawSelector, resolved: '', start: index, symbolsCreated: [], parentResolved: '' });
        index++;
        continue;
      }

      const parent = selectorStack.length > 0 ? selectorStack[selectorStack.length - 1].resolved : '';
      let resolved = '';
      if (parent) {
        if (rawSelector.includes('&')) {
          resolved = rawSelector.replace(/&/g, parent);
        } else {
          resolved = `${parent} ${rawSelector}`;
        }
      } else {
        resolved = rawSelector;
      }

      const stackEntry = { raw: rawSelector, resolved, start: index, symbolsCreated: [] as WorkspaceSymbol[], parentResolved: parent };
      selectorStack.push(stackEntry);

      if (resolved) {
        const selectorsList = resolved.split(',');
        for (let sel of selectorsList) {
          sel = sel.trim();
          if (sel) {
            const fullStartLoc = getLineCol(index - rawSelector.length);

            // Build ancestor class list for hierarchy tracking
            const ancestorClasses: string[] = [];
            const classExtract = /\.([a-zA-Z0-9_-]+)/g;
            let cMatch: RegExpExecArray | null;
            while ((cMatch = classExtract.exec(sel)) !== null) {
              ancestorClasses.push(`.${cMatch[1]}`);
            }

            const selectorSymbol: WorkspaceSymbol = {
              id: `css:${sel}`,
              name: sel,
              type: 'css-selector',
              location: {
                filePath,
                startLine: fullStartLoc.line,
                startCol: fullStartLoc.col,
                endLine: fullStartLoc.line,
                endCol: fullStartLoc.col + rawSelector.length
              },
              metadata: {
                parentSelector: parent || null,
                ancestorClasses,
                rawSelector: rawSelector
              }
            };
            symbols.push(selectorSymbol);
            stackEntry.symbolsCreated.push(selectorSymbol);

            const classRegex = /\.([a-zA-Z0-9_-]+)/g;
            let classMatch: RegExpExecArray | null;
            while ((classMatch = classRegex.exec(sel)) !== null) {
              const className = classMatch[1];
              const startLoc = getLineCol(index - rawSelector.length + rawSelector.indexOf(classMatch[0]));
              const classSymbol: WorkspaceSymbol = {
                id: `css:.${className}`,
                name: `.${className}`,
                type: 'css-selector',
                location: {
                  filePath,
                  startLine: startLoc.line,
                  startCol: startLoc.col,
                  endLine: startLoc.line,
                  endCol: startLoc.col + classMatch[0].length
                },
                metadata: {
                  parentSelector: parent || null,
                  compoundSelector: sel,
                  ancestorClasses
                }
              };
              symbols.push(classSymbol);
              stackEntry.symbolsCreated.push(classSymbol);
            }
          }
        }
      }

      index++;
      continue;
    }

    if (char === '}') {
      const entry = selectorStack.pop();
      if (entry) {
        const endLoc = getLineCol(index);
        for (const sym of entry.symbolsCreated) {
          sym.location.endLine = endLoc.line;
          sym.location.endCol = endLoc.col + 1;
        }
      }
      index++;
      continue;
    }

    index++;
  }

  return { symbols, references, imports: [...new Set(imports)] };
}
export default parseCSS;
