import fs from 'fs';
import path from 'path';
import { StructuredLogger } from '../core/types.ts';

export interface SkillDocument {
  name: string;
  purpose: string;
  rules: string[];
  constraints: string[];
  forbidden: string[];
  rawContent: string;
}

export interface RetrievalQuery {
  taskType:
    | 'layout-disambiguation'
    | 'tablix-mapping'
    | 'vb-logic'
    | 'finance-calc'
    | 'project-integration'
    | 'proposal-adaptation'
    | 'diagnosis';
  hasFinancialTerms: boolean;
  hasExistingProject: boolean;
  hasComplexGraphics: boolean;
  keywords: string[];
}

export interface IContextRetriever {
  retrieveRelevantSkills(query: RetrievalQuery): SkillDocument[];
}

export class SkillManager implements IContextRetriever {
  private readonly skillsDir: string;
  private readonly logger: StructuredLogger;
  private readonly cache = new Map<string, SkillDocument>();

  constructor(logger: StructuredLogger, workspaceRoot = process.cwd()) {
    this.logger = logger;
    this.skillsDir = path.join(workspaceRoot, 'skills');
  }

  public listAvailableSkills(): string[] {
    if (!fs.existsSync(this.skillsDir)) return [];
    const results: string[] = [];

    for (const entry of fs.readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(this.skillsDir, entry.name);
      if (fs.existsSync(path.join(subDir, 'skill.md'))) {
        results.push(entry.name);
      }
      for (const child of fs.readdirSync(subDir, { withFileTypes: true })) {
        if (child.isFile() && child.name.endsWith('.md') && child.name !== 'skill.md') {
          results.push(`${entry.name}/${child.name.replace(/\.md$/, '')}`);
        }
      }
    }
    return results.sort();
  }

  public loadSkill(skillName: string): SkillDocument | null {
    if (this.cache.has(skillName)) {
      return this.cache.get(skillName)!;
    }

    const candidates = [
      path.join(this.skillsDir, `${skillName}.md`),
      path.join(this.skillsDir, skillName, 'skill.md'),
    ];
    const skillPath = candidates.find((p) => fs.existsSync(p));
    if (!skillPath) {
      this.logger.warn('SkillManager', `Requested skill "${skillName}" not found`);
      return null;
    }

    const rawContent = fs.readFileSync(skillPath, 'utf-8');
    const doc = this.parseSkillMarkdown(skillName, rawContent);
    this.cache.set(skillName, doc);
    return doc;
  }

  public retrieveRelevantSkills(query: RetrievalQuery): SkillDocument[] {
    const selectedNames = new Set<string>();

    if (query.taskType === 'layout-disambiguation') {
      selectedNames.add('pdf-layout');
      selectedNames.add('rdlc-tablix');
      selectedNames.add('pdf/layout-analysis');
    }
    if (query.taskType === 'tablix-mapping') {
      selectedNames.add('rdlc-tablix');
      selectedNames.add('pdf/table-detection');
    }
    if (query.taskType === 'vb-logic') {
      selectedNames.add('vb-report');
    }
    if (query.taskType === 'proposal-adaptation') {
      selectedNames.add('proposal/proposal-builder');
      selectedNames.add('proposal/proposal-element');
      selectedNames.add('proposal/proposal-layout');
      selectedNames.add('pdf/dynamic-field');
      selectedNames.add('pdf/status-field');
    }
    if (query.taskType === 'diagnosis') {
      selectedNames.add('validation/report-validation');
      selectedNames.add('proposal/proposal-layout');
    }
    if (query.hasFinancialTerms || query.taskType === 'finance-calc') {
      selectedNames.add('finance-calculation');
    }
    if (query.hasExistingProject || query.taskType === 'project-integration') {
      selectedNames.add('project-convention');
    }

    const loaded: SkillDocument[] = [];
    for (const name of selectedNames) {
      const skill = this.loadSkill(name);
      if (skill) loaded.push(skill);
    }

    this.logger.info('SkillManager', `Selective skill loading selected ${loaded.length} skill(s)`, {
      skills: loaded.map((s) => s.name),
    });
    return loaded;
  }

  private parseSkillMarkdown(name: string, rawContent: string): SkillDocument {
    const extractSection = (heading: string): string => {
      const regex = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'i');
      const match = rawContent.match(regex);
      return match ? match[1].trim() : '';
    };

    const toBullets = (text: string): string[] =>
      text
        .split('\n')
        .map((l) => l.replace(/^(\d+\.|-|\*)\s+/, '').trim())
        .filter((l) => l.length > 0);

    return {
      name,
      purpose: extractSection('Purpose'),
      rules: toBullets(extractSection('Rules')),
      constraints: toBullets(extractSection('Constraints')),
      forbidden: toBullets(extractSection('Forbidden Behavior')),
      rawContent,
    };
  }
}
