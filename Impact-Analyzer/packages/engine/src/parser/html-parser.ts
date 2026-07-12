import { WorkspaceSymbol, WorkspaceReference, SourceLocation } from '../types.js';

export function parseHTML(filePath: string, content: string): { symbols: WorkspaceSymbol[]; references: WorkspaceReference[] } {
  const references: WorkspaceReference[] = [];

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

  const tagRegex = /<(\/?[a-zA-Z0-9-@]+)([^>]*?)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(content)) !== null) {
    const fullTag = match[0];
    const tagName = match[1];
    const attrsSection = match[2];
    const tagIndex = match.index;
    
    if (tagName.startsWith('/')) {
      continue;
    }

    const startLoc = getLineCol(tagIndex);
    const endLoc = getLineCol(tagIndex + fullTag.length);
    const loc: SourceLocation = {
      filePath,
      startLine: startLoc.line,
      startCol: startLoc.col,
      endLine: endLoc.line,
      endCol: endLoc.col
    };

    references.push({
      targetSymbolId: `selector:${tagName}`,
      location: loc
    });

    const attrRegex = /([\w\[\]\(\)\.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let attrMatch: RegExpExecArray | null;
    const attrSectionIndex = tagIndex + fullTag.indexOf(attrsSection);

    while ((attrMatch = attrRegex.exec(attrsSection)) !== null) {
      const attrFull = attrMatch[0];
      const attrName = attrMatch[1];
      const attrVal = attrMatch[2] || attrMatch[3] || attrMatch[4] || '';

      const attrStartLoc = getLineCol(attrSectionIndex + attrMatch.index);
      const attrEndLoc = getLineCol(attrSectionIndex + attrMatch.index + attrFull.length);
      const attrLoc: SourceLocation = {
        filePath,
        startLine: attrStartLoc.line,
        startCol: attrStartLoc.col,
        endLine: attrEndLoc.line,
        endCol: attrEndLoc.col
      };

      if (attrName.startsWith('[style.') && attrName.endsWith(']')) {
        const styleProp = attrName.slice(7, -1);
        references.push({
          targetSymbolId: `style:${styleProp}`,
          location: attrLoc
        });
      } else if (attrName.startsWith('[') && attrName.endsWith(']')) {
        const inputProp = attrName.slice(1, -1);
        references.push({
          targetSymbolId: `input:${tagName}.${inputProp}`,
          location: attrLoc
        });
      } else if (attrName.startsWith('(') && attrName.endsWith(')')) {
        const outputEvent = attrName.slice(1, -1);
        references.push({
          targetSymbolId: `output:${tagName}.${outputEvent}`,
          location: attrLoc
        });
      } else if (attrName === 'class') {
        const classes = attrVal.split(/\s+/);
        for (const cls of classes) {
          if (cls) {
            references.push({
              targetSymbolId: `css:.${cls}`,
              location: attrLoc
            });
          }
        }
      } else if (attrName.startsWith('[class.')) {
        const cls = attrName.slice(7, -1);
        references.push({
          targetSymbolId: `css:.${cls}`,
          location: attrLoc
        });
      }
    }
  }

  return { symbols: [], references };
}
