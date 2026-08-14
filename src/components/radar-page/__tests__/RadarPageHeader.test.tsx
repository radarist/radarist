/**
 * Component tests for RadarPageHeader (ARCH-008).
 *
 * Locks the extracted toolbar's behaviour: radar selection, the
 * `__create__`-is-an-action branch, the manage dropdown (create/rename/delete)
 * with its disabled rules, share/settings/add controls, labels and the
 * Add-entry accessible name — all preserved from the pre-extraction page.
 *
 * Uses the project default Jest environment (jest.environment.js), not a
 * per-file DOM environment docblock, and stubs lucide-react the same way every
 * other component test does (Jest's CJS transform cannot load lucide's ESM).
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// lucide-react ESM proxy stub — render every icon as a tagged span so selectors
// can find it by `data-testid="icon-<ExportName>"`.
jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) => (
      <span data-testid={`icon-${name}`} className={props.className as string} />
    );
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy({}, { get: (_target, prop: string) => makeIcon(prop) });
});

import { RadarPageHeader, type RadarPageHeaderProps } from '../RadarPageHeader';

// Radix UI (Select / DropdownMenu / Tooltip) touches these APIs, which jsdom
// does not implement. Polyfill them so open/close interactions work.
beforeAll(() => {
  Element.prototype.hasPointerCapture = jest.fn(() => false) as unknown as typeof Element.prototype.hasPointerCapture;
  Element.prototype.setPointerCapture = jest.fn() as unknown as typeof Element.prototype.setPointerCapture;
  Element.prototype.releasePointerCapture = jest.fn() as unknown as typeof Element.prototype.releasePointerCapture;
  Element.prototype.scrollIntoView = jest.fn() as unknown as typeof Element.prototype.scrollIntoView;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

function makeProps(overrides: Partial<RadarPageHeaderProps> = {}): RadarPageHeaderProps {
  return {
    radars: [
      { id: 'r1', name: 'Enterprise Radar' },
      { id: 'r2', name: 'Emerging Tech' },
    ],
    selectedRadarId: 'r1',
    onSelectRadar: jest.fn(),
    onCreateRadar: jest.fn(),
    onRenameRadar: jest.fn(),
    onDeleteRadar: jest.fn(),
    onShareRadar: jest.fn(),
    onOpenSettings: jest.fn(),
    onAddEntry: jest.fn(),
    ...overrides,
  };
}

function setup(overrides: Partial<RadarPageHeaderProps> = {}) {
  const props = makeProps(overrides);
  const user = userEvent.setup();
  const utils = render(<RadarPageHeader {...props} />);
  return { user, props, ...utils };
}

/** Locate an icon button by its (stubbed) lucide icon — used where a test
 * targets the icon identity itself rather than the accessible name. */
function iconButton(container: HTMLElement, iconName: string): HTMLButtonElement {
  const icon = container.querySelector(`[data-testid="icon-${iconName}"]`);
  const button = icon?.closest('button');
  if (!button) throw new Error(`icon button icon-${iconName} not found`);
  return button as HTMLButtonElement;
}

describe('RadarPageHeader — title', () => {
  it('renders the radar title and subtitle', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Tech Radar' })).toBeInTheDocument();
    expect(screen.getByText('Visualize adoption, maturity, and focus areas for key technologies.')).toBeInTheDocument();
  });
});

describe('RadarPageHeader — radar selector', () => {
  it('lists each radar and selects one via onSelectRadar', async () => {
    const { user, props } = setup();
    await user.click(screen.getByRole('combobox', { name: 'Select radar' }));
    await user.click(await screen.findByRole('option', { name: 'Emerging Tech' }));
    expect(props.onSelectRadar).toHaveBeenCalledWith('r2');
    expect(props.onCreateRadar).not.toHaveBeenCalled();
  });

  it('treats "+ Create New Radar" as an action, not a selection', async () => {
    const { user, props } = setup();
    await user.click(screen.getByRole('combobox', { name: 'Select radar' }));
    await user.click(await screen.findByRole('option', { name: '+ Create New Radar' }));
    expect(props.onCreateRadar).toHaveBeenCalledTimes(1);
    expect(props.onSelectRadar).not.toHaveBeenCalled();
  });
});

