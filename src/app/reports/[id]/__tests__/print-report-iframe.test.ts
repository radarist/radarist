import {
  printReportIframe,
  REPORT_IFRAME_SANDBOX,
  REPORT_PRINT_IFRAME_SANDBOX,
  type PrintableIframe,
} from '../print-report-iframe';

describe('printReportIframe', () => {
  it('focuses then prints the iframe contentWindow when loaded (P-F5 fix)', () => {
    const print = jest.fn();
    const focus = jest.fn();
    const iframe: PrintableIframe = { contentWindow: { focus, print } };

    const result = printReportIframe(iframe, true);

    expect(result).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledTimes(1);
    // focus() must run before print() — Safari/Firefox only honor
    // contentWindow.print() after the window has received focus.
    expect(focus.mock.invocationCallOrder[0]).toBeLessThan(print.mock.invocationCallOrder[0]);
  });

  it('never calls the parent window.print — this is the regression the bug fix closes', () => {
    const windowPrintSpy = jest.spyOn(window, 'print').mockImplementation(() => {});
    const iframe: PrintableIframe = { contentWindow: { focus: jest.fn(), print: jest.fn() } };

    printReportIframe(iframe, true);

    expect(windowPrintSpy).not.toHaveBeenCalled();
    windowPrintSpy.mockRestore();
  });

  it('does nothing and returns false when the iframe has not finished loading yet', () => {
    const print = jest.fn();
    const focus = jest.fn();
    const iframe: PrintableIframe = { contentWindow: { focus, print } };

    const result = printReportIframe(iframe, false);

    expect(result).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(print).not.toHaveBeenCalled();
  });

  it('does nothing and returns false when the iframe has no contentWindow', () => {
    const iframe: PrintableIframe = { contentWindow: null };

    expect(printReportIframe(iframe, true)).toBe(false);
  });

  it('does nothing and returns false when the ref itself is null (unmounted/not yet attached)', () => {
    expect(printReportIframe(null, true)).toBe(false);
  });

  it('fails closed when browser security rejects access to the target window', () => {
    const iframe: PrintableIframe = {
      contentWindow: {
        focus: jest.fn(() => {
          throw new DOMException('Blocked', 'SecurityError');
        }),
        print: jest.fn(),
      },
    };

    expect(printReportIframe(iframe, true)).toBe(false);
    expect(iframe.contentWindow?.print).not.toHaveBeenCalled();
  });
});

describe('report iframe sandbox policies', () => {
  it('grants the active preview no sandbox capability', () => {
    expect(REPORT_IFRAME_SANDBOX).toBe('');
  });

  it('grants the static print frame same-origin and modal printing but no scripts', () => {
    expect(REPORT_PRINT_IFRAME_SANDBOX.split(' ').sort()).toEqual(['allow-modals', 'allow-same-origin']);
  });

  it('never combines script execution with the application origin', () => {
    for (const policy of [REPORT_IFRAME_SANDBOX, REPORT_PRINT_IFRAME_SANDBOX]) {
      const tokens = policy.split(' ');
      expect(tokens.includes('allow-scripts') && tokens.includes('allow-same-origin')).toBe(false);
    }
  });
});
