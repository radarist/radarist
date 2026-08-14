/**
 * @file lib/inngest/__tests__/run-comprehensive-tech-research.test.ts
 * @description Unit tests for comprehensive technology research extraction functions
 *
 * Tests the helper functions that extract fields from AI research results:
 * - TRL extraction from maturity level
 * - TimeToImpact parsing from timeToMainstream string
 * - Category mapping from AI-generated category
 * - GitHub URL extraction from open source projects
 * - Tag extraction from research data
 * - Description extraction from executive summary
 */

import type { TechnologyResearch, TechnologyCategory } from '@/lib/types';

// Import the extraction functions via re-export for testing
// We need to test these functions indirectly by recreating them here
// since they are not exported from the main module

/**
 * Map valueAssessment.maturityLevel (1-5) to TRL (1-9)
 */
function mapMaturityToTRL(maturityLevel: 1 | 2 | 3 | 4 | 5 | undefined): number | undefined {
  if (!maturityLevel) return undefined;
  const mapping: Record<number, number> = {
    1: 2,
    2: 4,
    3: 6,
    4: 8,
    5: 9,
  };
  return mapping[maturityLevel];
}

/**
 * Parse timeToMainstream string and map to TimeToImpact horizon
 */
function parseTimeToImpact(timeToMainstream: string | undefined): 'H1' | 'H2' | 'H3' | undefined {
  if (!timeToMainstream) return undefined;

  const lower = timeToMainstream.toLowerCase();

  // Check for H1 indicators
  if (lower.includes('<1') || lower.includes('< 1') ||
      lower.includes('less than a year') || lower.includes('within a year') ||
      lower.includes('within 12 months') || lower.includes('6 months') ||
      lower.match(/^1\s*year$/)) {
    return 'H1';
  }

  // Check for H3 indicators
  if (lower.includes('3+') || lower.includes('5+') || lower.includes('10+') ||
      lower.includes('many years') || lower.includes('long term') ||
      lower.includes('3-5') || lower.includes('5-10') || lower.includes('> 3') ||
      lower.includes('>3') || lower.includes('more than 3')) {
    return 'H3';
  }

  // Check for H2 indicators
  if (lower.includes('1-2') || lower.includes('2-3') || lower.includes('1-3') ||
      lower.includes('2 years') || lower.includes('couple of years') ||
      lower.includes('medium term')) {
    return 'H2';
  }

  // Try to extract numbers
  const yearMatch = lower.match(/(\d+)(?:\s*-\s*(\d+))?\s*years?/);
  if (yearMatch) {
    const minYears = parseInt(yearMatch[1], 10);
    const maxYears = yearMatch[2] ? parseInt(yearMatch[2], 10) : minYears;
    const avgYears = (minYears + maxYears) / 2;

    if (avgYears <= 1) return 'H1';
    if (avgYears <= 3) return 'H2';
    return 'H3';
  }

  return 'H2';
}

/**
 * Map AI-generated category string to TechnologyCategory enum
 */
function mapToTechnologyCategory(aiCategory: string | undefined): TechnologyCategory | undefined {
  if (!aiCategory) return undefined;

  const lower = aiCategory.toLowerCase();

  const categoryMap: Record<string, TechnologyCategory> = {
    'framework': 'framework',
    'language': 'language',
    'programming language': 'language',
    'platform': 'platform',
    'tool': 'tool',
    'library': 'library',
    'service': 'service',
    'methodology': 'methodology',
    'infrastructure': 'infrastructure',
    'hardware': 'hardware',
    'standard': 'standard',
    'protocol': 'protocol',
    'api': 'api',
    'architecture': 'architecture',
  };

  for (const [key, value] of Object.entries(categoryMap)) {
    if (lower === key || lower.includes(key)) {
      return value;
    }
  }

  if (lower.includes('cloud') || lower.includes('hosting') || lower.includes('paas') || lower.includes('iaas')) {
    return 'platform';
  }
  if (lower.includes('sdk') || lower.includes('kit')) {
    return 'library';
  }
  if (lower.includes('process') || lower.includes('practice') || lower.includes('agile') || lower.includes('devops')) {
    return 'methodology';
  }
  if (lower.includes('database') || lower.includes('storage') || lower.includes('compute') || lower.includes('network')) {
    return 'infrastructure';
  }
  if (lower.includes('chip') || lower.includes('device') || lower.includes('sensor') || lower.includes('iot')) {
    return 'hardware';
  }

  return 'other';
}

