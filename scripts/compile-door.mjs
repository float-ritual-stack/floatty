#!/usr/bin/env node
/**
 * compile-door.mjs — Compile a SolidJS door from .tsx to .js
 *
 * Two-step pipeline:
 * 1. esbuild: strip TypeScript types, preserve JSX
 * 2. babel + babel-preset-solid: transform JSX to DOM calls (delegateEvents: false)
 *
 * Output keeps bare specifiers ('solid-js', 'solid-js/web') —
 * doorLoader.ts rewrites them to shim URLs at load time.
 *
 * Usage:
 *   node scripts/compile-door.mjs <input.tsx> <output.js>
 *   node scripts/compile-door.mjs doors/daily/daily.tsx ~/.floatty-dev/doors/daily/index.js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { transformSync as esbuildTransform } from 'esbuild';
import { transformSync as babelTransform } from '@babel/core';

const [,, inputPath, outputPath] = process.argv;

if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/compile-door.mjs <input.tsx> <output.js>');
  process.exit(1);
}

const source = readFileSync(inputPath, 'utf-8');

// Step 1: esbuild strips TypeScript types, preserves JSX
const step1 = esbuildTransform(source, {
  loader: 'tsx',
  jsx: 'preserve',
  target: 'es2020',
});

// Step 2: babel transforms JSX with SolidJS preset
const step2 = babelTransform(step1.code, {
  presets: [['babel-preset-solid', { generate: 'dom', delegateEvents: false }]],
  filename: inputPath.replace(/\.tsx$/, '.jsx'),
});

if (!step2 || step2.code == null) {
  console.error(`Babel transform failed for ${inputPath}`);
  process.exit(1);
}

// Write output
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, step2.code, 'utf-8');

console.log(`Compiled: ${inputPath} → ${outputPath} (${step2.code.length} bytes)`);
