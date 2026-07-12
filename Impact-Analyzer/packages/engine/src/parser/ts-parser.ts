import * as ts from 'typescript';
import { WorkspaceSymbol, WorkspaceReference, SourceLocation } from '../types.js';
import { parseCSS } from './css-parser.js';

export function parseTypeScript(filePath: string, content: string): { symbols: WorkspaceSymbol[]; references: WorkspaceReference[] } {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const symbols: WorkspaceSymbol[] = [];
  const references: WorkspaceReference[] = [];

  function getLoc(node: ts.Node): SourceLocation {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const { line: endLine, character: endCol } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    return {
      filePath,
      startLine: line + 1,
      startCol: character + 1,
      endLine: endLine + 1,
      endCol: endCol + 1
    };
  }

  function visit(node: ts.Node) {
    if (ts.isObjectLiteralExpression(node)) {
      let pathVal: string | undefined;
      let componentVal: string | undefined;
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
          const name = prop.name.text;
          if (name === 'path') {
            pathVal = prop.initializer.getText(sourceFile).replace(/['"`]/g, '');
          } else if (name === 'component') {
            componentVal = prop.initializer.getText(sourceFile);
          }
        }
      }
      if (pathVal !== undefined && componentVal) {
        symbols.push({
          id: `route:/${pathVal}`,
          name: `/${pathVal}`,
          type: 'route',
          location: getLoc(node)
        });
        references.push({
          targetSymbolId: `component:${componentVal}`,
          location: getLoc(node)
        });
      }
    }

    if (ts.isClassDeclaration(node)) {
      const className = node.name ? node.name.text : 'AnonymousClass';
      const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
      
      let isComponent = false;
      let isService = false;
      let isModule = false;
      let componentSelector = '';

      if (decorators) {
        for (const decorator of decorators) {
          const decoratorText = decorator.getText(sourceFile);
          if (decoratorText.includes('Component')) {
            isComponent = true;
            const callExpr = decorator.expression;
            if (ts.isCallExpression(callExpr) && callExpr.arguments.length > 0) {
              const arg = callExpr.arguments[0];
              if (ts.isObjectLiteralExpression(arg)) {
                for (const prop of arg.properties) {
                  if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                    const propName = prop.name.text;
                    if (propName === 'selector') {
                      componentSelector = prop.initializer.getText(sourceFile).replace(/['"`]/g, '');
                    } else if (propName === 'styles') {
                      const stylesVal = prop.initializer;
                      if (ts.isArrayLiteralExpression(stylesVal)) {
                        for (const element of stylesVal.elements) {
                          if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element) || ts.isTemplateExpression(element)) {
                            const inlineCss = (element as any).text || element.getText(sourceFile).slice(1, -1);
                            const { symbols: cssSymbols, references: cssRefs } = parseCSS(filePath, inlineCss);
                            const { line } = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile));
                            const lineOffset = line; // 0-indexed line number in TS file
                            
                            for (const sym of cssSymbols) {
                              sym.location.startLine += lineOffset;
                              sym.location.endLine += lineOffset;
                              symbols.push(sym);
                            }
                            for (const ref of cssRefs) {
                              ref.location.startLine += lineOffset;
                              ref.location.endLine += lineOffset;
                              references.push(ref);
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          } else if (decoratorText.includes('Injectable')) {
            isService = true;
          } else if (decoratorText.includes('NgModule')) {
            isModule = true;
            const callExpr = decorator.expression;
            if (ts.isCallExpression(callExpr) && callExpr.arguments.length > 0) {
              const arg = callExpr.arguments[0];
              if (ts.isObjectLiteralExpression(arg)) {
                for (const prop of arg.properties) {
                  if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                    const propName = prop.name.text;
                    const propVal = prop.initializer;
                    if (propName === 'imports' || propName === 'exports' || propName === 'declarations') {
                      if (ts.isArrayLiteralExpression(propVal)) {
                        for (const elem of propVal.elements) {
                          const name = elem.getText(sourceFile);
                          references.push({
                            targetSymbolId: `module-member:${name}`,
                            location: getLoc(elem)
                          });
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      if (isComponent) {
        const componentId = `component:${className}`;
        symbols.push({
          id: componentId,
          name: className,
          type: 'component',
          location: getLoc(node),
          metadata: { selector: componentSelector }
        });

        if (componentSelector) {
          symbols.push({
            id: `selector:${componentSelector}`,
            name: componentSelector,
            type: 'css-selector',
            location: getLoc(node),
            metadata: { parentComponent: className }
          });
        }

        for (const member of node.members) {
          if (ts.isPropertyDeclaration(member)) {
            const propName = member.name.getText(sourceFile);
            const memberDecorators = ts.canHaveDecorators(member) ? ts.getDecorators(member) : undefined;
            if (memberDecorators) {
              for (const dec of memberDecorators) {
                const decText = dec.getText(sourceFile);
                if (decText.includes('Input')) {
                  symbols.push({
                    id: `input:${className}.${propName}`,
                    name: propName,
                    type: 'input',
                    location: getLoc(member),
                    metadata: { component: className }
                  });
                } else if (decText.includes('Output')) {
                  symbols.push({
                    id: `output:${className}.${propName}`,
                    name: propName,
                    type: 'output',
                    location: getLoc(member),
                    metadata: { component: className }
                  });
                }
              }
            }
          }
        }
      }

      if (isService) {
        symbols.push({
          id: `service:${className}`,
          name: className,
          type: 'service',
          location: getLoc(node)
        });
      }

      if (isModule) {
        symbols.push({
          id: `module:${className}`,
          name: className,
          type: 'module',
          location: getLoc(node)
        });
      }

      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member)) {
          for (const param of member.parameters) {
            if (param.type) {
              const typeText = param.type.getText(sourceFile);
              if (typeText.endsWith('Service') || typeText.includes('Service')) {
                references.push({
                  targetSymbolId: `service:${typeText}`,
                  location: getLoc(param)
                });
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { symbols, references };
}
