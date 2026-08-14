/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { VisualizationMedia } from '../VisualizationMedia';

jest.mock('lucide-react', () => ({
  ImageOff: () => <span data-testid="image-off-icon" />,
  RotateCcw: () => <span data-testid="retry-icon" />,
}));

describe('VisualizationMedia', () => {
  it('renders healthy media at its persisted dimensions', () => {
    render(
      <VisualizationMedia
        src="https://storage.example.test/visualization.png"
        alt="Architecture map"
        width={1600}
        height={900}
        variant="detail"
        testId="media"
      />
    );

    const image = screen.getByTestId('media');
    expect(image).toHaveAttribute('width', '1600');
    expect(image).toHaveAttribute('height', '900');

    fireEvent.load(image);

    expect(screen.getByTestId('media')).toHaveAttribute('data-media-status', 'available');
    expect(screen.queryByText('Media unavailable')).not.toBeInTheDocument();
  });

  it('replaces an unreadable or missing object with an explicit placeholder, never a broken image', () => {
    render(
      <VisualizationMedia
        src="https://storage.example.test/missing.png"
        alt="Missing chart"
        variant="public"
        testId="media"
      />
    );

    fireEvent.error(screen.getByTestId('media'));

    expect(screen.queryByTestId('media')).not.toBeInTheDocument();
    expect(screen.getByText('Media unavailable')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Missing chart: media unavailable' })).toBeInTheDocument();
  });

  it('lets the owner retry a transient Storage failure and recover', async () => {
    const user = userEvent.setup();
    render(
      <VisualizationMedia
        src="https://storage.example.test/temporarily-unavailable.png"
        alt="Owner chart"
        variant="detail"
        retryable
        testId="media"
      />
    );

    fireEvent.error(screen.getByTestId('media'));
    await user.click(screen.getByRole('button', { name: 'Retry media' }));
    fireEvent.load(screen.getByTestId('media'));

    expect(screen.getByTestId('media')).toHaveAttribute('data-media-status', 'available');
    expect(screen.queryByText('Media unavailable')).not.toBeInTheDocument();
  });

  it('bounds repeated retries and does not retry automatically', async () => {
    const user = userEvent.setup();
    render(
      <VisualizationMedia
        src="https://storage.example.test/outage.png"
        alt="Owner chart"
        variant="detail"
        retryable
        testId="media"
      />
    );

    fireEvent.error(screen.getByTestId('media'));
    await user.click(screen.getByRole('button', { name: 'Retry media' }));
    fireEvent.error(screen.getByTestId('media'));
    await user.click(screen.getByRole('button', { name: 'Retry media' }));
    fireEvent.error(screen.getByTestId('media'));

    expect(screen.getByText('Media unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry media' })).not.toBeInTheDocument();
  });
});
