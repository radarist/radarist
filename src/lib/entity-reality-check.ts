import { executeWebSearch } from '@/lib/ai/tools/web-research';
import { analyzeEntityReality, type RealityVerdict } from './entity-reality-analyzer';
import { createLogger } from './logger';

const log = createLogger('entity-reality-check');
const DEFAULT_RESULT_LIMIT = 3;

export async function verifyEntityReality(name: string): Promise<RealityVerdict> {
  try {
    const response = await executeWebSearch(name, DEFAULT_RESULT_LIMIT);
    const summary = response.data?.summary ?? '';
    const searchFailed = response.data?.searchFailed === true;
    return analyzeEntityReality(name, { summary, searchFailed });
  } catch (err) {
    log.warn('Reality check search threw — passing inconclusively', {
      name,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: true, reason: 'inconclusive', evidenceText: '' };
  }
}
