/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryTemplates } from '../QueryTemplates';

jest.mock('lucide-react', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    Building2: Icon,
    ChevronDown: Icon,
    Circle: Icon,
    Cpu: Icon,
    FileText: Icon,
    GitFork: Icon,
    LayoutTemplate: Icon,
    Lightbulb: Icon,
    Link2: Icon,
    Route: Icon,
    TrendingUp: Icon,
    Users: Icon,
  };
});

beforeAll(() => {
  Element.prototype.hasPointerCapture = jest.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = jest.fn();
  Element.prototype.releasePointerCapture = jest.fn();
  Element.prototype.scrollIntoView = jest.fn();
});

describe('QueryTemplates', () => {
  it('keeps the complete template list scrollable inside the available viewport', async () => {
    const user = userEvent.setup();
    render(<QueryTemplates onSelect={jest.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Templates' }));

    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass(
      'max-h-[var(--radix-dropdown-menu-content-available-height)]',
      'overflow-y-auto',
      'overscroll-contain'
    );
    expect(screen.getByRole('menuitem', { name: /Documents/ })).toBeInTheDocument();
  });
});
