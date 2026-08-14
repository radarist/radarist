/**
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock(
  'lucide-react',
  () =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />;
          Icon.displayName = String(prop);
          return Icon;
        },
      }
    )
);

const mockToast = jest.fn();
jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: jest.fn() }),
}));

import { CompanySWOTAnalysis } from '@/components/scouting/CompanySWOTAnalysis';

describe('CompanySWOTAnalysis persistence ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates the write and labels a committed-but-unacknowledged handoff truthfully', async () => {
    const user = userEvent.setup();
    const onSave = jest.fn().mockResolvedValue('saved-locally');
    render(<CompanySWOTAnalysis onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'Save Analysis' }));

    expect(onSave).toHaveBeenCalledWith({
      strengths: [],
      weaknesses: [],
      opportunities: [],
      threats: [],
    });
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'SWOT saved locally' }));
  });
});