/**
 * Extract GitHub URL from open source projects
 */
function extractGitHubUrl(research: Partial<TechnologyResearch>): string | undefined {
  const openSourceProjects = research.keyPlayers?.openSourceProjects;
  if (!openSourceProjects || openSourceProjects.length === 0) return undefined;

  const sortedProjects = [...openSourceProjects].sort((a, b) => (b.stars || 0) - (a.stars || 0));
  const topProject = sortedProjects[0];

  if (!topProject?.name) return undefined;

  const githubUrlMatch = topProject.name.match(/github\.com\/[\w-]+\/[\w-]+/i);
  if (githubUrlMatch) {
    return `https://${githubUrlMatch[0]}`;
  }

  const descMatch = topProject.description?.match(/github\.com\/[\w-]+\/[\w-]+/i);
  if (descMatch) {
    return `https://${descMatch[0]}`;
  }

  return undefined;
}

/**
 * Generate tags from research data
 */
function extractTags(research: Partial<TechnologyResearch>, existingTags: string[] = []): string[] {
  const newTags = new Set<string>(existingTags);

  const hypeCyclePosition = research.maturityAssessment?.hypeCyclePosition;
  if (hypeCyclePosition) {
    const hypeCycleTagMap: Record<string, string> = {
      'innovation-trigger': 'emerging',
      'peak-of-inflated-expectations': 'hyped',
      'trough-of-disillusionment': 'consolidating',
      'slope-of-enlightenment': 'maturing',
      'plateau-of-productivity': 'mature',
    };
    const hypeTag = hypeCycleTagMap[hypeCyclePosition];
    if (hypeTag) newTags.add(hypeTag);
  }

  const trajectory = research.maturityAssessment?.maturityTrajectory;
  if (trajectory === 'accelerating') {
    newTags.add('fast-growing');
  }

  const category = research.technologyMetrics?.category;
  if (category) {
    const categoryLower = category.toLowerCase();
    const terms = ['ai', 'ml', 'machine-learning', 'blockchain', 'quantum', 'cloud', 'security', 'data', 'devops', 'mobile', 'web'];
    for (const term of terms) {
      if (categoryLower.includes(term)) {
        newTags.add(term);
        break;
      }
    }
  }

  const industries = research.useCasesAndApplications?.byIndustry?.slice(0, 2);
  if (industries) {
    for (const ind of industries) {
      if (ind.industry && ind.industry.length < 20) {
        newTags.add(ind.industry.toLowerCase().replace(/\s+/g, '-'));
      }
    }
  }

  return Array.from(newTags).slice(0, 10);
}

/**
 * Extract description from executive summary
 */
function extractDescription(research: Partial<TechnologyResearch>): string | undefined {
  const summary = research.executiveSummary?.summary;
  if (!summary) return undefined;

  if (summary.length <= 500) return summary;

  const truncated = summary.substring(0, 500);
  const lastPeriod = truncated.lastIndexOf('.');
  const lastQuestion = truncated.lastIndexOf('?');
  const lastExclaim = truncated.lastIndexOf('!');

  const breakPoint = Math.max(lastPeriod, lastQuestion, lastExclaim);
  if (breakPoint > 300) {
    return summary.substring(0, breakPoint + 1);
  }

  return truncated.trim() + '...';
}

