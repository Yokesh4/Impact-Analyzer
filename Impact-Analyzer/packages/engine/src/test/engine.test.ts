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
});
