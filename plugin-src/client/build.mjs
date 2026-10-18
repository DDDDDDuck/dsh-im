import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDirectory, '../..');
const outputPath = resolve(packageRoot, 'lib/client.js');
const loaderId = process.env.DSH_IM_CLIENT_ID ?? '@xmanrui/dsh-im';
// The sidebar masks the same transparent artwork used by the plugin catalog.
const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
const iconBytes = await readFile(resolve(packageRoot, manifest.icon));
const iconDataUrl = `data:image/webp;base64,${iconBytes.toString('base64')}`;

const result = await build({
  entryPoints: [resolve(sourceDirectory, 'index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  external: ['react', 'react-dom'],
  define: { 'process.env.DSH_IM_PLUGIN_ICON': JSON.stringify(iconDataUrl) },
  write: false,
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
});
const bundled = result.outputFiles?.[0]?.text;
if (!bundled) throw new Error('esbuild did not produce a client bundle');

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(loaderId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`;
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, wrapped, 'utf8');
console.log(`Wrote ${outputPath}`);
