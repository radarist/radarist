/**
 * AI-028 — the interactive AI research panel must tell the truth: it produces an
 * unverified DRAFT (never a "complete" / "successfully analyzed" result), it tells
 * the operator to review the generated fields and sources, it never presents the
 * unbounded size/stage/type/industry as accepted profile facts, and it preserves
 * the guard that keeps those unbounded values out of the persisted update.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockToast = jest.fn();
const mockResearchCompanyAction = jest.fn();

jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));
jest.mock('@/app/actions', () => ({
  researchCompanyAction: (...args: unknown[]) => mockResearchCompanyAction(...args),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));
jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

import { AICompanyResearch } from '@/components/scouting/AICompanyResearch';

const RESULT = {
  description: 'A cloud company.',
  industry: ['Cloud Computing'],
  type: ['Vendor'],
  size: 'Enterprise',
  stage: 'Public',
  location: { city: 'Berlin', country: 'Germany' },
  socialLinks: { linkedin: 'https://linkedin.example/acme' },
  contacts: [],
  documents: [],
  swot: { strengths: [], weaknesses: [], opportunities: [], threats: [] },
  tags: ['cloud'],
  technologyStack: ['Kubernetes'],
};

beforeEach(() => jest.clearAllMocks());

async function startResearch() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Start Research/i }));
  await screen.findByRole('button', { name: /Stage draft fields/i });
  return user;
}

describe('AICompanyResearch — draft truth', () => {
  it('reports a research DRAFT, never a completed/verified analysis', async () => {
    mockResearchCompanyAction.mockResolvedValue(RESULT);
    render(<AICompanyResearch company={{ name: 'Acme' }} onApply={jest.fn()} />);
    await startResearch();

    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/draft/i) }));
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Research Complete' }));
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringMatching(/successfully analyzed/i) })
    );
  });

  it('frames the results as an AI draft and marks size/stage/type/industry as not applied', async () => {
    mockResearchCompanyAction.mockResolvedValue(RESULT);
    render(<AICompanyResearch company={{ name: 'Acme' }} onApply={jest.fn()} />);
    await startResearch();

    expect(screen.getByText(/AI draft/i)).toBeInTheDocument();
    expect(screen.getByText(/not applied to your profile/i)).toBeInTheDocument();
    expect(screen.getByText(/does not include source receipts/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stage draft fields/i })).toBeInTheDocument();
  });

  it('applies only bounded fields — never size/stage/type/industry — with draft wording', async () => {
    mockResearchCompanyAction.mockResolvedValue(RESULT);
    const onApply = jest.fn();
    render(<AICompanyResearch company={{ name: 'Acme', tags: ['existing'] }} onApply={onApply} />);
    const user = await startResearch();

    await user.click(screen.getByRole('button', { name: /Stage draft fields/i }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const payload = onApply.mock.calls[0][0];
    expect(payload).toEqual(expect.objectContaining({ description: 'A cloud company.' }));
    expect(payload).not.toHaveProperty('size');
    expect(payload).not.toHaveProperty('stage');
    expect(payload).not.toHaveProperty('type');
    expect(payload).not.toHaveProperty('industry');

    // Truthful apply copy: it never claims the data was "applied to the company
    // profile" (it is staged for review), and it points at review.
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringMatching(/research data applied/i) })
    );
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringMatching(/review/i) }));
  });

  it('does not render or stage a non-http social URL from the model', async () => {
    mockResearchCompanyAction.mockResolvedValue({
      ...RESULT,
      socialLinks: { linkedin: 'javascript:alert(1)' },
    });
    const onApply = jest.fn();
    render(<AICompanyResearch company={{ name: 'Acme' }} onApply={onApply} />);
    const user = await startResearch();

    expect(screen.queryByRole('link', { name: /LinkedIn/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Stage draft fields/i }));
    expect(onApply.mock.calls[0][0].socialLinks.linkedin).toBeUndefined();
  });

  it('still surfaces a research failure honestly', async () => {
    mockResearchCompanyAction.mockResolvedValue(null);
    render(<AICompanyResearch company={{ name: 'Acme' }} onApply={jest.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Start Research/i }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Research Failed', variant: 'destructive' })
      )
    );
  });
});
