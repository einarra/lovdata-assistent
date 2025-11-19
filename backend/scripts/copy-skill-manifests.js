#!/usr/bin/env node
// Copy skill.json files from src/skills/*/ to dist/skills/*/
// This is needed because TypeScript doesn't copy JSON files to the output directory

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

console.log('[copy-skill-manifests] Starting...');
console.log('[copy-skill-manifests] Project root:', projectRoot);
console.log('[copy-skill-manifests] Dist directory exists:', fs.existsSync(path.join(projectRoot, 'dist')));

const skills = ['lovdata-api', 'lovdata-serper'];
let copiedCount = 0;
let skippedCount = 0;

for (const skill of skills) {
  const srcPath = path.join(projectRoot, 'src', 'skills', skill, 'skill.json');
  const dstPath = path.join(projectRoot, 'dist', 'skills', skill, 'skill.json');
  
  console.log(`[copy-skill-manifests] Processing ${skill}...`);
  console.log(`[copy-skill-manifests] Source: ${srcPath} (exists: ${fs.existsSync(srcPath)})`);
  console.log(`[copy-skill-manifests] Destination: ${dstPath}`);
  
  if (fs.existsSync(srcPath)) {
    try {
      // Ensure destination directory exists
      const dstDir = path.dirname(dstPath);
      if (!fs.existsSync(dstDir)) {
        console.log(`[copy-skill-manifests] Creating directory: ${dstDir}`);
        fs.mkdirSync(dstDir, { recursive: true });
      }
      // Copy the file
      fs.copyFileSync(srcPath, dstPath);
      console.log(`✓ Copied ${srcPath} to ${dstPath}`);
      
      // Verify the copy
      if (fs.existsSync(dstPath)) {
        console.log(`✓ Verified: ${dstPath} exists after copy`);
        copiedCount++;
      } else {
        console.error(`✗ ERROR: ${dstPath} does not exist after copy!`);
        skippedCount++;
      }
    } catch (error) {
      console.error(`✗ ERROR copying ${skill}:`, error);
      skippedCount++;
    }
  } else {
    console.warn(`⚠ Warning: ${srcPath} not found, skipping`);
    skippedCount++;
  }
}

console.log(`[copy-skill-manifests] Summary: ${copiedCount} copied, ${skippedCount} skipped`);
if (copiedCount === skills.length) {
  console.log('✓ Skill manifests copied successfully');
  process.exit(0);
} else {
  console.error(`✗ ERROR: Failed to copy all skill manifests (expected ${skills.length}, copied ${copiedCount})`);
  process.exit(1);
}

