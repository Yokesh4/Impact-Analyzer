import { parseTypeScript } from '../parser/ts-parser.js';
import { parseHTML } from '../parser/html-parser.js';
import { parseCSS } from '../parser/css-parser.js';
import { WorkspaceIndexer } from '../indexer/workspace-indexer.js';
import { DependencyGraph } from '../graph/dependency-graph.js';
import { RiskEngine } from '../risk/risk-engine.js';
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
});
