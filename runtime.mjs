import { createRequire } from 'node:module';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname,join } from 'node:path';
// Dependency root resolution, in order:
// 1) MAIL_MCP_DEPS_ROOT env — an explicit package root elsewhere
// 2) this checkout after `npm install` (self-contained node_modules)
// 3) the legacy shared root on the machine this project was built on
// This keeps the original setup working without an install and lets other
// machines simply run npm install.
const here=dirname(fileURLToPath(import.meta.url));
const roots=[
  process.env.MAIL_MCP_DEPS_ROOT,
  existsSync(join(here,'node_modules'))?here:null,
  '/Users/paranee/projects/MCP_Servers/Safari_Connector/mcp-server'
].filter(Boolean);
export const dependencyRoot=roots[0];
const require=createRequire(join(dependencyRoot,'package.json'));
export async function dependency(name) { return import(pathToFileURL(require.resolve(name)).href); }
