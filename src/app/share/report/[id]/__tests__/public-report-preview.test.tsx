/** @jest-environment jsdom */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { PublicReportPreview } from '../public-report-preview';

describe('PublicReportPreview', () => {
  beforeEach(() => {
    global.fetch = jest.fn(() => new Promise(() => {}));
  });

  it('renders sanitized report content while optional brand CSS is pending', async () => {
    render(<PublicReportPreview html="<h1>Shared evidence report</h1>" title="Shared report" />);

    const iframe = await screen.findByTitle('Shared report');
    await waitFor(() =>
      expect(iframe).toHaveAttribute('srcdoc', expect.stringContaining('<h1>Shared evidence report</h1>'))
    );
    expect(screen.queryByLabelText('Loading shared report')).not.toBeInTheDocument();
  });
});
