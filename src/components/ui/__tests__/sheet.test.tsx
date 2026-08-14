/**
 * @file ui/__tests__/sheet.test.tsx
 * @description UX-055 — the non-modal Sheet option must render no full-viewport
 * overlay so a docked/floating panel cannot lock `document.body` or intercept
 * page controls outside its bounds. The historic modal default is preserved for
 * every other caller.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';

// lucide-react ships ESM that Jest cannot parse out of the box.
jest.mock('lucide-react', () => ({
  X: () => <svg data-testid="icon-X" />,
}));

import { Sheet, SheetContent, SheetTitle, SheetDescription } from '../sheet';

describe('SheetContent modal gating (UX-055)', () => {
  // Radix Dialog gives BOTH the overlay and the content a `data-state` attribute
  // when open. Counting them distinguishes "overlay + content" (modal) from
  // "content only" (non-modal) without coupling to overlay class names.
  function openStateCount(): number {
    return document.body.querySelectorAll('[data-state="open"]').length;
  }

  it('renders the overlay by default (modal behaviour every other caller relies on)', () => {
    render(
      <Sheet open>
        <SheetContent side="right">
          <SheetTitle>Panel</SheetTitle>
          <SheetDescription>desc</SheetDescription>
        </SheetContent>
      </Sheet>,
    );

    // overlay + content
    expect(openStateCount()).toBe(2);
  });

  it('renders NO overlay when modal={false}, so the page stays interactive', () => {
    render(
      <Sheet open modal={false}>
        <SheetContent side="right" modal={false}>
          <SheetTitle>Panel</SheetTitle>
          <SheetDescription>desc</SheetDescription>
        </SheetContent>
      </Sheet>,
    );

    // content only — the full-viewport overlay is absent.
    expect(openStateCount()).toBe(1);
    // The content itself is still present.
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
