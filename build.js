// ============================================================================
// build.js — Bundles modular ES source files into a single self-contained HTML
//            studio file (zero external CDN dependencies except allowlisted
//            Antigravity Tailwind script for artifact styling).
// ============================================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const moduleOrder = [
  'src/math3d.js',
  'src/gifEncoder.js',
  'src/planarEngine.js',
  'src/advancedTechniques.js',
  'src/kinematicModels.js',
  'src/renderer3d.js',
  'src/app.js',
];

function stripImportsExports(code) {
  // Remove single-line and multi-line ES import statements
  let out = code.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  // Replace `export ` keywords while preserving declarations
  out = out.replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, '');
  return out.trim();
}

const bundledJs = [
  '(function () {',
  '  "use strict";',
  ...moduleOrder.map(rel => {
    const raw = fs.readFileSync(path.join(root, rel), 'utf8');
    return `\n  // ---- ${rel} ----\n` + stripImportsExports(raw);
  }),
  '\n  if (document.readyState === "loading") {',
  '    document.addEventListener("DOMContentLoaded", initOrigamiStudio);',
  '  } else {',
  '    initOrigamiStudio();',
  '  }',
  '})();',
].join('\n');

const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const htmlTemplate = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const selfContainedHtml = htmlTemplate
  .replace(
    '<link rel="stylesheet" href="./styles.css" />',
    `<script src="https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js"></script>\n  <style>\n${css}\n  </style>`
  )
  .replace(
    /<script type="module">[\s\S]*?<\/script>/,
    `<script>\n${bundledJs}\n  </script>`
  );

// Clean standalone production build for Vercel (zero external script requests!)
const vercelHtml = htmlTemplate
  .replace(
    '<link rel="stylesheet" href="./styles.css" />',
    `<style>\n${css}\n  </style>`
  )
  .replace(
    /<script type="module">[\s\S]*?<\/script>/,
    `<script>\n${bundledJs}\n  </script>`
  );

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.mkdirSync(path.join(root, 'public'), { recursive: true });
const outPath = path.join(root, 'dist/origami_3d_studio.html');
const vercelOutPath = path.join(root, 'public/index.html');
fs.writeFileSync(outPath, selfContainedHtml, 'utf8');
fs.writeFileSync(vercelOutPath, vercelHtml, 'utf8');

// Syntax-check the bundled JS with Node's Function constructor!
try {
  new Function(bundledJs);
  console.log(`[OK] Bundled JS syntax verified (${(bundledJs.length / 1024).toFixed(1)} KB)`);
  console.log(`[OK] Artifact HTML written to ${outPath} (${(selfContainedHtml.length / 1024).toFixed(1)} KB)`);
  console.log(`[OK] Vercel production build written to ${vercelOutPath} (${(vercelHtml.length / 1024).toFixed(1)} KB)`);
} catch (err) {
  console.error('[FAIL] Bundled JS syntax error:', err);
  process.exit(1);
}
