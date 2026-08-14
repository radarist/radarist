/**
 * P2 (design-pass conception) — DesignBrief resolution + the back-compat
 * tripwire: missionSchema must keep parsing missions that have NO designBrief
 * (every existing Firestore doc), and accept one when present.
 */
import { resolveDesignBrief, designBriefSchema } from '@/lib/schemas/design-brief';
import { missionSchema } from '@/lib/schemas/mission';

const validMission = () => ({
  id: 'mission-1',
  userId: 'u1',
  prompt: 'p',
  agent: 'creator',
  status: 'pending' as const,
  progress: 0,
  entities: [],
  sources: [],
  createdAt: '2026-06-08T00:00:00.000Z',
});

describe('resolveDesignBrief (P2 conception)', () => {
  it('defaults to brand-dark with the brand-exact sequence + source=auto when no partial', () => {
    const b = resolveDesignBrief('u1');
    expect(b.theme).toBe('brand-dark');
    expect(b.source).toBe('auto');
    expect(b.visualAmbition).toBe('standard');
    expect(b.palette.bg).toBe('#0a0c10');
    expect(b.palette.accent).toBe('#d4a84b');
    // brand-exact: the brand gold leads the chart sequence
    expect(b.palette.sequence[0]).toBe('#d4a84b');
    expect(designBriefSchema.safeParse(b).success).toBe(true);
  });

  it('honors rich-executive ambition and defaults an older persisted brief', () => {
    expect(resolveDesignBrief('u1', { visualAmbition: 'rich-executive' }).visualAmbition).toBe('rich-executive');
    const { visualAmbition: _removed, ...legacyBrief } = resolveDesignBrief('u1');
    expect(designBriefSchema.parse(legacyBrief).visualAmbition).toBe('standard');
  });

  it('honors a partial theme and marks source=user', () => {
    const b = resolveDesignBrief('u1', { theme: 'brand-light' });
    expect(b.theme).toBe('brand-light');
    expect(b.source).toBe('user');
    expect(b.palette.bg).not.toBe('#0a0c10'); // light background
    // brand accents are preserved across themes (brand-exact)
    expect(b.palette.sequence).toContain('#d4a84b');
  });

  it('lets an explicit palette override win', () => {
    const b = resolveDesignBrief('u1', { palette: { accent: '#4a9eff' } });
    expect(b.palette.accent).toBe('#4a9eff');
    expect(b.source).toBe('user');
    // unset palette fields still come from the base
    expect(b.palette.bg).toBe('#0a0c10');
  });
});

describe('missionSchema designBrief back-compat (P2 tripwire — must hold before/after the field lands)', () => {
  it('parses a mission with NO designBrief (existing Firestore docs)', () => {
    const m = missionSchema.parse(validMission());
    expect(m.designBrief).toBeUndefined();
  });

  it('parses a mission WITH a designBrief', () => {
    const m = missionSchema.parse({ ...validMission(), designBrief: resolveDesignBrief('u1') });
    expect(m.designBrief?.theme).toBe('brand-dark');
  });
});
