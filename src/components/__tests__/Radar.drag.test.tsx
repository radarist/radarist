import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { QuadrantConfig, RadarEntry } from '@/lib/types';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver;

jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const IconComponent = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />;
        IconComponent.displayName = prop;
        return IconComponent;
      },
    }
  );
});

jest.mock('html-to-image', () => ({
  __esModule: true,
  toPng: jest.fn(async () => 'data:image/png;base64,stub'),
}));

jest.mock('react-zoom-pan-pinch', () => {
  const controls = { zoomIn: jest.fn(), zoomOut: jest.fn(), resetTransform: jest.fn() };
  const TransformWrapper = ({
    children,
  }: {
    children: React.ReactNode | ((value: typeof controls) => React.ReactNode);
  }) => <div>{typeof children === 'function' ? children(controls) : children}</div>;
  const TransformComponent = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { __esModule: true, TransformWrapper, TransformComponent };
});

import { Radar } from '../Radar';

const quadrants: QuadrantConfig[] = [{ id: 'q-tools', name: 'Tools', order: 0 }];
const entry: RadarEntry = {
  id: 7,
  name: 'Captured pointer technology',
  description: 'Deterministic drag fixture',
  quadrantId: 'q-tools',
  quadrantName: 'Tools',
  ring: 'Adopt',
  tags: [],
  status: 'Stable',
  costToPrototype: 1,
};

function renderRadar({
  readOnly = false,
  onEntryClick = jest.fn(),
  onEntryDragEnd = jest.fn(),
}: {
  readOnly?: boolean;
  onEntryClick?: jest.Mock;
  onEntryDragEnd?: jest.Mock;
} = {}) {
  const view = render(
    <Radar
      entries={[entry]}
      quadrants={quadrants}
      rings={['Adopt', 'Trial', 'Assess', 'Hold']}
      ringSystem="Standard"
      onRingSystemChange={jest.fn()}
      hoveredEntryId={null}
      onEntryHover={jest.fn()}
      onEntryClick={onEntryClick}
      onEntryDragEnd={onEntryDragEnd}
      readOnly={readOnly}
      hideRingSystemSelector
    />
  );

  const canvas = screen.getByTestId('radar-canvas');
  jest.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    x: 100,
    y: 100,
    left: 100,
    top: 100,
    right: 300,
    bottom: 300,
    width: 200,
    height: 200,
    toJSON: () => ({}),
  });

  return {
    ...view,
    blip: screen.getByRole('button', { name: entry.name }),
    canvas,
    onEntryClick,
    onEntryDragEnd,
  };
}

function enterEditMode(blip: HTMLElement): void {
  fireEvent.contextMenu(blip, { button: 2 });
  expect(blip).toHaveAttribute('aria-pressed', 'true');
}

describe('Radar blip mouse dragging', () => {
  it('captures movement outside, clamps the release, and persists exactly once', () => {
    const { blip, onEntryClick, onEntryDragEnd } = renderRadar();

    enterEditMode(blip);
    fireEvent.mouseDown(blip, { button: 0, clientX: 150, clientY: 150 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 250, clientY: 250 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 350, clientY: 50 });
    fireEvent.mouseUp(window, { button: 0, clientX: 350, clientY: 50 });
    fireEvent.mouseUp(window, { button: 0, clientX: 350, clientY: 50 });

    expect(onEntryDragEnd).toHaveBeenCalledTimes(1);
    expect(onEntryDragEnd).toHaveBeenCalledWith(entry.id, { x: 100, y: 0 });
    expect(blip).toHaveStyle({ left: '100%', top: '0%' });
    expect(blip).toHaveAttribute('aria-pressed', 'true');

    // Suppress only the click synthesized for the completed drag. A later
    // intentional click must still select/open the edited entry.
    fireEvent.click(blip);
    expect(onEntryClick).not.toHaveBeenCalled();
    fireEvent.click(blip);
    expect(onEntryClick).toHaveBeenCalledTimes(1);
  });

  it('does not save or suppress a click when the pointer never really moved', () => {
    const { blip, onEntryClick, onEntryDragEnd } = renderRadar();

    enterEditMode(blip);
    expect(fireEvent.mouseDown(blip, { button: 0, clientX: 150, clientY: 150 })).toBe(true);
    fireEvent.mouseMove(window, { buttons: 1, clientX: 150, clientY: 150 });
    fireEvent.mouseUp(window, { button: 0, clientX: 150, clientY: 150 });
    fireEvent.click(blip);

    expect(onEntryDragEnd).not.toHaveBeenCalled();
    expect(onEntryClick).toHaveBeenCalledTimes(1);
    expect(blip).toHaveAttribute('aria-pressed', 'true');
  });

  it('cancels on window blur without writing and restores the visual position', () => {
    const { blip, onEntryClick, onEntryDragEnd } = renderRadar();
    const startingPosition = { left: blip.style.left, top: blip.style.top };

    enterEditMode(blip);
    fireEvent.mouseDown(blip, { button: 0, clientX: 150, clientY: 150 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 350, clientY: 50 });
    expect(blip).toHaveStyle({ left: '100%', top: '0%' });

    fireEvent.blur(window);
    fireEvent.mouseUp(window, { button: 0, clientX: 350, clientY: 50 });

    expect(onEntryDragEnd).not.toHaveBeenCalled();
    expect(blip.style.left).toBe(startingPosition.left);
    expect(blip.style.top).toBe(startingPosition.top);
    expect(blip).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(blip);
    expect(onEntryClick).toHaveBeenCalledTimes(1);
  });

  it('preserves read-only selection behavior while refusing to arm a drag', () => {
    const { blip, onEntryClick, onEntryDragEnd } = renderRadar({ readOnly: true });

    fireEvent.contextMenu(blip, { button: 2 });
    fireEvent.mouseDown(blip, { button: 0, clientX: 150, clientY: 150 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 350, clientY: 50 });
    fireEvent.mouseUp(window, { button: 0, clientX: 350, clientY: 50 });
    fireEvent.click(blip);

    expect(blip).toHaveAttribute('aria-pressed', 'false');
    expect(onEntryDragEnd).not.toHaveBeenCalled();
    expect(onEntryClick).toHaveBeenCalledTimes(1);
  });

  it('removes its global capture listeners on unmount', () => {
    const addEventListener = jest.spyOn(window, 'addEventListener');
    const removeEventListener = jest.spyOn(window, 'removeEventListener');
    const { blip, onEntryDragEnd, unmount } = renderRadar();

    expect(addEventListener).not.toHaveBeenCalledWith('mousemove', expect.any(Function), true);
    enterEditMode(blip);
    fireEvent.mouseDown(blip, { button: 0, clientX: 150, clientY: 150 });
    expect(addEventListener).toHaveBeenCalledWith('mousemove', expect.any(Function), true);
    expect(addEventListener).toHaveBeenCalledWith('mouseup', expect.any(Function), true);
    expect(addEventListener).toHaveBeenCalledWith('blur', expect.any(Function), true);
    unmount();
    fireEvent.mouseMove(window, { buttons: 1, clientX: 350, clientY: 50 });
    fireEvent.mouseUp(window, { button: 0, clientX: 350, clientY: 50 });

    expect(onEntryDragEnd).not.toHaveBeenCalled();
    expect(removeEventListener).toHaveBeenCalledWith('mousemove', expect.any(Function), true);
    expect(removeEventListener).toHaveBeenCalledWith('mouseup', expect.any(Function), true);
    expect(removeEventListener).toHaveBeenCalledWith('blur', expect.any(Function), true);
    addEventListener.mockRestore();
    removeEventListener.mockRestore();
  });
});
