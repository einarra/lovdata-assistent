import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillOrchestrator, SkillRegistry } from './skills-core.js';
import { loadSkillFromFolder } from './skills-loader.js';
import { logger } from '../logger.js';

let orchestratorPromise: Promise<SkillOrchestrator> | undefined;

async function bootstrap(): Promise<SkillOrchestrator> {
  const registry = new SkillRegistry();
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const skillFolders = ['lovdata-api', 'lovdata-serper'];

  for (const folder of skillFolders) {
    const skillPath = path.join(currentDir, folder);
    const skill = await loadSkillFromFolder(skillPath);
    registry.register(skill);
    logger.info({ skill: skill.name }, 'Registered skill');
  }

  return new SkillOrchestrator(registry, {
    threshold: 0.4,
    topK: 2,
    observers: [
      {
        onExecuteStart: ({ skill }) => logger.debug({ skill: skill.name }, 'Executing skill'),
        onError: ({ skill, error }) =>
          logger.error({ skill: skill?.name, err: error }, 'Skill execution error')
      }
    ]
  });
}

export function getOrchestrator(): Promise<SkillOrchestrator> {
  if (!orchestratorPromise) {
    orchestratorPromise = bootstrap();
  }
  return orchestratorPromise;
}
