import { WorkspaceSymbol, WorkspaceReference, SourceLocation } from '../types.js';

export function parseHTML(filePath: string, content: string): { symbols: WorkspaceSymbol[]; references: WorkspaceReference[] } {
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

      if (attrName.startsWith('[') && attrName.endsWith(']')) {
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
