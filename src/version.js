// version.js — single source of truth for the package version, decoupled
// from index.js so importers (routes, status, tests) don't transitively
// boot the HTTP daemon just to read a string.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

export const VERSION = PKG.version;
