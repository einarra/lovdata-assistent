#!/usr/bin/env node
// Copy skill.json files from src/skills/*/ to dist/skills/*/
// This is needed because TypeScript doesn't copy JSON files to the output directory

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const skills = ['lovdata-api', 'lovdata-serper'];

for (const skill of skills) {
  const srcPath = path.join(projectRoot, 'src', 'skills', skill, 'skill.json');
  const dstPath = path.join(projectRoot, 'dist', 'skills', skill, 'skill.json');
  
  if (fs.existsSync(srcPath)) {
    // Ensure destination directory exists
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    // Copy the file
    fs.copyFileSync(srcPath, dstPath);
    console.log(`✓ Copied ${srcPath} to ${dstPath}`);
  } else {
    console.warn(`⚠ Warning: ${srcPath} not found, skipping`);
  }
}

console.log('✓ Skill manifests copied successfully');

