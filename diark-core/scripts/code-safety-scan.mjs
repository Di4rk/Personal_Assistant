#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const RUST_SRC_DIR = path.join(projectRoot, 'src-tauri', 'src');
const TS_SRC_DIR = path.join(projectRoot, 'src');

/**
 * Diagnostic record for CI/lint reporting
 */
class Diagnostic {
  constructor(filePath, line, content, rule) {
    this.filePath = filePath;
    this.line = line;
    this.content = content.trim();
    this.rule = rule;
  }

  toString() {
    return `[${this.rule}] ${this.filePath}:${this.line}\n  -> ${this.content}`;
  }
}

/**
 * Recursively find all files matching an extension
 */
function findFiles(dir, extensions) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(fullPath, extensions));
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Scans Rust production source code for panic paths.
 * Test modules (identified by #[cfg(test)], mod tests {, etc.) are permitted
 * to use test assertions, while all production code must be 100% panic-free.
 */
export function productionPanicScan(srcDir = RUST_SRC_DIR) {
  const diagnostics = [];
  const panicPattern = /(\.unwrap\(|\.expect\(|panic!\(|unreachable!\()/;
  const rsFiles = findFiles(srcDir, ['.rs']);

  for (const filePath of rsFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let inTestModule = false;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      const trimmed = line.trim();

      // Detect test boundaries
      if (
        trimmed.includes('#[cfg(test)]') ||
        trimmed.includes('mod tests {') ||
        trimmed.includes('mod test {')
      ) {
        inTestModule = true;
      }

      if (!inTestModule) {
        // Skip comment lines
        if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
          continue;
        }

        if (panicPattern.test(line)) {
          diagnostics.push(
            new Diagnostic(
              path.relative(projectRoot, filePath),
              lineNum,
              trimmed,
              'RUST_PRODUCTION_PANIC'
            )
          );
        }
      }
    }
  }

  return diagnostics;
}

/**
 * Scans TypeScript source files for explicit `any` usage.
 * Strict TypeScript contract: zero any annotations or casts permitted.
 */
export function typescriptAnyScan(srcDir = TS_SRC_DIR) {
  const diagnostics = [];
  // Match explicit 'as any', ': any', '<any>', 'any[]', '[any]'
  const anyPattern = /(\bas\s+any\b|:\s*any\b|<\s*any\s*>|\[\s*any\s*\]|\bany\[\])/;
  const tsFiles = findFiles(srcDir, ['.ts', '.tsx']);

  for (const filePath of tsFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      const trimmed = line.trim();

      // Skip comments
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
        continue;
      }

      if (anyPattern.test(line)) {
        diagnostics.push(
          new Diagnostic(
            path.relative(projectRoot, filePath),
            lineNum,
            trimmed,
            'TS_EXPLICIT_ANY'
          )
        );
      }
    }
  }

  return diagnostics;
}

// CLI Execution entrypoint
const args = process.argv.slice(2);
const checkRustOnly = args.includes('--rust-only');
const checkTsOnly = args.includes('--ts-only');

let totalDiagnostics = [];

if (!checkTsOnly) {
  const rustDiags = productionPanicScan();
  if (rustDiags.length > 0) {
    console.error(`\x1b[31m[FAIL] Rust Production Panic Scan found ${rustDiags.length} violations:\x1b[0m`);
    rustDiags.forEach((d) => console.error(d.toString()));
  } else {
    console.log('\x1b[32m✓ Rust Production Panic Scan: 0 hits (Strict Safety Gate Passed)\x1b[0m');
  }
  totalDiagnostics = totalDiagnostics.concat(rustDiags);
}

if (!checkRustOnly) {
  const tsDiags = typescriptAnyScan();
  if (tsDiags.length > 0) {
    console.error(`\x1b[31m[FAIL] TypeScript Zero-Any Scan found ${tsDiags.length} violations:\x1b[0m`);
    tsDiags.forEach((d) => console.error(d.toString()));
  } else {
    console.log('\x1b[32m✓ TypeScript Zero-Any Scan: 0 hits (Strict Typing Gate Passed)\x1b[0m');
  }
  totalDiagnostics = totalDiagnostics.concat(tsDiags);
}

if (totalDiagnostics.length > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
