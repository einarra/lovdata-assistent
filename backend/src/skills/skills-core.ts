export type SkillContext = {
  userId?: string;
  locale?: string;
  now?: Date;
  services?: Record<string, unknown>;
  scratch?: Record<string, unknown>;
};

export type SkillIO = {
  input: unknown;
  hints?: Record<string, unknown>;
};

export type SkillOutput = {
  result: unknown;
  artifacts?: Record<string, Buffer | string | Uint8Array>;
  meta?: Record<string, unknown>;
};

export type SkillScore = number;

export type SkillGuard = (args: {
  ctx: SkillContext;
  io: SkillIO;
}) => Promise<void> | void;

export type SkillObserver = {
  onMatchStart?(data: { skill: Skill; score: SkillScore; io: SkillIO; ctx: SkillContext }): void;
  onMatchEnd?(data: { skill: Skill; score: SkillScore; io: SkillIO; ctx: SkillContext }): void;
  onExecuteStart?(data: { skill: Skill; io: SkillIO; ctx: SkillContext }): void;
  onExecuteEnd?(data: { skill: Skill; output: SkillOutput; io: SkillIO; ctx: SkillContext }): void;
  onError?(data: { skill?: Skill; error: unknown; io: SkillIO; ctx: SkillContext }): void;
};

export type Skill = {
  name: string;
  version?: string;
  summary?: string;
  description?: string;
  match(io: SkillIO, ctx: SkillContext): Promise<SkillScore> | SkillScore;
  guard?: SkillGuard;
  execute(io: SkillIO, ctx: SkillContext): Promise<SkillOutput> | SkillOutput;
  inputSchema?: object;
  tags?: string[];
};

export class SkillRegistry {
  private skills: Skill[] = [];

  register(...skills: Skill[]) {
    this.skills.push(...skills);
  }

  unregister(name: string) {
    this.skills = this.skills.filter(skill => skill.name !== name);
  }

  list() {
    return [...this.skills];
  }
}

export type OrchestratorOptions = {
  threshold?: number;
  topK?: number;
  observers?: SkillObserver[];
};

export class SkillOrchestrator {
  constructor(
    private readonly registry: SkillRegistry,
    private readonly options: OrchestratorOptions = {}
  ) {}

  async route(io: SkillIO, ctx: SkillContext, skillsOverride?: Skill[]): Promise<{ skill?: Skill; score: number }> {
    const skills = skillsOverride ?? this.registry.list();
    const scored: { skill: Skill; score: number }[] = [];

    for (const skill of skills) {
      let score = 0;
      try {
        score = await skill.match(io, ctx);
        this.options.observers?.forEach(observer => observer.onMatchStart?.({ skill, score, io, ctx }));
        if (typeof score !== 'number' || Number.isNaN(score)) {
          score = 0;
        }
        score = Math.max(0, Math.min(1, score));
      } catch (error) {
        this.options.observers?.forEach(observer => observer.onError?.({ skill, error, io, ctx }));
        score = 0;
      } finally {
        this.options.observers?.forEach(observer => observer.onMatchEnd?.({ skill, score, io, ctx }));
      }
      scored.push({ skill, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const topMatch = scored
      .slice(0, this.options.topK ?? 3)
      .find(candidate => candidate.score >= (this.options.threshold ?? 0.4));

    return topMatch ?? { skill: undefined, score: 0 };
  }

  async run(io: SkillIO, ctx: SkillContext): Promise<SkillOutput> {
    const skills = this.registry.list();
    const preferredSkillName = typeof io.hints?.preferredSkill === 'string' ? (io.hints.preferredSkill as string) : undefined;

    if (preferredSkillName) {
      const preferredSkill = skills.find(candidate => candidate.name === preferredSkillName);
      if (preferredSkill) {
        return this.executeSkill(preferredSkill, io, ctx);
      }
    }

    const { skill, score } = await this.route(io, ctx, skills);
    if (!skill) {
      return {
        result: { message: 'No suitable skill found', reason: 'threshold' },
        meta: { score }
      };
    }

    // Import logger here to avoid circular dependency
    const { logger } = await import('../logger.js');
    logger.info({ skillName: skill.name, score }, 'SkillOrchestrator: executing skill');
    
    return this.executeSkill(skill, io, ctx);
  }

  private async executeSkill(skill: Skill, io: SkillIO, ctx: SkillContext): Promise<SkillOutput> {
    try {
      if (skill.guard) {
        this.options.observers?.forEach(observer => observer.onExecuteStart?.({ skill, io, ctx }));
        await skill.guard({ io, ctx });
      }
      this.options.observers?.forEach(observer => observer.onExecuteStart?.({ skill, io, ctx }));
      const output = await skill.execute(io, ctx);
      this.options.observers?.forEach(observer => observer.onExecuteEnd?.({ skill, output, io, ctx }));
      return output;
    } catch (error) {
      this.options.observers?.forEach(observer => observer.onError?.({ skill, error, io, ctx }));
      throw error;
    }
  }
}
