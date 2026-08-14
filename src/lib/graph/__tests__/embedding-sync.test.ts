/**
 * @file embedding-sync.test.ts
 * @description Unit tests for embedEntity helper.
 */

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runWriteTransaction: jest.fn(),
  runReadTransaction: jest.fn(),
}));

jest.mock('@/lib/ai/client', () => ({
  generateEmbedding: jest.fn(),
}));

jest.mock('@/lib/ai/constants', () => ({
  TaskType: { RETRIEVAL_DOCUMENT: 'RETRIEVAL_DOCUMENT' },
}));

import * as neo4jClient from '../neo4j-client';
import * as aiClient from '@/lib/ai/client';
import { embedEntity, scheduleEntityEmbed } from '../embedding-sync';

const mockedWrite = neo4jClient.runWriteTransaction as jest.Mock;
const mockedEmbed = aiClient.generateEmbedding as jest.Mock;

describe('embedEntity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedWrite.mockResolvedValue({ records: [{ id: 'tech-1' }] });
  });

  it('skips unsupported labels without calling Gemini', async () => {
    const result = await embedEntity({
      entityId: 'uc-1',
      label: 'UseCase' as 'Technology',
      name: 'Test',
      description: 'a'.repeat(80),
    });
    expect(result).toEqual({ embedded: false, reason: 'unsupported-label' });
    expect(mockedEmbed).not.toHaveBeenCalled();
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it('skips when combined text is shorter than 50 characters', async () => {
    const result = await embedEntity({
      entityId: 'tech-1',
      label: 'Technology',
      name: 'Kubernetes',
      description: 'Short',
    });
    expect(result).toEqual({ embedded: false, reason: 'too-short' });
    expect(mockedEmbed).not.toHaveBeenCalled();
  });

  it('embeds supported labels with sufficient text and writes to Neo4j', async () => {
    mockedEmbed.mockResolvedValue(new Array(768).fill(0.01));
    const result = await embedEntity({
      entityId: 'tech-1',
      label: 'Technology',
      name: 'Kubernetes',
      description:
        'Container orchestration platform for automating deployment, scaling, and management of containerized applications.',
    });
    expect(result).toEqual({ embedded: true, dimensions: 768 });

    expect(mockedEmbed).toHaveBeenCalledTimes(1);
    const [text] = mockedEmbed.mock.calls[0];
    expect(text).toContain('Kubernetes');
    expect(text).toContain('Container orchestration');

    expect(mockedWrite).toHaveBeenCalledTimes(1);
    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('MATCH (n:Technology');
    expect(cypher).toContain('SET n.embedding = $embedding');
    expect(params.entityId).toBe('tech-1');
    expect(params.embedding).toHaveLength(768);
  });

  it('routes Company label to company_embedding-bearing nodes', async () => {
    mockedEmbed.mockResolvedValue(new Array(768).fill(0.01));
    await embedEntity({
      entityId: 'company-1',
      label: 'Company',
      name: 'OpenAI',
      description: 'Artificial intelligence research lab with a mission to ensure AGI benefits all of humanity.',
    });
    const [cypher] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('MATCH (n:Company');
  });

  it('refuses to persist an empty embedding vector (H8 guard)', async () => {
    mockedEmbed.mockResolvedValue([]);
    const result = await embedEntity({
      entityId: 'tech-1',
      label: 'Technology',
      name: 'Kubernetes',
      description: 'Container orchestration platform for deploying and managing containers at scale.',
    });
    expect(result).toEqual({ embedded: false, reason: 'empty-vector' });
    // Never write [] to Neo4j — it would overwrite a previously-good vector.
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it('refuses to persist a non-array embedding result (H8 guard)', async () => {
    mockedEmbed.mockResolvedValue(undefined);
    const result = await embedEntity({
      entityId: 'tech-1',
      label: 'Technology',
      name: 'Kubernetes',
      description: 'Container orchestration platform for deploying and managing containers at scale.',
    });
    expect(result).toEqual({ embedded: false, reason: 'empty-vector' });
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it('returns embed-failed when Gemini throws', async () => {
    mockedEmbed.mockRejectedValue(new Error('rate limited'));
    const result = await embedEntity({
      entityId: 'tech-1',
      label: 'Technology',
      name: 'Kubernetes',
      description: 'Container orchestration platform for deploying and managing containers at scale.',
    });
    expect(result).toEqual({ embedded: false, reason: 'embed-failed' });
    expect(mockedWrite).not.toHaveBeenCalled();
  });
});

describe('scheduleEntityEmbed (P5-C incremental wire)', () => {
  const VALID_INPUT = {
    entityId: 'tech-1',
    label: 'Technology' as const,
    name: 'Kubernetes',
    description: 'Container orchestration platform for deploying and managing containers at scale.',
  };

  const savedGoogleKey = process.env.GOOGLE_API_KEY;
  const savedGeminiKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedWrite.mockResolvedValue({ records: [{ id: 'tech-1' }] });
    mockedEmbed.mockResolvedValue(new Array(768).fill(0.01));
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  afterAll(() => {
    if (savedGoogleKey !== undefined) process.env.GOOGLE_API_KEY = savedGoogleKey;
    else delete process.env.GOOGLE_API_KEY;
    if (savedGeminiKey !== undefined) process.env.GEMINI_API_KEY = savedGeminiKey;
    else delete process.env.GEMINI_API_KEY;
  });

  it('skips without calling Gemini when no API key is configured', async () => {
    const result = await scheduleEntityEmbed(VALID_INPUT);

    expect(result).toEqual({ embedded: false, reason: 'no-api-key' });
    expect(mockedEmbed).not.toHaveBeenCalled();
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it('treats placeholder scaffold keys as missing', async () => {
    process.env.GOOGLE_API_KEY = 'your-google-genai-api-key';

    const result = await scheduleEntityEmbed(VALID_INPUT);

    expect(result).toEqual({ embedded: false, reason: 'no-api-key' });
    expect(mockedEmbed).not.toHaveBeenCalled();
  });

  it('embeds when a real GEMINI_API_KEY is present', async () => {
    process.env.GEMINI_API_KEY = 'real-key-123';

    const result = await scheduleEntityEmbed(VALID_INPUT);

    expect(result).toEqual({ embedded: true, dimensions: 768 });
    expect(mockedEmbed).toHaveBeenCalledTimes(1);
    expect(mockedWrite).toHaveBeenCalledTimes(1);
  });

  it('never rejects — infra errors resolve to a sync-error result (fire-and-forget safe)', async () => {
    process.env.GEMINI_API_KEY = 'real-key-123';
    mockedWrite.mockRejectedValue(new Error('neo4j down'));

    await expect(scheduleEntityEmbed(VALID_INPUT)).resolves.toEqual({ embedded: false, reason: 'sync-error' });
  });
});
