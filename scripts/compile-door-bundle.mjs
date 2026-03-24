#!/usr/bin/env node
/**
 * compile-door-bundle.mjs — Compile a door that imports npm packages
 *
 * Like compile-door.mjs but uses esbuild BUILD (not transform) to bundle
 * npm deps (like @json-render/*) into the output. solid-js and @floatty/stdlib
 * stay as bare specifiers for the loader's shim system.
 *
 * Usage:
 *   node scripts/compile-door-bundle.mjs <input.tsx> <output.js>
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { buildSync } from 'esbuild';
import { transformSync as babelTransform } from '@babel/core';

const [,, inputPath, outputPath] = process.argv;

if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/compile-door-bundle.mjs <input.tsx> <output.js>');
  process.exit(1);
}

// Step 1: esbuild bundles npm deps, keeps solid-js/stdlib as external bare specifiers
const step1 = buildSync({
  entryPoints: [inputPath],
  bundle: true,
  write: false,
  format: 'esm',
  target: 'es2020',
  jsx: 'preserve',
  external: ['solid-js', 'solid-js/web', '@floatty/stdlib'],
  // Don't minify — we need readable output for babel
  minify: false,
});

if (!step1.outputFiles?.length) {
  console.error(`esbuild bundle failed for ${inputPath}`);
  process.exit(1);
}

const bundled = step1.outputFiles[0].text;

// Step 2: babel transforms remaining JSX (our door's code) with SolidJS preset
// json-render's pre-compiled code (already uses _$createComponent etc.) passes through unchanged
const step2 = babelTransform(bundled, {
  presets: [['babel-preset-solid', { generate: 'dom', delegateEvents: false }]],
  filename: inputPath.replace(/\.tsx$/, '.jsx'),
  sourceType: 'module',
  compact: false,  // Don't deoptimize large files
});

if (!step2 || step2.code == null) {
  console.error(`Babel transform failed for ${inputPath}`);
  process.exit(1);
}

// Write output
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, step2.code, 'utf-8');

const kb = (step2.code.length / 1024).toFixed(1);
console.log(`Compiled+bundled: ${inputPath} → ${outputPath} (${kb} KB)`);