describe('RadarPageHeader — manage dropdown', () => {
  it('fires create from the dropdown', async () => {
    const { user, props } = setup();
    await user.click(screen.getAllByRole('button')[0]); // manage dropdown trigger
    await user.click(await screen.findByRole('menuitem', { name: /Create New Radar/i }));
    expect(props.onCreateRadar).toHaveBeenCalledTimes(1);
  });

  it('disables rename when no radar is selected', async () => {
    // Disabled state (aria-disabled) is what the extraction must preserve;
    // Radix's real-browser click-swallow (pointer-events:none) is not
    // reproducible in jsdom and is covered by the Playwright pass instead.
    const { user } = setup({ selectedRadarId: '' });
    await user.click(screen.getAllByRole('button')[0]); // manage dropdown trigger
    const rename = await screen.findByRole('menuitem', { name: /Rename Radar/i });
    expect(rename).toHaveAttribute('aria-disabled', 'true');
  });

  it('allows deleting the final radar (LOCAL-010: zero radars is a valid state)', async () => {
    const { user, props } = setup({ radars: [{ id: 'r1', name: 'Only Radar' }] });
    await user.click(screen.getAllByRole('button')[0]);
    const del = await screen.findByRole('menuitem', { name: /Delete Radar/i });
    expect(del).not.toHaveAttribute('aria-disabled', 'true');
    await user.click(del);
    expect(props.onDeleteRadar).toHaveBeenCalledTimes(1);
  });

  it('disables delete when no radar is selected', async () => {
    const { user } = setup({ selectedRadarId: '' });
    await user.click(screen.getAllByRole('button')[0]);
    const del = await screen.findByRole('menuitem', { name: /Delete Radar/i });
    expect(del).toHaveAttribute('aria-disabled', 'true');
  });

  it('fires rename when a radar is selected among several', async () => {
    const { user, props } = setup();
    await user.click(screen.getAllByRole('button')[0]);
    await user.click(await screen.findByRole('menuitem', { name: /Rename Radar/i }));
    expect(props.onRenameRadar).toHaveBeenCalledTimes(1);
  });

  it('fires delete when a radar is selected among several (enabled path)', async () => {
    const { user, props } = setup(); // 2 radars, one selected → delete enabled
    await user.click(screen.getAllByRole('button')[0]);
    await user.click(await screen.findByRole('menuitem', { name: /Delete Radar/i }));
    expect(props.onDeleteRadar).toHaveBeenCalledTimes(1);
  });
});

describe('RadarPageHeader — share / settings / add', () => {
  it('fires onAddEntry from the labelled Add entry button', async () => {
    const { user, props } = setup();
    await user.click(screen.getByRole('button', { name: 'Add entry' }));
    expect(props.onAddEntry).toHaveBeenCalledTimes(1);
  });

  it('fires onShareRadar from the share button', async () => {
    const { user, props, container } = setup();
    await user.click(iconButton(container, 'Share2'));
    expect(props.onShareRadar).toHaveBeenCalledTimes(1);
  });

  it('disables the share button when no radar is selected', () => {
    const { container } = render(<RadarPageHeader {...makeProps({ selectedRadarId: '' })} />);
    expect(iconButton(container, 'Share2')).toBeDisabled();
  });

  it('fires onOpenSettings from the settings button', async () => {
    const { user, props, container } = setup();
    await user.click(iconButton(container, 'Settings'));
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe('RadarPageHeader — accessible names (UX-040)', () => {
  it('names the radar selector and the manage, share, and settings icon buttons', () => {
    setup();
    expect(screen.getByRole('combobox', { name: 'Select radar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /manage radars/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /share radar/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /radar settings/i })).toBeInTheDocument();
  });
});
