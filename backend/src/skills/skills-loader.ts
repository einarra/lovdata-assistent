import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SkillContext, SkillIO } from './skills-core.js';
import { Skill } from './skills-core.js';

export type Manifest = {
  name: string;
  version?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  matchers?: { includes?: string[]; excludes?: string[]; weight?: number }[];
  module?: string;
};

async function readManifest(folder: string): Promise<Manifest> {
  const candidates = ['skill.json', 'skill.yaml', 'skill.yml'];
  
  // Try to find manifest in the provided folder first
  for (const filename of candidates) {
    const manifestPath = path.join(folder, filename);
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      if (filename.endsWith('.json')) {
        return JSON.parse(raw);
      }
      throw new Error('YAML support not implemented. Please provide skill.json');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }
  
  // Fallback: if we're in dist/, try looking in src/ (for development or if copy failed)
  // This helps when skill.json files aren't copied to dist during build
  // Also try relative paths that might work in different deployment scenarios
  const fallbackPaths: string[] = [];
  if (folder.includes('/dist/')) {
    fallbackPaths.push(folder.replace('/dist/', '/src/'));
    // Also try without the dist/src distinction (in case of different path structures)
    const skillName = path.basename(folder);
    fallbackPaths.push(path.join(path.dirname(path.dirname(folder)), 'src', 'skills', skillName));
  }
  
  for (const fallbackFolder of fallbackPaths) {
    for (const filename of candidates) {
      const manifestPath = path.join(fallbackFolder, filename);
      try {
        const raw = await fs.readFile(manifestPath, 'utf8');
        if (filename.endsWith('.json')) {
          return JSON.parse(raw);
        }
        throw new Error('YAML support not implemented. Please provide skill.json');
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw error;
      }
    }
  }
  
  throw new Error(`No skill manifest found in ${folder}${folder.includes('/dist/') ? ` or ${folder.replace('/dist/', '/src/')}` : ''}`);
}

function normaliseModuleCandidates(moduleField?: string): string[] {
  const defaults = ['index.js', 'index.ts'];
  if (!moduleField) {
    return defaults;
  }
  const hasExtension = path.extname(moduleField) !== '';
  if (hasExtension) {
    if (moduleField.endsWith('.js')) {
      return [moduleField, moduleField.replace(/\.js$/, '.ts')];
    }
    if (moduleField.endsWith('.ts')) {
      return [moduleField, moduleField.replace(/\.ts$/, '.js')];
    }
    return [moduleField];
  }
  return [moduleField, `${moduleField}.js`, `${moduleField}.ts`, ...defaults];
}

async function loadModule(folder: string, manifest: Manifest): Promise<any> {
  const candidates = normaliseModuleCandidates(manifest.module);
  for (const candidate of candidates) {
    const absolutePath = path.join(folder, candidate);
    try {
      const importUrl = pathToFileURL(absolutePath).href;
      return await import(importUrl);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' || (error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      if (error instanceof Error && 'code' in error && (error as any).code === 'MODULE_NOT_FOUND') {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Unable to resolve module for skill ${manifest.name}. Checked: ${candidates.join(', ')}`);
}

export async function loadSkillFromFolder(folder: string): Promise<Skill> {
  const manifest = await readManifest(folder);
  const mod = await loadModule(folder, manifest);

  const skill: Skill = {
    name: manifest.name,
    version: manifest.version,
    summary: manifest.summary,
    description: manifest.description,
    tags: manifest.tags,
    async match(io: SkillIO): Promise<number> {
      const serialized = typeof io.input === 'string' ? io.input.toLowerCase() : JSON.stringify(io.input ?? {}).toLowerCase();
      let score = 0;
      for (const matcher of manifest.matchers ?? []) {
        const includesOk = (matcher.includes ?? []).every(token => serialized.includes(token.toLowerCase()));
        const excludesOk = (matcher.excludes ?? []).every(token => !serialized.includes(token.toLowerCase()));
        if (includesOk && excludesOk) {
          score = Math.max(score, matcher.weight ?? 0.6);
        }
      }
      return score;
    },
    guard: mod.guard,
    async execute(io: SkillIO, ctx: SkillContext) {
      if (!mod.execute) {
        throw new Error(`Skill module ${manifest.name} is missing an execute(io, ctx) export`);
      }
      return mod.execute(io, ctx);
    }
  };

  return skill;
}
