/**
 * Concept Normalization Utility
 *
 * Normalizes tag/concept variations to canonical slugs.
 * For example: "AI", "ai", "A.I." all map to "artificial-intelligence"
 *
 * @phase Knowledge Graph Intelligence Sprint - Phase 6
 */

/**
 * Static mappings from common variations to canonical slugs.
 * Keys are lowercase for case-insensitive matching.
 * Values are the canonical slug that should be used.
 */
export const CONCEPT_MAPPINGS: Record<string, string> = {
  // Artificial Intelligence variations
  'ai': 'artificial-intelligence',
  'a.i.': 'artificial-intelligence',
  'a.i': 'artificial-intelligence',
  'artificial intelligence': 'artificial-intelligence',

  // Machine Learning variations
  'ml': 'machine-learning',
  'm.l.': 'machine-learning',
  'machine learning': 'machine-learning',

  // Deep Learning
  'dl': 'deep-learning',
  'deep learning': 'deep-learning',

  // Natural Language Processing
  'nlp': 'natural-language-processing',
  'n.l.p.': 'natural-language-processing',
  'natural language processing': 'natural-language-processing',

  // Computer Vision
  'cv': 'computer-vision',
  'computer vision': 'computer-vision',

  // Internet of Things
  'iot': 'internet-of-things',
  'i.o.t.': 'internet-of-things',
  'internet of things': 'internet-of-things',

  // Extended/Virtual/Augmented Reality
  'ar': 'augmented-reality',
  'a.r.': 'augmented-reality',
  'augmented reality': 'augmented-reality',
  'vr': 'virtual-reality',
  'v.r.': 'virtual-reality',
  'virtual reality': 'virtual-reality',
  'xr': 'extended-reality',
  'x.r.': 'extended-reality',
  'extended reality': 'extended-reality',
  'mr': 'mixed-reality',
  'mixed reality': 'mixed-reality',

  // Large Language Models
  'llm': 'large-language-models',
  'llms': 'large-language-models',
  'large language model': 'large-language-models',
  'large language models': 'large-language-models',

  // Generative AI
  'gen ai': 'generative-ai',
  'genai': 'generative-ai',
  'generative ai': 'generative-ai',
  'generative artificial intelligence': 'generative-ai',

  // Software as a Service
  'saas': 'software-as-a-service',
  's.a.a.s.': 'software-as-a-service',
  'software as a service': 'software-as-a-service',

  // Platform as a Service
  'paas': 'platform-as-a-service',
  'platform as a service': 'platform-as-a-service',

  // Infrastructure as a Service
  'iaas': 'infrastructure-as-a-service',
  'infrastructure as a service': 'infrastructure-as-a-service',

  // Application Programming Interface
  'api': 'application-programming-interface',
  'apis': 'application-programming-interface',

  // User Interface / User Experience
  'ui': 'user-interface',
  'user interface': 'user-interface',
  'ux': 'user-experience',
  'user experience': 'user-experience',
  'ui/ux': 'user-interface-design',
  'ux/ui': 'user-interface-design',

  // Research and Development
  'r&d': 'research-and-development',
  'r & d': 'research-and-development',
  'research and development': 'research-and-development',

  // Business Intelligence
  'bi': 'business-intelligence',
  'b.i.': 'business-intelligence',
  'business intelligence': 'business-intelligence',

  // Electronic Commerce
  'ecommerce': 'electronic-commerce',
  'e-commerce': 'electronic-commerce',
  'electronic commerce': 'electronic-commerce',

  // Business to Business / Business to Consumer
  'b2b': 'business-to-business',
  'b-to-b': 'business-to-business',
  'business to business': 'business-to-business',
  'b2c': 'business-to-consumer',
  'b-to-c': 'business-to-consumer',
  'business to consumer': 'business-to-consumer',

  // DevOps
  'devops': 'development-operations',
  'dev ops': 'development-operations',
  'development operations': 'development-operations',

  // MLOps
  'mlops': 'machine-learning-operations',
  'ml ops': 'machine-learning-operations',

  // DataOps
  'dataops': 'data-operations',
  'data ops': 'data-operations',

  // Others
  'erp': 'enterprise-resource-planning',
  'enterprise resource planning': 'enterprise-resource-planning',
  'crm': 'customer-relationship-management',
  'customer relationship management': 'customer-relationship-management',
  'scm': 'supply-chain-management',
  'supply chain management': 'supply-chain-management',
  'rpa': 'robotic-process-automation',
  'robotic process automation': 'robotic-process-automation',
  'blockchain': 'blockchain-technology',
  'dlt': 'distributed-ledger-technology',
  'distributed ledger': 'distributed-ledger-technology',
  'nft': 'non-fungible-tokens',
  'nfts': 'non-fungible-tokens',
  'non-fungible token': 'non-fungible-tokens',
  'defi': 'decentralized-finance',
  'decentralized finance': 'decentralized-finance',
  'fintech': 'financial-technology',
  'financial technology': 'financial-technology',
  'healthtech': 'healthcare-technology',
  'health tech': 'healthcare-technology',
  'edtech': 'education-technology',
  'ed tech': 'education-technology',
  'education technology': 'education-technology',
  'proptech': 'property-technology',
  'prop tech': 'property-technology',
  'property technology': 'property-technology',
  'agtech': 'agricultural-technology',
  'ag tech': 'agricultural-technology',
  'agricultural technology': 'agricultural-technology',
  'cleantech': 'clean-technology',
  'clean tech': 'clean-technology',
  'clean technology': 'clean-technology',
  'greentech': 'green-technology',
  'green tech': 'green-technology',
  'green technology': 'green-technology',
  'ev': 'electric-vehicles',
  'evs': 'electric-vehicles',
  'electric vehicle': 'electric-vehicles',
  'electric vehicles': 'electric-vehicles',
  '5g': 'fifth-generation-wireless',
  '6g': 'sixth-generation-wireless',
  'quantum': 'quantum-computing',
  'quantum computing': 'quantum-computing',
  'edge computing': 'edge-computing',
  'cloud computing': 'cloud-computing',
  'cybersecurity': 'cyber-security',
  'cyber security': 'cyber-security',
  'infosec': 'information-security',
  'information security': 'information-security',
};

