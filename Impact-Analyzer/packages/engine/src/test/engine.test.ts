import { parseTypeScript } from '../parser/ts-parser.js';
import { parseHTML } from '../parser/html-parser.js';
import { parseCSS } from '../parser/css-parser.js';
import { ImportResolver } from '../parser/import-resolver.js';
import { WorkspaceIndexer } from '../indexer/workspace-indexer.js';
import { DependencyGraph } from '../graph/dependency-graph.js';
import { RiskEngine } from '../risk/risk-engine.js';
import { ImpactEngine } from '../impact/impact-engine.js';
import * as path from 'path';

describe('Impact Guard Core Engine Tests', () => {

  describe('TypeScript AST Parser', () => {
    it('should parse components, selectors, inputs, outputs, services, and modules', () => {
      const code = `
        import { Component, Input, Output, EventEmitter, Injectable, NgModule } from '@angular/core';

        @Injectable()
        export class AuthService {}

        @Component({
          selector: 'app-user-profile',
          template: '<p>Profile</p>'
        })
        export class UserProfileComponent {
          @Input() username: string = '';
          @Output() logout = new EventEmitter<void>();
          constructor(private auth: AuthService) {}
        }

        const routes = [
          { path: 'profile', component: UserProfileComponent }
        ];
      `;
      const { symbols, references } = parseTypeScript('test.ts', code);

      const service = symbols.find(s => s.type === 'service');
      expect(service).toBeDefined();
      expect(service?.name).toBe('AuthService');

      const component = symbols.find(s => s.type === 'component');
      expect(component).toBeDefined();
      expect(component?.name).toBe('UserProfileComponent');
      expect(component?.metadata?.selector).toBe('app-user-profile');

      const selector = symbols.find(s => s.type === 'css-selector');
      expect(selector).toBeDefined();
      expect(selector?.name).toBe('app-user-profile');

      const input = symbols.find(s => s.type === 'input');
      expect(input).toBeDefined();
      expect(input?.name).toBe('username');

      const output = symbols.find(s => s.type === 'output');
      expect(output).toBeDefined();
      expect(output?.name).toBe('logout');

      const ref = references.find(r => r.targetSymbolId === 'service:AuthService');
      expect(ref).toBeDefined();

      const route = symbols.find(s => s.type === 'route');
      expect(route).toBeDefined();
      expect(route?.name).toBe('/profile');
    });
  });

  describe('HTML Template Parser', () => {
    it('should parse tag selectors, inputs, outputs, and CSS/Bootstrap classes', () => {
      const template = `
        <div class="container card btn-primary">
          <app-user-profile [username]="currentUser" (logout)="onLogout()"></app-user-profile>
        </div>
      `;
      const { references } = parseHTML('test.html', template);

      expect(references.some(r => r.targetSymbolId === 'selector:app-user-profile')).toBe(true);
      expect(references.some(r => r.targetSymbolId === 'input:app-user-profile.username')).toBe(true);
      expect(references.some(r => r.targetSymbolId === 'output:app-user-profile.logout')).toBe(true);
      expect(references.some(r => r.targetSymbolId === 'css:.btn-primary')).toBe(true);
      expect(references.some(r => r.targetSymbolId === 'css:.card')).toBe(true);
      expect(references.some(r => r.targetSymbolId === 'css:.container')).toBe(true);
    });

    it('should skip HTML and JSP comments without shifting line numbers', () => {
      const template = `
        <div class="container">
          <!-- <app-user-profile [username]="currentUser" (logout)="onLogout()"></app-user-profile> -->
          <%-- <app-admin-panel></app-admin-panel> --%>
          <span class="active-badge">Active</span>
        </div>
      `;
      const { references } = parseHTML('test.html', template);

      // Commented components should NOT be referenced
      expect(references.some(r => r.targetSymbolId === 'selector:app-user-profile')).toBe(false);
      expect(references.some(r => r.targetSymbolId === 'selector:app-admin-panel')).toBe(false);
      
      // Active elements after comments should be correctly parsed with correct line numbers
      const spanRef = references.find(r => r.targetSymbolId === 'selector:span');
      expect(spanRef).toBeDefined();
      expect(spanRef?.location.startLine).toBe(5);

      const activeBadgeRef = references.find(r => r.targetSymbolId === 'css:.active-badge');
      expect(activeBadgeRef).toBeDefined();
      expect(activeBadgeRef?.location.startLine).toBe(5);
    });
  });

  describe('CSS/SCSS/LESS Parser', () => {
    it('should parse nested CSS classes, variables, and mixins', () => {
      const style = `
        $primary-color: #00f;
        
        @mixin center-flex {
          display: flex;
          justify-content: center;
        }

        .dashboard {
          @include center-flex;
          color: $primary-color;

          &.active {
            font-weight: bold;
          }
        }
      `;
      const { symbols, references } = parseCSS('test.scss', style);

      expect(symbols.some(s => s.id === 'var:$primary-color')).toBe(true);
      expect(symbols.some(s => s.id === 'mixin:center-flex')).toBe(true);
      expect(symbols.some(s => s.id === 'css:.dashboard')).toBe(true);
      expect(symbols.some(s => s.id === 'css:.dashboard.active')).toBe(true);
        expect(references.some(r => r.targetSymbolId === 'mixin:center-flex')).toBe(true);
      expect(references.some(r => r.targetSymbolId === 'var:$primary-color')).toBe(true);
    });

    it('should correctly parse LESS files containing comments with commas and dots without corrupting selectors', () => {
      const style = `
        // Toolbar row (board selector, team, avatars, action icons)
        .kanban-toolbar {
          background: #fff;
          
          // Tighten spacing around the filter button (override global 11px right margin)
          .filter-button {
            margin-right: 2px;
          }
        }
      `;
      const { symbols } = parseCSS('test.less', style);
      expect(symbols.some(s => s.id === 'css:.kanban-toolbar')).toBe(true);
      expect(symbols.some(s => s.id === 'css:.kanban-toolbar .filter-button')).toBe(true);
      expect(symbols.some(s => s.id === 'css:.filter-button')).toBe(true);
      // Ensure that there are no symbols with corrupted names due to comments
      expect(symbols.some(s => s.id.includes('Toolbar row'))).toBe(false);
      expect(symbols.some(s => s.id.includes('Tighten spacing'))).toBe(false);
    });

    it('should correctly parse CSS selectors with comments inside/before them preserving precise offsets', () => {
      const style = `
        /* Top-level banner styles */
        .banner {
          background: #eee;
        }

        .item, 
        // Inline item comment here
        .item-active {
          color: green;
        }
      `;
      const { symbols } = parseCSS('styles.css', style);

      const bannerSym = symbols.find(s => s.id === 'css:.banner');
      expect(bannerSym).toBeDefined();
      expect(bannerSym?.location.startLine).toBe(3); // Line of .banner

      const itemSym = symbols.find(s => s.id === 'css:.item');
      expect(itemSym).toBeDefined();
      expect(itemSym?.location.startLine).toBe(7); // Line of .item

      const activeItemSyms = symbols.filter(s => s.id === 'css:.item-active');
      expect(activeItemSyms.length).toBeGreaterThan(0);
      expect(activeItemSyms.some(s => s.location.startLine === 9)).toBe(true);
    });

    it('should include hierarchy metadata on nested selectors', () => {
      const style = `
        .parent {
          color: red;
          .child {
            color: blue;
            .grandchild {
              color: green;
            }
          }
        }
      `;
      const { symbols } = parseCSS('test.less', style);

      // Check compound selectors have ancestorClasses metadata
      const parentChild = symbols.find(s => s.id === 'css:.parent .child');
      expect(parentChild).toBeDefined();
      expect(parentChild?.metadata?.ancestorClasses).toContain('.parent');
      expect(parentChild?.metadata?.ancestorClasses).toContain('.child');

      const parentChildGrandchild = symbols.find(s => s.id === 'css:.parent .child .grandchild');
      expect(parentChildGrandchild).toBeDefined();
      expect(parentChildGrandchild?.metadata?.ancestorClasses).toContain('.parent');
      expect(parentChildGrandchild?.metadata?.ancestorClasses).toContain('.child');
      expect(parentChildGrandchild?.metadata?.ancestorClasses).toContain('.grandchild');
    });

    it('should extract @import paths from LESS content', () => {
      const style = `
        @import "bootstrap/less/variables.less";
        @import "common/custom-variables.less";
        @import (less) '../webapp/js/thirdparty/codemirror/lib/codemirror.css';
        @import 'ctf-common';

        .my-class {
          color: red;
        }
      `;
      const { imports } = parseCSS('test.less', style);

      expect(imports).toContain('bootstrap/less/variables.less');
      expect(imports).toContain('common/custom-variables.less');
      expect(imports).toContain('../webapp/js/thirdparty/codemirror/lib/codemirror.css');
      expect(imports).toContain('ctf-common');
    });
  });

  describe('Dependency Graph & Risk Calculations', () => {
    it('should build connection paths and compute risk levels', () => {
      const indexer = new WorkspaceIndexer(__dirname);
      
      indexer.files['/app/button.component.ts'] = {
        filePath: '/app/button.component.ts',
        lastModified: 100,
        symbols: [
          { id: 'component:ButtonComponent', name: 'ButtonComponent', type: 'component', location: { filePath: '/app/button.component.ts', startLine: 1, startCol: 1, endLine: 10, endCol: 1 }, metadata: { selector: 'app-button' } },
          { id: 'selector:app-button', name: 'app-button', type: 'css-selector', location: { filePath: '/app/button.component.ts', startLine: 1, startCol: 1, endLine: 10, endCol: 1 } }
        ],
        references: []
      };

      indexer.files['/app/dashboard.component.ts'] = {
        filePath: '/app/dashboard.component.ts',
        lastModified: 100,
        symbols: [
          { id: 'component:DashboardComponent', name: 'DashboardComponent', type: 'component', location: { filePath: '/app/dashboard.component.ts', startLine: 1, startCol: 1, endLine: 15, endCol: 1 } }
        ],
        references: [
          { targetSymbolId: 'selector:app-button', location: { filePath: '/app/dashboard.component.ts', startLine: 5, startCol: 5, endLine: 5, endCol: 20 } }
        ]
      };

      const graph = new DependencyGraph();
      graph.buildGraph(indexer);

      expect(graph.nodes.has('component:ButtonComponent')).toBe(true);
      expect(graph.nodes.has('component:DashboardComponent')).toBe(true);

      const downstream = graph.getDownstream('selector:app-button');
      expect(downstream).toContain('component:DashboardComponent');

      const risk = RiskEngine.calculateRisk(downstream.length, 'css-selector');
      expect(risk).toBe('medium');
    });
  });

  describe('CSS Hierarchy Impact Propagation', () => {
    it('should propagate parent class changes to pages using child/grandchild selectors', () => {
      const workspaceRoot = path.resolve(__dirname);
      const indexer = new WorkspaceIndexer(workspaceRoot);
      const styleLessFile = path.join(workspaceRoot, 'styles.less');
      const loginJspFile = path.join(workspaceRoot, 'login.jsp');
      const dashboardHtmlFile = path.join(workspaceRoot, 'dashboard.html');

      // Style file with nested classes: .parent > .child > .grandchild
      indexer.files[styleLessFile] = {
        filePath: styleLessFile,
        lastModified: 100,
        symbols: [
          { id: 'css:.parent', name: '.parent', type: 'css-selector', location: { filePath: styleLessFile, startLine: 1, startCol: 1, endLine: 10, endCol: 1 } },
          { id: 'css:.parent .child', name: '.parent .child', type: 'css-selector', location: { filePath: styleLessFile, startLine: 3, startCol: 1, endLine: 8, endCol: 1 }, metadata: { ancestorClasses: ['.parent', '.child'] } },
          { id: 'css:.child', name: '.child', type: 'css-selector', location: { filePath: styleLessFile, startLine: 3, startCol: 1, endLine: 8, endCol: 1 }, metadata: { compoundSelector: '.parent .child', ancestorClasses: ['.parent', '.child'] } },
          { id: 'css:.parent .child .grandchild', name: '.parent .child .grandchild', type: 'css-selector', location: { filePath: styleLessFile, startLine: 5, startCol: 1, endLine: 7, endCol: 1 }, metadata: { ancestorClasses: ['.parent', '.child', '.grandchild'] } },
          { id: 'css:.grandchild', name: '.grandchild', type: 'css-selector', location: { filePath: styleLessFile, startLine: 5, startCol: 1, endLine: 7, endCol: 1 }, metadata: { compoundSelector: '.parent .child .grandchild', ancestorClasses: ['.parent', '.child', '.grandchild'] } }
        ],
        references: []
      };

      // JSP page uses .parent .child .grandchild
      indexer.files[loginJspFile] = {
        filePath: loginJspFile,
        lastModified: 100,
        symbols: [],
        references: [
          { targetSymbolId: 'css:.grandchild', location: { filePath: loginJspFile, startLine: 5, startCol: 1, endLine: 5, endCol: 20 } }
        ]
      };

      // HTML page uses .parent directly
      indexer.files[dashboardHtmlFile] = {
        filePath: dashboardHtmlFile,
        lastModified: 100,
        symbols: [],
        references: [
          { targetSymbolId: 'css:.parent', location: { filePath: dashboardHtmlFile, startLine: 3, startCol: 1, endLine: 3, endCol: 15 } }
        ]
      };

      const graph = new DependencyGraph();
      graph.buildGraph(indexer);

      // Scenario 1: Analyzing .parent should include pages using .child and .grandchild too
      const parentDownstream = graph.getHierarchicalDownstream('css:.parent');
      const relLoginPath = path.relative(workspaceRoot, loginJspFile).replace(/\\/g, '/');
      const relDashboardPath = path.relative(workspaceRoot, dashboardHtmlFile).replace(/\\/g, '/');
      
      expect(parentDownstream).toContain(`page:${relDashboardPath}`);
      expect(parentDownstream).toContain(`page:${relLoginPath}`);

      // Scenario 2: Analyzing .child should include the login page (uses .grandchild under .child)
      const childDownstream = graph.getHierarchicalDownstream('css:.child');
      expect(childDownstream).toContain(`page:${relLoginPath}`);
    });

    it('should produce correct grouped counts for parent with nested children', () => {
      const workspaceRoot = path.resolve(__dirname);
      const indexer = new WorkspaceIndexer(workspaceRoot);
      const graph = new DependencyGraph();
      const styleLessFile = path.join(workspaceRoot, 'app.less');
      const page1 = path.join(workspaceRoot, 'page1.jsp');
      const page2 = path.join(workspaceRoot, 'page2.html');
      const page3 = path.join(workspaceRoot, 'page3.jsp');

      indexer.files[styleLessFile] = {
        filePath: styleLessFile,
        lastModified: 100,
        symbols: [
          { id: 'css:.baseline', name: '.baseline', type: 'css-selector', location: { filePath: styleLessFile, startLine: 1, startCol: 1, endLine: 20, endCol: 1 } },
          { id: 'css:.baseline .header', name: '.baseline .header', type: 'css-selector', location: { filePath: styleLessFile, startLine: 3, startCol: 1, endLine: 10, endCol: 1 } },
          { id: 'css:.header', name: '.header', type: 'css-selector', location: { filePath: styleLessFile, startLine: 3, startCol: 1, endLine: 10, endCol: 1 } },
          { id: 'css:.baseline .table-wrapper', name: '.baseline .table-wrapper', type: 'css-selector', location: { filePath: styleLessFile, startLine: 12, startCol: 1, endLine: 18, endCol: 1 } },
          { id: 'css:.table-wrapper', name: '.table-wrapper', type: 'css-selector', location: { filePath: styleLessFile, startLine: 12, startCol: 1, endLine: 18, endCol: 1 } }
        ],
        references: []
      };

      indexer.files[page1] = {
        filePath: page1,
        lastModified: 100,
        symbols: [],
        references: [
          { targetSymbolId: 'css:.baseline', location: { filePath: page1, startLine: 1, startCol: 1, endLine: 1, endCol: 10 } }
        ]
      };

      indexer.files[page2] = {
        filePath: page2,
        lastModified: 100,
        symbols: [],
        references: [
          { targetSymbolId: 'css:.header', location: { filePath: page2, startLine: 1, startCol: 1, endLine: 1, endCol: 10 } }
        ]
      };

      indexer.files[page3] = {
        filePath: page3,
        lastModified: 100,
        symbols: [],
        references: [
          { targetSymbolId: 'css:.table-wrapper', location: { filePath: page3, startLine: 1, startCol: 1, endLine: 1, endCol: 10 } }
        ]
      };

      graph.buildGraph(indexer);
      const impactEngine = new ImpactEngine(indexer, graph);
      const report = impactEngine.analyzeImpact('css:.baseline');

      // All 3 pages should be affected when analyzing .baseline
      expect(report.groupedCounts).toBeDefined();
      expect(report.groupedCounts!.pages).toBeGreaterThanOrEqual(3);
    });

    it('should build hierarchy chain for hover display', () => {
      const workspaceRoot = path.resolve(__dirname);
      const indexer = new WorkspaceIndexer(workspaceRoot);
      const graph = new DependencyGraph();
      const styleFile = path.join(workspaceRoot, 'test.less');

      indexer.files[styleFile] = {
        filePath: styleFile,
        lastModified: 100,
        symbols: [
          { id: 'css:.ctf_7_x_styles', name: '.ctf_7_x_styles', type: 'css-selector', location: { filePath: styleFile, startLine: 1, startCol: 1, endLine: 50, endCol: 1 } },
          { id: 'css:.ctf_7_x_styles .baseline', name: '.ctf_7_x_styles .baseline', type: 'css-selector', location: { filePath: styleFile, startLine: 5, startCol: 1, endLine: 30, endCol: 1 } },
          { id: 'css:.baseline', name: '.baseline', type: 'css-selector', location: { filePath: styleFile, startLine: 5, startCol: 1, endLine: 30, endCol: 1 } },
          { id: 'css:.ctf_7_x_styles .baseline .header', name: '.ctf_7_x_styles .baseline .header', type: 'css-selector', location: { filePath: styleFile, startLine: 8, startCol: 1, endLine: 15, endCol: 1 } },
          { id: 'css:.header', name: '.header', type: 'css-selector', location: { filePath: styleFile, startLine: 8, startCol: 1, endLine: 15, endCol: 1 } }
        ],
        references: []
      };

      graph.buildGraph(indexer);

      // Hierarchy chain for .ctf_7_x_styles should include nested selectors
      const chain = graph.getHierarchyChain('css:.ctf_7_x_styles');
      expect(chain.length).toBeGreaterThan(0);
      expect(chain.some(c => c.selector.includes('.baseline'))).toBe(true);
    });
  });

  describe('Import Chain Resolution', () => {
    it('should extract import paths from LESS content', () => {
      const resolver = new ImportResolver(__dirname);
      
      const imports = resolver.extractImports(`
        @import "bootstrap/less/variables.less";
        @import "common/custom-variables.less";
        @import (less) '../webapp/js/thirdparty/codemirror/lib/codemirror.css';
        @import 'ctf-common';
      `);

      expect(imports).toContain('bootstrap/less/variables.less');
      expect(imports).toContain('common/custom-variables.less');
      expect(imports).toContain('../webapp/js/thirdparty/codemirror/lib/codemirror.css');
      expect(imports).toContain('ctf-common');
    });

    it('should extract import paths from CSS content with url() syntax', () => {
      const resolver = new ImportResolver(__dirname);
      
      const imports = resolver.extractImports(`
        @import url('reset.css');
        @import url("theme.css");
        body { color: red; }
      `);

      expect(imports).toContain('reset.css');
      expect(imports).toContain('theme.css');
    });

    it('should not extract imports from inside comments', () => {
      const resolver = new ImportResolver(__dirname);
      
      const imports = resolver.extractImports(`
        /* @import "commented-out.less"; */
        @import "real-import.less";
      `);

      expect(imports).not.toContain('commented-out.less');
      expect(imports).toContain('real-import.less');
    });
  });

  describe('Cache Portability (Relative Paths)', () => {
    it('should save cache with relative paths and load it back with absolute paths', () => {
      const fs = require('fs');
      const workspaceRoot = path.resolve(__dirname).replace(/^[A-Z]:/, match => match.toLowerCase());
      const indexer = new WorkspaceIndexer(workspaceRoot);

      const testFileAbs = path.join(workspaceRoot, 'test-file.ts');
      const testFileRel = 'test-file.ts';

      indexer.files[testFileAbs] = {
        filePath: testFileAbs,
        lastModified: 12345,
        symbols: [
          {
            id: 'component:TestComp',
            name: 'TestComp',
            type: 'component',
            location: { filePath: testFileAbs, startLine: 1, startCol: 1, endLine: 5, endCol: 5 }
          }
        ],
        references: [
          {
            targetSymbolId: 'service:TestService',
            location: { filePath: testFileAbs, startLine: 2, startCol: 2, endLine: 2, endCol: 20 }
          }
        ]
      };

      const tempCacheFile = path.join(workspaceRoot, 'temp-test-cache.json');
      try {
        indexer.saveCache(tempCacheFile);

        // Verify the saved JSON has relative paths
        const savedContent = JSON.parse(fs.readFileSync(tempCacheFile, 'utf-8'));
        expect(savedContent.files[testFileRel]).toBeDefined();
        expect(savedContent.files[testFileRel].filePath).toBe(testFileRel);
        expect(savedContent.files[testFileRel].symbols[0].location.filePath).toBe(testFileRel);
        expect(savedContent.files[testFileRel].references[0].location.filePath).toBe(testFileRel);

        // Now load into a new indexer with the same root
        const newIndexer = new WorkspaceIndexer(workspaceRoot);
        const loaded = newIndexer.loadCache(tempCacheFile);
        expect(loaded).toBe(true);

        // Verify paths are absolute again
        expect(newIndexer.files[testFileAbs]).toBeDefined();
        expect(newIndexer.files[testFileAbs].filePath).toBe(testFileAbs);
        expect(newIndexer.files[testFileAbs].symbols[0].location.filePath).toBe(testFileAbs);
        expect(newIndexer.files[testFileAbs].references[0].location.filePath).toBe(testFileAbs);
      } finally {
        if (fs.existsSync(tempCacheFile)) {
          fs.unlinkSync(tempCacheFile);
        }
      }
    });
  });

  describe('CSS Range Expansion', () => {
    it('should expand selector and class symbol ranges to the closing brace', () => {
      const style = `
        .shared-dropdown {
          padding: 10px;
          margin: 5px;
        }
      `;
      const { symbols } = parseCSS('styles.css', style);
      const classSym = symbols.find(s => s.id === 'css:.shared-dropdown');
      expect(classSym).toBeDefined();
      expect(classSym?.location.startLine).toBe(2);
      expect(classSym?.location.endLine).toBe(5);
    });
  });

  describe('JSP and Standalone Pages Support', () => {
    it('should index .jsp files and treat them as HTML files', async () => {
      const workspaceRoot = path.resolve(__dirname);
      const indexer = new WorkspaceIndexer(workspaceRoot);
      const testJspFile = path.join(workspaceRoot, 'dropdown.jsp');
      
      indexer.files[testJspFile] = {
        filePath: testJspFile,
        lastModified: Date.now(),
        symbols: [],
        references: [
          { targetSymbolId: 'css:.shared-dropdown', location: { filePath: testJspFile, startLine: 2, startCol: 9, endLine: 2, endCol: 37 } }
        ]
      };

      const graph = new DependencyGraph();
      graph.buildGraph(indexer);

      const relPath = path.relative(workspaceRoot, testJspFile).replace(/\\/g, '/');
      expect(graph.nodes.has(`page:${relPath}`)).toBe(true);
      const node = graph.nodes.get(`page:${relPath}`);
      expect(node?.type).toBe('jsp-page');

      const downstream = graph.getDownstream('css:.shared-dropdown');
      expect(downstream).toContain(`page:${relPath}`);
    });
  });

  describe('Inline Style Tag Parsing', () => {
    it('should parse class selectors inside style tags in HTML files and adjust locations', () => {
      const html = `
        <style>
          .inline-dropdown-class {
            color: red;
          }
        </style>
      `;
      const { symbols } = parseHTML('dropdown.html', html);
      const classSym = symbols.find(s => s.id === 'css:.inline-dropdown-class');
      expect(classSym).toBeDefined();
      expect(classSym?.location.startLine).toBe(3);
      expect(classSym?.location.endLine).toBe(5);
    });
  });

  describe('Component Inline Styles and Transitive Styling Dependency', () => {
    it('should parse inline styles in component TS files and propagate CSS class changes through component selectors to HTML templates', () => {
      const tsCode = `
        import { Component } from '@angular/core';
        @Component({
          selector: 'app-custom-dropdown',
          styles: [\`
            .custom-dropdown-container {
              background: blue;
            }
          \`]
        })
        export class CustomDropdownComponent {}
      `;

      const { symbols, references } = parseTypeScript('dropdown.component.ts', tsCode);
      const styleSym = symbols.find(s => s.id === 'css:.custom-dropdown-container');
      expect(styleSym).toBeDefined();
      expect(styleSym?.location.startLine).toBeGreaterThan(3);

      const workspaceRoot = path.resolve(__dirname);
      const indexer = new WorkspaceIndexer(workspaceRoot);
      const dropdownTsFile = path.join(workspaceRoot, 'dropdown.component.ts');
      const pageHtmlFile = path.join(workspaceRoot, 'page.html');

      indexer.files[dropdownTsFile] = {
        filePath: dropdownTsFile,
        lastModified: 100,
        symbols,
        references
      };

      indexer.files[pageHtmlFile] = {
        filePath: pageHtmlFile,
        lastModified: 100,
        symbols: [],
        references: [
          { targetSymbolId: 'selector:app-custom-dropdown', location: { filePath: pageHtmlFile, startLine: 2, startCol: 1, endLine: 2, endCol: 30 } }
        ]
      };

      const graph = new DependencyGraph();
      graph.buildGraph(indexer);

      const relPagePath = path.relative(workspaceRoot, pageHtmlFile).replace(/\\/g, '/');
      const downstream = graph.getDownstream('css:.custom-dropdown-container');
      expect(downstream).toContain('component:CustomDropdownComponent');
      expect(downstream).toContain('selector:app-custom-dropdown');
      expect(downstream).toContain(`page:${relPagePath}`);
    });
  });

  describe('ngClass Dynamic Reference Parsing', () => {
    it('should extract CSS class references inside ngClass attribute value', () => {
      const html = `
        <div [ngClass]="{'btn-primary': active, 'show': isExpanded}">Dropdown</div>
      `;
      const { references } = parseHTML('dropdown.html', html);
      expect(references.some(r => r.targetSymbolId === 'css:.btn-primary')).toBe(true);
      expect(references.some(r => r.targetSymbolId === 'css:.show')).toBe(true);
    });
  });

  describe('Enterprise LESS Structure (Digital.ai Reference)', () => {
    it('should parse nested classes inside a root wrapper class like .ctf_7_x_styles', () => {
      const style = `
        .ctf_7_x_styles {
          .baseline {
            width: 100%;
            .header {
              display: flex;
              .btn {
                margin-left: 16px;
              }
            }
            .table-wrapper {
              padding-left: 20px;
            }
          }
        }
      `;
      const { symbols } = parseCSS('ctf-stylesheet.less', style);

      // Root class
      expect(symbols.some(s => s.id === 'css:.ctf_7_x_styles')).toBe(true);
      
      // Nested classes should have full compound selectors
      expect(symbols.some(s => s.id === 'css:.ctf_7_x_styles .baseline')).toBe(true);
      expect(symbols.some(s => s.id === 'css:.ctf_7_x_styles .baseline .header')).toBe(true);
      expect(symbols.some(s => s.id === 'css:.ctf_7_x_styles .baseline .header .btn')).toBe(true);
      expect(symbols.some(s => s.id === 'css:.ctf_7_x_styles .baseline .table-wrapper')).toBe(true);
      
      // Bare class names should also exist
      expect(symbols.some(s => s.id === 'css:.baseline')).toBe(true);
      expect(symbols.some(s => s.id === 'css:.header')).toBe(true);
      expect(symbols.some(s => s.id === 'css:.btn')).toBe(true);
      expect(symbols.some(s => s.id === 'css:.table-wrapper')).toBe(true);
    });

    it('should correctly propagate impact through deeply nested enterprise LESS hierarchy', () => {
      const workspaceRoot = path.resolve(__dirname);
      const indexer = new WorkspaceIndexer(workspaceRoot);
      const graph = new DependencyGraph();
      const styleFile = path.join(workspaceRoot, 'ctf.less');
      const page1 = path.join(workspaceRoot, 'artifact-view.jsp');
      const page2 = path.join(workspaceRoot, 'baseline-view.html');

      indexer.files[styleFile] = {
        filePath: styleFile,
        lastModified: 100,
        symbols: [
          { id: 'css:.ctf_7_x_styles', name: '.ctf_7_x_styles', type: 'css-selector', location: { filePath: styleFile, startLine: 1, startCol: 1, endLine: 100, endCol: 1 } },
          { id: 'css:.ctf_7_x_styles .baseline', name: '.ctf_7_x_styles .baseline', type: 'css-selector', location: { filePath: styleFile, startLine: 5, startCol: 1, endLine: 50, endCol: 1 } },
          { id: 'css:.baseline', name: '.baseline', type: 'css-selector', location: { filePath: styleFile, startLine: 5, startCol: 1, endLine: 50, endCol: 1 } },
          { id: 'css:.ctf_7_x_styles .baseline .header', name: '.ctf_7_x_styles .baseline .header', type: 'css-selector', location: { filePath: styleFile, startLine: 10, startCol: 1, endLine: 25, endCol: 1 } },
          { id: 'css:.header', name: '.header', type: 'css-selector', location: { filePath: styleFile, startLine: 10, startCol: 1, endLine: 25, endCol: 1 } }
        ],
        references: []
      };

      // Page uses .header class (which is nested under .ctf_7_x_styles .baseline .header)
      indexer.files[page1] = {
        filePath: page1,
        lastModified: 100,
        symbols: [],
        references: [
          { targetSymbolId: 'css:.header', location: { filePath: page1, startLine: 5, startCol: 1, endLine: 5, endCol: 15 } }
        ]
      };

      // Page uses .baseline class
      indexer.files[page2] = {
        filePath: page2,
        lastModified: 100,
        symbols: [],
        references: [
          { targetSymbolId: 'css:.baseline', location: { filePath: page2, startLine: 3, startCol: 1, endLine: 3, endCol: 15 } }
        ]
      };

      graph.buildGraph(indexer);
      const impactEngine = new ImpactEngine(indexer, graph);

      // Analyzing .ctf_7_x_styles should find BOTH pages
      const report = impactEngine.analyzeImpact('css:.ctf_7_x_styles');
      const relPage1 = path.relative(workspaceRoot, page1).replace(/\\/g, '/');
      const relPage2 = path.relative(workspaceRoot, page2).replace(/\\/g, '/');
      
      const affectedPageIds = report.affectedNodes
        .filter(n => n.type === 'html-page' || n.type === 'jsp-page')
        .map(n => n.symbolId);

      expect(affectedPageIds).toContain(`page:${relPage1}`);
      expect(affectedPageIds).toContain(`page:${relPage2}`);
      expect(report.groupedCounts!.pages).toBe(2);
    });

    it('should propagate impact through LESS @import chains to affected JSP and HTML pages', () => {
      const workspaceRoot = path.resolve(__dirname);
      const indexer = new WorkspaceIndexer(workspaceRoot);
      const graph = new DependencyGraph();

      const mainLess = path.join(workspaceRoot, 'styles.less');
      const notificationLess = path.join(workspaceRoot, 'notification.less');
      const viewJsp = path.join(workspaceRoot, 'alert-view.jsp');

      indexer.files[notificationLess] = {
        filePath: notificationLess,
        lastModified: 100,
        symbols: [
          { id: 'css:.errorText', name: '.errorText', type: 'css-selector', location: { filePath: notificationLess, startLine: 1, startCol: 1, endLine: 5, endCol: 1 } },
          { id: 'css:.errorMessage', name: '.errorMessage', type: 'css-selector', location: { filePath: notificationLess, startLine: 6, startCol: 1, endLine: 10, endCol: 1 } }
        ],
        references: []
      };

      indexer.files[mainLess] = {
        filePath: mainLess,
        lastModified: 100,
        symbols: [
          { id: 'css:.ctf_7_x_styles', name: '.ctf_7_x_styles', type: 'css-selector', location: { filePath: mainLess, startLine: 1, startCol: 1, endLine: 50, endCol: 1 } }
        ],
        references: [],
        imports: ['notification.less']
      };

      indexer.files[viewJsp] = {
        filePath: viewJsp,
        lastModified: 100,
        symbols: [],
        references: [
          { targetSymbolId: 'css:.errorText', location: { filePath: viewJsp, startLine: 2, startCol: 1, endLine: 2, endCol: 20 } }
        ]
      };

      graph.buildGraph(indexer);
      const impactEngine = new ImpactEngine(indexer, graph);

      // Analyzing symbol in imported notification.less should reach alert-view.jsp
      const report = impactEngine.analyzeImpact('css:.errorText');
      const relViewJsp = path.relative(workspaceRoot, viewJsp).replace(/\\/g, '/');

      expect(report.affectedNodes.some(n => n.symbolId === `page:${relViewJsp}`)).toBe(true);

      // Whole-file analysis on notification.less should report aggregated JSP pages
      const fileReport = impactEngine.analyzeFileImpact(notificationLess);
      expect(fileReport.groupedCounts!.pages).toBeGreaterThanOrEqual(1);
    });
  });
});
