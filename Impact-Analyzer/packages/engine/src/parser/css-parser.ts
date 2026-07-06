import { WorkspaceSymbol, WorkspaceReference, SourceLocation } from '../types.js';

export function parseCSS(filePath: string, content: string): { symbols: WorkspaceSymbol[]; references: WorkspaceReference[] } {
  const symbols: WorkspaceSymbol[] = [];
  const references: WorkspaceReference[] = [];

  function getLineCol(index: number): { line: number; col: number } {
    let line = 1;
    let col = 1;
    for (let i = 0; i < index; i++) {
      if (content[i] === '\n') {
        line++;
        col = 1;
      } else if (content[i] !== '\r') {
        col++;
      }
    }
    return { line, col };
  }

  let index = 0;
  const length = content.length;
  const selectorStack: { raw: string; resolved: string; start: number }[] = [];

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
      const rawSelector = content.substring(scanStart + 1, index).trim();

      if (rawSelector.startsWith('@media') || rawSelector.startsWith('@keyframes') || rawSelector.startsWith('@supports')) {
        selectorStack.push({ raw: rawSelector, resolved: '', start: index });
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

      selectorStack.push({ raw: rawSelector, resolved, start: index });

      if (resolved) {
        const selectorsList = resolved.split(',');
        for (let sel of selectorsList) {
          sel = sel.trim();
          if (sel) {
            const fullStartLoc = getLineCol(index - rawSelector.length);
            symbols.push({
              id: `css:${sel}`,
              name: sel,
              type: 'css-selector',
              location: {
                filePath,
                startLine: fullStartLoc.line,
                startCol: fullStartLoc.col,
                endLine: fullStartLoc.line,
                endCol: fullStartLoc.col + rawSelector.length
              }
            });

            const classRegex = /\.([a-zA-Z0-9_-]+)/g;
            let classMatch: RegExpExecArray | null;
            while ((classMatch = classRegex.exec(sel)) !== null) {
              const className = classMatch[1];
              const startLoc = getLineCol(index - rawSelector.length + rawSelector.indexOf(classMatch[0]));
              symbols.push({
                id: `css:.${className}`,
                name: `.${className}`,
                type: 'css-selector',
                location: {
                  filePath,
                  startLine: startLoc.line,
                  startCol: startLoc.col,
                  endLine: startLoc.line,
                  endCol: startLoc.col + classMatch[0].length
                }
              });
            }
          }
        }
      }

      index++;
      continue;
    }

    if (char === '}') {
      selectorStack.pop();
      index++;
      continue;
    }

    index++;
  }

  return { symbols, references };
}
export default parseCSS;