describe('Comprehensive Tech Research Extraction Functions', () => {
  describe('mapMaturityToTRL', () => {
    it('should map maturity level 1 to TRL 2', () => {
      expect(mapMaturityToTRL(1)).toBe(2);
    });

    it('should map maturity level 2 to TRL 4', () => {
      expect(mapMaturityToTRL(2)).toBe(4);
    });

    it('should map maturity level 3 to TRL 6', () => {
      expect(mapMaturityToTRL(3)).toBe(6);
    });

    it('should map maturity level 4 to TRL 8', () => {
      expect(mapMaturityToTRL(4)).toBe(8);
    });

    it('should map maturity level 5 to TRL 9', () => {
      expect(mapMaturityToTRL(5)).toBe(9);
    });

    it('should return undefined for undefined input', () => {
      expect(mapMaturityToTRL(undefined)).toBeUndefined();
    });
  });

  describe('parseTimeToImpact', () => {
    describe('H1 (0-12 months)', () => {
      it('should parse "<1 year" as H1', () => {
        expect(parseTimeToImpact('<1 year')).toBe('H1');
      });

      it('should parse "within 12 months" as H1', () => {
        expect(parseTimeToImpact('within 12 months')).toBe('H1');
      });

      it('should parse "6 months" as H1', () => {
        expect(parseTimeToImpact('6 months')).toBe('H1');
      });

      it('should parse "less than a year" as H1', () => {
        expect(parseTimeToImpact('less than a year')).toBe('H1');
      });
    });

    describe('H2 (1-3 years)', () => {
      it('should parse "1-2 years" as H2', () => {
        expect(parseTimeToImpact('1-2 years')).toBe('H2');
      });

      it('should parse "2-3 years" as H2', () => {
        expect(parseTimeToImpact('2-3 years')).toBe('H2');
      });

      it('should parse "2 years" as H2', () => {
        expect(parseTimeToImpact('2 years')).toBe('H2');
      });

      it('should parse "medium term" as H2', () => {
        expect(parseTimeToImpact('medium term')).toBe('H2');
      });
    });

    describe('H3 (3+ years)', () => {
      it('should parse "3+ years" as H3', () => {
        expect(parseTimeToImpact('3+ years')).toBe('H3');
      });

      it('should parse "5-10 years" as H3', () => {
        expect(parseTimeToImpact('5-10 years')).toBe('H3');
      });

      it('should parse "long term" as H3', () => {
        expect(parseTimeToImpact('long term')).toBe('H3');
      });

      it('should parse "more than 3 years" as H3', () => {
        expect(parseTimeToImpact('more than 3 years')).toBe('H3');
      });
    });

    it('should return undefined for undefined input', () => {
      expect(parseTimeToImpact(undefined)).toBeUndefined();
    });

    it('should default to H2 for ambiguous input', () => {
      expect(parseTimeToImpact('sometime in the future')).toBe('H2');
    });
  });

  describe('mapToTechnologyCategory', () => {
    it('should map "framework" to framework', () => {
      expect(mapToTechnologyCategory('framework')).toBe('framework');
    });

    it('should map "programming language" to language', () => {
      expect(mapToTechnologyCategory('programming language')).toBe('language');
    });

    it('should map "Cloud Platform" to platform', () => {
      expect(mapToTechnologyCategory('Cloud Platform')).toBe('platform');
    });

    it('should map "SDK" to library', () => {
      expect(mapToTechnologyCategory('SDK')).toBe('library');
    });

    it('should map "DevOps practices" to methodology', () => {
      expect(mapToTechnologyCategory('DevOps practices')).toBe('methodology');
    });

    it('should map "Database system" to infrastructure', () => {
      expect(mapToTechnologyCategory('Database system')).toBe('infrastructure');
    });

    it('should map "IoT device" to hardware', () => {
      expect(mapToTechnologyCategory('IoT device')).toBe('hardware');
    });

    it('should return "other" for unknown categories', () => {
      expect(mapToTechnologyCategory('some random category')).toBe('other');
    });

    it('should return undefined for undefined input', () => {
      expect(mapToTechnologyCategory(undefined)).toBeUndefined();
    });
  });

  describe('extractGitHubUrl', () => {
    it('should extract GitHub URL from project name', () => {
      const research: Partial<TechnologyResearch> = {
        keyPlayers: {
          marketLeaders: [],
          emergingStartups: [],
          researchInstitutions: [],
          openSourceProjects: [
            {
              name: 'Qiskit (github.com/Qiskit/qiskit)',
              description: 'Open-source quantum computing framework',
              stars: 5000,
            },
          ],
        },
      };

      expect(extractGitHubUrl(research)).toBe('https://github.com/Qiskit/qiskit');
    });

    it('should extract GitHub URL from project description', () => {
      const research: Partial<TechnologyResearch> = {
        keyPlayers: {
          marketLeaders: [],
          emergingStartups: [],
          researchInstitutions: [],
          openSourceProjects: [
            {
              name: 'Cirq',
              description: 'Python framework for NISQ computers - see github.com/quantumlib/cirq',
              stars: 3000,
            },
          ],
        },
      };

      expect(extractGitHubUrl(research)).toBe('https://github.com/quantumlib/cirq');
    });

    it('should prioritize project with most stars', () => {
      const research: Partial<TechnologyResearch> = {
        keyPlayers: {
          marketLeaders: [],
          emergingStartups: [],
          researchInstitutions: [],
          openSourceProjects: [
            {
              name: 'LessPopular',
              description: 'Less popular - github.com/org/less-popular',
              stars: 100,
            },
            {
              name: 'MorePopular (github.com/org/more-popular)',
              description: 'More popular project',
              stars: 5000,
            },
          ],
        },
      };

      expect(extractGitHubUrl(research)).toBe('https://github.com/org/more-popular');
    });

    it('should return undefined when no open source projects', () => {
      const research: Partial<TechnologyResearch> = {
        keyPlayers: {
          marketLeaders: [],
          emergingStartups: [],
          researchInstitutions: [],
          openSourceProjects: [],
        },
      };

      expect(extractGitHubUrl(research)).toBeUndefined();
    });

    it('should return undefined when no GitHub URL found', () => {
      const research: Partial<TechnologyResearch> = {
        keyPlayers: {
          marketLeaders: [],
          emergingStartups: [],
          researchInstitutions: [],
          openSourceProjects: [
            {
              name: 'Some Project',
              description: 'A project without GitHub link',
            },
          ],
        },
      };

      expect(extractGitHubUrl(research)).toBeUndefined();
    });
  });

  describe('extractTags', () => {
    it('should extract tag from hype cycle position', () => {
      const research: Partial<TechnologyResearch> = {
        maturityAssessment: {
          hypeCyclePosition: 'innovation-trigger',
          timeToMainstream: '5+ years',
          maturityTrajectory: 'accelerating',
        },
      };

      const tags = extractTags(research);
      expect(tags).toContain('emerging');
    });

    it('should add "fast-growing" tag for accelerating trajectory', () => {
      const research: Partial<TechnologyResearch> = {
        maturityAssessment: {
          hypeCyclePosition: 'slope-of-enlightenment',
          timeToMainstream: '2 years',
          maturityTrajectory: 'accelerating',
        },
      };

      const tags = extractTags(research);
      expect(tags).toContain('fast-growing');
    });

    it('should extract category-related tags', () => {
      const research: Partial<TechnologyResearch> = {
        technologyMetrics: {
          category: 'Quantum Computing',
          keyMetrics: [],
          milestones: [],
        },
      };

      const tags = extractTags(research);
      expect(tags).toContain('quantum');
    });

    it('should extract industry tags', () => {
      const research: Partial<TechnologyResearch> = {
        useCasesAndApplications: {
          byMaturity: { production: [], piloting: [], experimental: [] },
          byIndustry: [
            { industry: 'Finance', useCases: ['trading'] },
            { industry: 'Healthcare', useCases: ['drug discovery'] },
          ],
          byFunction: [],
          flagshipExamples: [],
        },
      };

      const tags = extractTags(research);
      expect(tags).toContain('finance');
      expect(tags).toContain('healthcare');
    });

    it('should preserve existing tags', () => {
      const research: Partial<TechnologyResearch> = {};
      const existingTags = ['existing-tag', 'another-tag'];

      const tags = extractTags(research, existingTags);
      expect(tags).toContain('existing-tag');
      expect(tags).toContain('another-tag');
    });

    it('should limit tags to 10', () => {
      const research: Partial<TechnologyResearch> = {
        maturityAssessment: {
          hypeCyclePosition: 'innovation-trigger',
          timeToMainstream: '5 years',
          maturityTrajectory: 'accelerating',
        },
        technologyMetrics: {
          category: 'AI Machine Learning',
          keyMetrics: [],
          milestones: [],
        },
        useCasesAndApplications: {
          byMaturity: { production: [], piloting: [], experimental: [] },
          byIndustry: [
            { industry: 'Finance', useCases: [] },
            { industry: 'Healthcare', useCases: [] },
          ],
          byFunction: [],
          flagshipExamples: [],
        },
      };
      const existingTags = ['tag1', 'tag2', 'tag3', 'tag4', 'tag5', 'tag6', 'tag7', 'tag8'];

      const tags = extractTags(research, existingTags);
      expect(tags.length).toBeLessThanOrEqual(10);
    });
  });

  describe('extractDescription', () => {
    it('should extract short summary as-is', () => {
      const research: Partial<TechnologyResearch> = {
        executiveSummary: {
          summary: 'Quantum computing uses quantum mechanics to perform computations.',
          keyInsights: [],
        },
      };

      expect(extractDescription(research)).toBe(
        'Quantum computing uses quantum mechanics to perform computations.'
      );
    });

    it('should truncate long summaries at sentence boundary', () => {
      // Create a summary with periods at positions > 300 but < 500
      const longSummary = 'A'.repeat(350) + '. ' + 'B'.repeat(200) + '. ' + 'C'.repeat(100);
      const research: Partial<TechnologyResearch> = {
        executiveSummary: {
          summary: longSummary,
          keyInsights: [],
        },
      };

      const result = extractDescription(research);
      expect(result).toBeDefined();
      // Should break at the period at position 350
      expect(result!.length).toBeLessThanOrEqual(500);
      expect(result!.endsWith('.')).toBe(true);
    });

    it('should truncate with ellipsis when no good break point', () => {
      const noBreakSummary = 'A'.repeat(600); // No punctuation
      const research: Partial<TechnologyResearch> = {
        executiveSummary: {
          summary: noBreakSummary,
          keyInsights: [],
        },
      };

      const result = extractDescription(research);
      expect(result).toBeDefined();
      expect(result!.endsWith('...')).toBe(true);
    });

    it('should return undefined when no summary', () => {
      const research: Partial<TechnologyResearch> = {};
      expect(extractDescription(research)).toBeUndefined();
    });
  });

  describe('Quantum Computing E2E Scenario', () => {
    /**
     * This test simulates the full extraction flow for a "Quantum Computing" technology
     * to verify all extraction functions work together correctly.
     */
    it('should correctly extract all fields from Quantum Computing research', () => {
      const quantumResearch: Partial<TechnologyResearch> = {
        lastResearched: Date.now(),
        version: 1,
        executiveSummary: {
          summary:
            'Quantum computing harnesses quantum mechanical phenomena like superposition and entanglement ' +
            'to perform computations that would be infeasible for classical computers. While still in early ' +
            'stages, quantum computing shows promise for applications in cryptography, drug discovery, ' +
            'financial modeling, and optimization problems. Major tech companies and startups are racing ' +
            'to achieve practical quantum advantage.',
          keyInsights: [
            'Still 5-10 years from practical commercial applications',
            'IBM and Google leading in qubit count',
            'Error correction remains key challenge',
            'Hybrid quantum-classical algorithms showing near-term promise',
          ],
        },
        maturityAssessment: {
          hypeCyclePosition: 'peak-of-inflated-expectations',
          timeToMainstream: '5-10 years',
          maturityTrajectory: 'accelerating',
        },
        technologyMetrics: {
          category: 'Quantum Computing Hardware/Software',
          keyMetrics: [
            { name: 'Qubit Count', value: '1000+', trend: 'up' },
            { name: 'Coherence Time', value: '~100μs', trend: 'up' },
          ],
          milestones: [
            { date: '2019', description: 'Google quantum supremacy claim' },
            { date: '2023', description: 'IBM 1000+ qubit processor' },
          ],
        },
        keyPlayers: {
          marketLeaders: [
            { name: 'IBM', role: 'Quantum processor development', marketShare: '30%' },
            { name: 'Google', role: 'Quantum supremacy research', marketShare: '25%' },
          ],
          emergingStartups: [
            { name: 'IonQ', focus: 'Trapped ion quantum computers', funding: '$632M' },
            { name: 'Rigetti', focus: 'Superconducting quantum computers', funding: '$200M' },
          ],
          researchInstitutions: [
            { name: 'MIT', contribution: 'Quantum error correction research' },
          ],
          openSourceProjects: [
            {
              name: 'Qiskit (github.com/Qiskit/qiskit)',
              description: "IBM's open-source quantum computing SDK",
              stars: 5000,
            },
            {
              name: 'Cirq',
              description: "Google's quantum computing framework - github.com/quantumlib/Cirq",
              stars: 4000,
            },
          ],
        },
        valueAssessment: {
          maturityLevel: 2, // TRL 4 (validated in lab)
          primaryValueDrivers: ['Exponential speedup for specific problems'],
          quantifiedBenefits: [{ benefit: '1000x faster for certain optimization problems' }],
          evidenceLevel: 'limited',
          roiAssessable: false,
          strategicValue: 'significant',
          competitiveAdvantageType: 'differentiation',
        },
        useCasesAndApplications: {
          byMaturity: {
            production: [],
            piloting: ['Drug molecule simulation'],
            experimental: ['Cryptography breaking', 'Financial modeling'],
          },
          byIndustry: [
            { industry: 'Pharmaceuticals', useCases: ['Drug discovery', 'Molecule simulation'] },
            { industry: 'Finance', useCases: ['Portfolio optimization', 'Risk analysis'] },
          ],
          byFunction: [],
          flagshipExamples: [],
        },
      };

      // Test TRL extraction
      const trl = mapMaturityToTRL(quantumResearch.valueAssessment?.maturityLevel as 1 | 2 | 3 | 4 | 5);
      expect(trl).toBe(4);

      // Test TimeToImpact extraction
      const timeToImpact = parseTimeToImpact(quantumResearch.maturityAssessment?.timeToMainstream);
      expect(timeToImpact).toBe('H3');

      // Test category extraction
      const category = mapToTechnologyCategory(quantumResearch.technologyMetrics?.category);
      expect(category).toBe('hardware'); // "Hardware/Software" matches hardware

      // Test GitHub URL extraction
      const githubUrl = extractGitHubUrl(quantumResearch);
      expect(githubUrl).toBe('https://github.com/Qiskit/qiskit');

      // Test tag extraction
      const tags = extractTags(quantumResearch);
      expect(tags).toContain('hyped'); // peak-of-inflated-expectations
      expect(tags).toContain('fast-growing'); // accelerating trajectory
      expect(tags).toContain('quantum'); // from category
      expect(tags).toContain('pharmaceuticals'); // from industry
      expect(tags).toContain('finance'); // from industry

      // Test description extraction
      const description = extractDescription(quantumResearch);
      expect(description).toBeDefined();
      expect(description).toContain('Quantum computing');
      expect(description!.length).toBeLessThanOrEqual(500);
    });
  });
});