/**
 * Mapping from slugs to canonical display names.
 * Used for generating proper title case names.
 */
export const CANONICAL_NAMES: Record<string, string> = {
  'artificial-intelligence': 'Artificial Intelligence',
  'machine-learning': 'Machine Learning',
  'deep-learning': 'Deep Learning',
  'natural-language-processing': 'Natural Language Processing',
  'computer-vision': 'Computer Vision',
  'internet-of-things': 'Internet of Things',
  'augmented-reality': 'Augmented Reality',
  'virtual-reality': 'Virtual Reality',
  'extended-reality': 'Extended Reality',
  'mixed-reality': 'Mixed Reality',
  'large-language-models': 'Large Language Models',
  'generative-ai': 'Generative AI',
  'software-as-a-service': 'Software as a Service',
  'platform-as-a-service': 'Platform as a Service',
  'infrastructure-as-a-service': 'Infrastructure as a Service',
  'application-programming-interface': 'API',
  'user-interface': 'User Interface',
  'user-experience': 'User Experience',
  'user-interface-design': 'UI/UX Design',
  'research-and-development': 'Research & Development',
  'business-intelligence': 'Business Intelligence',
  'electronic-commerce': 'E-Commerce',
  'business-to-business': 'Business to Business',
  'business-to-consumer': 'Business to Consumer',
  'development-operations': 'DevOps',
  'machine-learning-operations': 'MLOps',
  'data-operations': 'DataOps',
  'enterprise-resource-planning': 'Enterprise Resource Planning',
  'customer-relationship-management': 'Customer Relationship Management',
  'supply-chain-management': 'Supply Chain Management',
  'robotic-process-automation': 'Robotic Process Automation',
  'blockchain-technology': 'Blockchain',
  'distributed-ledger-technology': 'Distributed Ledger Technology',
  'non-fungible-tokens': 'Non-Fungible Tokens',
  'decentralized-finance': 'Decentralized Finance',
  'financial-technology': 'FinTech',
  'healthcare-technology': 'HealthTech',
  'education-technology': 'EdTech',
  'property-technology': 'PropTech',
  'agricultural-technology': 'AgTech',
  'clean-technology': 'CleanTech',
  'green-technology': 'GreenTech',
  'electric-vehicles': 'Electric Vehicles',
  'fifth-generation-wireless': '5G',
  'sixth-generation-wireless': '6G',
  'quantum-computing': 'Quantum Computing',
  'edge-computing': 'Edge Computing',
  'cloud-computing': 'Cloud Computing',
  'cyber-security': 'Cybersecurity',
  'information-security': 'Information Security',
};

/**
 * Converts a string to a URL-safe slug.
 *
 * @param input - The string to slugify
 * @returns URL-safe slug (lowercase, hyphens instead of spaces, no special chars)
 *
 * @example
 * ```typescript
 * slugify('Hello World')
 * // Returns: 'hello-world'
 *
 * slugify('  AI & ML  ')
 * // Returns: 'ai-ml'
 *
 * slugify('Node.js')
 * // Returns: 'nodejs'
 * ```
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    // Replace & with 'and'
    .replace(/&/g, 'and')
    // Remove special characters except hyphens and spaces
    .replace(/[^\w\s-]/g, '')
    // Replace spaces and underscores with hyphens
    .replace(/[\s_]+/g, '-')
    // Remove consecutive hyphens
    .replace(/-+/g, '-')
    // Remove leading/trailing hyphens
    .replace(/^-+|-+$/g, '');
}

/**
 * Converts a string to title case.
 *
 * @param input - The string to convert
 * @returns Title cased string
 *
 * @example
 * ```typescript
 * titleCase('hello world')
 * // Returns: 'Hello World'
 *
 * titleCase('machine-learning')
 * // Returns: 'Machine Learning'
 * ```
 */
