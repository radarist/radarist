import { partitionAwareReporters } from '../lib/e2e-partition-reporter';

describe('partition-aware Playwright reporter', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('leaves the normal lane reporter unchanged', () => {
    delete process.env.E2E_PARTITION_RAW_DIR;
    expect(partitionAwareReporters('generic', [['html']])).toEqual([['html']]);
  });

  it('adds a unique phase-bound JSON sidecar for the owned orchestrator', () => {
    process.env.E2E_PARTITION_RAW_DIR = '/tmp/partition-reports';
    process.env.E2E_PARTITION_PHASE = '@phase/research';

    expect(partitionAwareReporters('organic-first-value', [['line']])).toEqual([
      ['line'],
      [
        'json',
        {
          outputFile: expect.stringMatching(
            /^\/tmp\/partition-reports\/organic-first-value-phase-research-\d+\.json$/
          ),
        },
      ],
    ]);
  });
});
