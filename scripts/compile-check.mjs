// Compiles the plugin with the compiler shipped inside Paseo.app, without installing it.
// Run: npm run compile-check (needs Paseo.app's Electron in Node mode to read app.asar).
const compiler = "/Applications/Paseo.app/Contents/Resources/app.asar/node_modules/@getpaseo/server/dist/server/server/plugins/compiler.js";
const dir = process.argv[2] ?? process.cwd();
const { compilePlugin } = await import(compiler);
try {
  const result = await compilePlugin({ client: `${dir}/index.client.tsx`, server: `${dir}/index.server.ts` });
  const size = (bundle) => bundle?.length ?? bundle?.code?.length ?? 0;
  console.log(`compiled: client ${size(result.clientBundle)} bytes, server ${size(result.serverBundle)} bytes`);
} catch (error) {
  console.error(`COMPILE ERROR: ${error.message}`);
  process.exit(1);
}