export function titleCase(input: string): string {
  return input
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Normalizes a concept/tag input to a canonical slug.
 *
 * First checks for known mappings (AI -> artificial-intelligence),
 * then falls back to slugifying the input.
 *
 * @param input - The concept/tag string to normalize
 * @returns Canonical slug
 *
 * @example
 * ```typescript
 * normalizeConcept('AI')
 * // Returns: 'artificial-intelligence'
 *
 * normalizeConcept('a.i.')
 * // Returns: 'artificial-intelligence'
 *
 * normalizeConcept('Custom Tag')
 * // Returns: 'custom-tag'
 * ```
 */
export function normalizeConcept(input: string): string {
  if (!input || typeof input !== 'string') {
    return '';
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return '';
  }

  const lower = trimmed.toLowerCase();

  // Check for known mapping
  if (CONCEPT_MAPPINGS[lower]) {
    return CONCEPT_MAPPINGS[lower];
  }

  // Fall back to slugifying
  return slugify(trimmed);
}

/**
 * Gets the canonical display name for a concept slug.
 *
 * First checks for known canonical names, then falls back to
 * title-casing the slug.
 *
 * @param slug - The concept slug
 * @returns Canonical display name
 *
 * @example
 * ```typescript
 * getCanonicalName('artificial-intelligence')
 * // Returns: 'Artificial Intelligence'
 *
 * getCanonicalName('custom-concept')
 * // Returns: 'Custom Concept'
 * ```
 */
export function getCanonicalName(slug: string): string {
  if (!slug || typeof slug !== 'string') {
    return '';
  }

  // Check for known canonical name
  if (CANONICAL_NAMES[slug]) {
    return CANONICAL_NAMES[slug];
  }

  // Fall back to title case
  return titleCase(slug);
}

/**
 * Normalizes a concept input and returns both slug and canonical name.
 *
 * @param input - The concept/tag string to normalize
 * @returns Object with slug and canonicalName
 *
 * @example
 * ```typescript
 * normalizeConceptFull('AI')
 * // Returns: { slug: 'artificial-intelligence', canonicalName: 'Artificial Intelligence' }
 *
 * normalizeConceptFull('Custom Tag')
 * // Returns: { slug: 'custom-tag', canonicalName: 'Custom Tag' }
 * ```
 */
export function normalizeConceptFull(input: string): { slug: string; canonicalName: string } {
  const slug = normalizeConcept(input);
  const canonicalName = getCanonicalName(slug);

  return { slug, canonicalName };
}

/**
 * Checks if two concept inputs normalize to the same slug.
 *
 * @param input1 - First concept/tag
 * @param input2 - Second concept/tag
 * @returns true if both normalize to the same slug
 *
 * @example
 * ```typescript
 * areConceptsEqual('AI', 'artificial intelligence')
 * // Returns: true
 *
 * areConceptsEqual('AI', 'ML')
 * // Returns: false
 * ```
 */
export function areConceptsEqual(input1: string, input2: string): boolean {
  return normalizeConcept(input1) === normalizeConcept(input2);
}

/**
 * Normalizes an array of concept/tag inputs, removing duplicates.
 *
 * @param inputs - Array of concept/tag strings
 * @returns Array of unique normalized concepts with their canonical names
 *
 * @example
 * ```typescript
 * normalizeConceptArray(['AI', 'ai', 'Machine Learning', 'ML'])
 * // Returns: [
 * //   { slug: 'artificial-intelligence', canonicalName: 'Artificial Intelligence', originalInputs: ['AI', 'ai'] },
 * //   { slug: 'machine-learning', canonicalName: 'Machine Learning', originalInputs: ['Machine Learning', 'ML'] }
 * // ]
 * ```
 */
export function normalizeConceptArray(
  inputs: string[]
): Array<{ slug: string; canonicalName: string; originalInputs: string[] }> {
  const conceptMap = new Map<string, string[]>();

  for (const input of inputs) {
    if (!input || typeof input !== 'string') continue;

    const trimmed = input.trim();
    if (!trimmed) continue;

    const slug = normalizeConcept(trimmed);
    if (!slug) continue;

    const existing = conceptMap.get(slug) || [];
    if (!existing.includes(trimmed)) {
      existing.push(trimmed);
    }
    conceptMap.set(slug, existing);
  }

  return Array.from(conceptMap.entries()).map(([slug, originalInputs]) => ({
    slug,
    canonicalName: getCanonicalName(slug),
    originalInputs,
  }));
}
