/**
 * @file ChatInput.slash.test.tsx
 * @description Unit tests for the `/`-command menu in ChatInput.
 *
 * Tests cover:
 * - Menu opens for a lone `/token` and matches built-ins + catalog skills
 * - Menu does NOT open once the value contains a space
 * - ArrowDown + Enter selects the highlighted command via onChange (no submit)
 * - Normal (non-slash) Enter still submits (regression)
 * - Escape dismisses the menu without wiping the typed text
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

// lucide-react: lightweight stub icons (real package is ESM-only; mirrors ChatInput.test.tsx)
jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (typeof prop !== 'string') return undefined;
        const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        Icon.displayName = prop;
        return Icon;
      },
    }
  );
});

jest.mock('@/lib/ai/capability-catalog.generated', () => ({
  CAPABILITY_CATALOG: {
    skills: [{ name: 'research-technology', description: 'deep research', category: 'Research & evidence' }],
    profiles: [],
    tools: [],
  },
}));

// Speech hook is used by ChatInput; stub it (mirrors ChatInput.test.tsx).
jest.mock('@/hooks/useSpeechRecognition', () => ({
  useSpeechRecognition: () => ({
    isListening: false,
    transcript: '',
    interimTranscript: '',
    isSupported: false,
    startListening: jest.fn(),
    stopListening: jest.fn(),
    resetTranscript: jest.fn(),
  }),
}));

// Import the component AFTER all mocks are in place
import { ChatInput } from '../ChatInput';

function setup(value: string, onChange = jest.fn(), onSubmit = jest.fn()) {
  const utils = render(<ChatInput value={value} onChange={onChange} onSubmit={onSubmit} isLoading={false} />);
  return { onChange, onSubmit, ...utils };
}

describe('ChatInput slash menu', () => {
  it('opens a listbox of matching commands when the value is a lone /token', () => {
    setup('/re');
    const menu = screen.getByRole('listbox');
    expect(menu).toBeInTheDocument();
    expect(screen.getByText('/research')).toBeInTheDocument();
    // a skill whose id contains "re"
    expect(screen.getByText('/research-technology')).toBeInTheDocument();
  });

  it('does NOT open when the value has a space (not a lone token)', () => {
    setup('/research something');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('ArrowDown then Enter selects the highlighted command via onChange and does not submit', () => {
    const onChange = jest.fn();
    const onSubmit = jest.fn();
    const { rerender } = render(<ChatInput value="/re" onChange={onChange} onSubmit={onSubmit} isLoading={false} />);
    const textarea = screen.getByTestId('chat-input');
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
    const inserted = onChange.mock.calls[0][0];
    expect(typeof inserted).toBe('string');
    expect(inserted).not.toMatch(/^\/\S+$/); // a template, not a lone /token
    // menu closes once the value is no longer a lone token
    rerender(<ChatInput value={inserted} onChange={onChange} onSubmit={onSubmit} isLoading={false} />);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('Enter on a normal message still submits (regression)', () => {
    const onSubmit = jest.fn();
    setup('hello world', jest.fn(), onSubmit);
    fireEvent.keyDown(screen.getByTestId('chat-input'), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('hello world', expect.any(Object));
  });

  it('Escape dismisses the menu but keeps the text', () => {
    const onChange = jest.fn();
    setup('/re', onChange);
    fireEvent.keyDown(screen.getByTestId('chat-input'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalledWith(''); // did not wipe the input
  });

  it('marks the open menu with data-slash-menu-open so panel-close handlers can detect it', () => {
    // AIAssistant's Sheet consults `[data-slash-menu-open]` on Escape to avoid
    // closing the whole panel while the menu is open. Guard that contract.
    setup('/re');
    expect(screen.getByRole('listbox')).toHaveAttribute('data-slash-menu-open');
  });

  it('stops Escape from reaching the window while the menu is open, but lets it through when closed', () => {
    // The panel-mode close listener is a window-level keydown handler. When the
    // slash menu is open the first Escape must NOT reach it (stopPropagation),
    // so the menu dismisses and the panel stays open; a later Escape closes it.
    const windowSpy = jest.fn();
    window.addEventListener('keydown', windowSpy);
    try {
      const { unmount } = setup('/re');
      fireEvent.keyDown(screen.getByTestId('chat-input'), { key: 'Escape' });
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument(); // dismissed
      expect(windowSpy).not.toHaveBeenCalled(); // propagation was stopped
      unmount();

      // Menu closed (value is not a lone /token) → Escape propagates normally.
      windowSpy.mockClear();
      setup('hello');
      fireEvent.keyDown(screen.getByTestId('chat-input'), { key: 'Escape' });
      expect(windowSpy).toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', windowSpy);
    }
  });
});
