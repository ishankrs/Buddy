const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const ctx = esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
});

if (watch) {
  ctx.then((c) => c.watch()).then(() => {
    console.log('Watching for changes...');
  });
} else {
  ctx.then((c) => c.rebuild()).then(() => process.exit(0));
}
