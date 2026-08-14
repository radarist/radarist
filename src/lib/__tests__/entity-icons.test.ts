// lucide-react ships ESM (jest doesn't transform it); per repo convention every
// test touching lucide mocks it. This Proxy returns each icon's export name as a
// stable stub, so we can assert the mapping by name. (Map *completeness* is already
// enforced at compile time by the `Record<EntityType, LucideIcon>` type.)
jest.mock(
  'lucide-react',
  () =>
    new Proxy({ __esModule: true } as Record<string, unknown>, {
      get: (target, prop) => (typeof prop === 'string' && !(prop in target) ? prop : target[prop as string]),
    })
);

import { ENTITY_ICONS, entityIcon } from '../entity-icons';
import { Radio } from 'lucide-react';
import type { EntityType } from '@/lib/types';

const ALL_TYPES: EntityType[] = [
  'technology',
  'company',
  'useCase',
  'strategy',
  'prototype',
  'signal',
  'document',
  'orgUnit',
  'initiative',
  'painPoint',
  'radarPlacement',
];

describe('entity-icons (canonical single source)', () => {
  it('defines a glyph for every EntityType', () => {
    for (const t of ALL_TYPES) {
      expect(ENTITY_ICONS[t]).toBeDefined();
      expect(entityIcon(t)).toBeTruthy();
    }
  });

  it('uses the canonical Radio glyph for signal (resolving the Radio-vs-Target drift)', () => {
    expect(ENTITY_ICONS.signal).toBe(Radio);
  });
});
