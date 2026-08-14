/**
 * SETTINGS-003 — persisted-vs-effective signal-source state and the supported
 * defaults used by the guarded reset. Pure logic, no mocks.
 */
import {
  SIGNAL_SOURCE_AVAILABILITY,
  computeEffectiveSourceStates,
  hasEnabledUnavailableSources,
  listEnabledUnavailableSources,
  supportedDefaultSources,
  type SignalSourceKey,
} from '../signal-source-availability';
import { DEFAULT_SIGNAL_SOURCES } from '../signal-source-defaults';

describe('SIGNAL_SOURCE_AVAILABILITY', () => {
  it('covers exactly the eight canonical sources', () => {
    expect(Object.keys(SIGNAL_SOURCE_AVAILABILITY).sort()).toEqual(Object.keys(DEFAULT_SIGNAL_SOURCES).sort());
  });

  it('marks patents, funding, and trends unavailable with an actionable reason', () => {
    for (const source of ['patents', 'funding', 'trends'] as SignalSourceKey[]) {
      expect(SIGNAL_SOURCE_AVAILABILITY[source].available).toBe(false);
      expect(SIGNAL_SOURCE_AVAILABILITY[source].reason.length).toBeGreaterThan(0);
    }
  });

  it('marks the working keyless sources available', () => {
    for (const source of ['papers', 'news', 'github', 'hackernews', 'sec'] as SignalSourceKey[]) {
      expect(SIGNAL_SOURCE_AVAILABILITY[source].available).toBe(true);
    }
  });
});

describe('computeEffectiveSourceStates', () => {
  it('distinguishes persisted from effective for an upgraded store that enabled unavailable sources', () => {
    // The exact hazard from the backlog: an old store left patents/funding/trends enabled.
    const states = computeEffectiveSourceStates({
      patents: true,
      papers: true,
      news: true,
      funding: true,
      github: true,
      trends: true,
      hackernews: true,
      sec: false,
    });
    const byKey = Object.fromEntries(states.map((s) => [s.source, s]));

    // Persisted true but not available → effective false, with a reason.
    expect(byKey.patents).toMatchObject({ persisted: true, available: false, effective: false });
    expect(byKey.patents.reason).toBeTruthy();
    expect(byKey.funding).toMatchObject({ persisted: true, available: false, effective: false });
    expect(byKey.trends).toMatchObject({ persisted: true, available: false, effective: false });

    // Persisted true and available → effective true, no reason.
    expect(byKey.github).toMatchObject({ persisted: true, available: true, effective: true });
    expect(byKey.github.reason).toBeUndefined();

    // Persisted false and available → effective false, no reason.
    expect(byKey.sec).toMatchObject({ persisted: false, available: true, effective: false });
  });

  it('falls back to the supported defaults for sources missing from an older persisted doc', () => {
    // A doc that predates hackernews/sec: those keys are absent.
    const states = computeEffectiveSourceStates({
      patents: false,
      papers: true,
      news: true,
      funding: false,
      github: true,
      trends: false,
    });
    const byKey = Object.fromEntries(states.map((s) => [s.source, s]));
    expect(byKey.hackernews.persisted).toBe(DEFAULT_SIGNAL_SOURCES.hackernews); // true default
    expect(byKey.sec.persisted).toBe(DEFAULT_SIGNAL_SOURCES.sec); // false default
  });

  it('treats an undefined persisted map as the supported defaults', () => {
    const states = computeEffectiveSourceStates(undefined);
    const byKey = Object.fromEntries(states.map((s) => [s.source, s]));
    expect(byKey.papers.effective).toBe(true);
    expect(byKey.patents.effective).toBe(false);
  });
});

describe('listEnabledUnavailableSources / hasEnabledUnavailableSources', () => {
  it('lists exactly the sources that are enabled but cannot produce signals', () => {
    const persisted = { patents: true, funding: true, trends: false, papers: true, news: true, github: true };
    expect(listEnabledUnavailableSources(persisted).sort()).toEqual(['funding', 'patents']);
    expect(hasEnabledUnavailableSources(persisted)).toBe(true);
  });

  it('is empty when only available sources are enabled', () => {
    const persisted = { ...DEFAULT_SIGNAL_SOURCES };
    expect(listEnabledUnavailableSources(persisted)).toEqual([]);
    expect(hasEnabledUnavailableSources(persisted)).toBe(false);
  });
});

describe('supportedDefaultSources (guarded-reset target)', () => {
  it('returns the canonical defaults', () => {
    expect(supportedDefaultSources()).toEqual({ ...DEFAULT_SIGNAL_SOURCES });
  });

  it('is idempotent and disables every unavailable source', () => {
    const once = supportedDefaultSources();
    const twice = supportedDefaultSources();
    expect(once).toEqual(twice);
    expect(hasEnabledUnavailableSources(once)).toBe(false);
    expect(once.patents).toBe(false);
    expect(once.funding).toBe(false);
    expect(once.trends).toBe(false);
  });

  it('returns a fresh object each call (no shared mutable default)', () => {
    const a = supportedDefaultSources();
    a.patents = true;
    expect(supportedDefaultSources().patents).toBe(false);
  });
});
