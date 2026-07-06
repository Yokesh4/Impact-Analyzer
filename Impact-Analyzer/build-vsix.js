import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

console.log('Compiling workspaces...');
execSync('npm run compile', { stdio: 'inherit' });

console.log('Building VS Code Extension packaging...');
const extensionDir = path.resolve('packages/extension');

try {
  console.log('Executing vsce package...');
  execSync('npx -y @vscode/vsce package --no-dependencies', {
    cwd: extensionDir,
    stdio: 'inherit'
  });
  console.log('Packaging successful!');
} catch (err) {
  console.error('Packaging failed. Ensure package configuration is correct.', err);
  process.exit(1);
}
