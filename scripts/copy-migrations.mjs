import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
cpSync('migrations', 'dist/migrations', { recursive: true });
