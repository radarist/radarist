/**
 * @file __tests__/html-sanitizer.test.ts
 * @description Unit tests for the shared HTML sanitizer.
 */

import { sanitizeHtml, sanitizeReportHtml } from '../html-sanitizer';

describe('sanitizeHtml', () => {
  // =========================================================================
  // Script tag removal
  // =========================================================================

  describe('script tag removal', () => {
    it('should remove inline script tags', () => {
      const input = '<div>Hello</div><script>alert("xss")</script><p>World</p>';
      expect(sanitizeHtml(input)).toBe('<div>Hello</div><p>World</p>');
    });

    it('should remove script tags with attributes', () => {
      const input = '<script type="text/javascript" src="evil.js"></script>';
      expect(sanitizeHtml(input)).toBe('');
    });

    it('should remove script tags case-insensitively', () => {
      const input = '<SCRIPT>alert("xss")</SCRIPT>';
      expect(sanitizeHtml(input)).toBe('');
    });

    it('should remove mixed-case script tags', () => {
      const input = '<ScRiPt>alert("xss")</sCrIpT>';
      expect(sanitizeHtml(input)).toBe('');
    });

    it('should remove multiple script tags', () => {
      const input = '<script>one()</script>safe<script>two()</script>';
      expect(sanitizeHtml(input)).toBe('safe');
    });

    it('should remove nested script-like content', () => {
      const input = '<script>var x = "<script>nested</script>";</script>';
      const result = sanitizeHtml(input);
      // Should not contain any script tags
      expect(result).not.toMatch(/<script/i);
    });
  });

  // =========================================================================
  // Event handler removal
  // =========================================================================

  describe('event handler removal (double quotes)', () => {
    it('should remove onclick with double quotes', () => {
      const input = '<button onclick="alert(1)">Click</button>';
      expect(sanitizeHtml(input)).toBe('<button>Click</button>');
    });

    it('should remove onerror with double quotes', () => {
      const input = '<img src="x" onerror="alert(1)">';
      expect(sanitizeHtml(input)).toBe('<img src="x">');
    });

    it('should remove onload with double quotes', () => {
      const input = '<body onload="init()">';
      expect(sanitizeHtml(input)).toBe('<body>');
    });
  });

  describe('event handler removal (single quotes)', () => {
    it('should remove onclick with single quotes', () => {
      const input = "<button onclick='alert(1)'>Click</button>";
      expect(sanitizeHtml(input)).toBe('<button>Click</button>');
    });

    it('should remove onerror with single quotes', () => {
      const input = "<img src='x' onerror='alert(1)'>";
      expect(sanitizeHtml(input)).toBe("<img src='x'>");
    });
  });

  describe('event handler removal (unquoted)', () => {
    it('should remove onclick without quotes', () => {
      const input = '<button onclick=alert(1)>Click</button>';
      expect(sanitizeHtml(input)).toBe('<button>Click</button>');
    });

    it('should remove onmouseover without quotes', () => {
      const input = '<div onmouseover=steal()>Hover</div>';
      expect(sanitizeHtml(input)).toBe('<div>Hover</div>');
    });
  });

  describe('event handler removal (case insensitive)', () => {
    it('should remove uppercase event handlers', () => {
      const input = '<button ONCLICK="alert(1)">Click</button>';
      expect(sanitizeHtml(input)).toBe('<button>Click</button>');
    });

    it('should remove mixed-case event handlers', () => {
      const input = '<button OnClick="alert(1)">Click</button>';
      expect(sanitizeHtml(input)).toBe('<button>Click</button>');
    });
  });

  describe('multiple event handlers', () => {
    it('should remove multiple event handlers from one element', () => {
      const input = '<div onclick="a()" onmouseover="b()">text</div>';
      expect(sanitizeHtml(input)).toBe('<div>text</div>');
    });
  });

  // =========================================================================
  // javascript: URL blocking
  // =========================================================================

  describe('javascript: URL blocking', () => {
    it('should block javascript: in href', () => {
      const input = '<a href="javascript:alert(1)">Click</a>';
      expect(sanitizeHtml(input)).toBe('<a href="blocked:alert(1)">Click</a>');
    });

    it('should block javascript: with spaces before colon', () => {
      const input = '<a href="javascript :alert(1)">Click</a>';
      expect(sanitizeHtml(input)).toBe('<a href="blocked:alert(1)">Click</a>');
    });

    it('should block javascript: case-insensitively', () => {
      const input = '<a href="JAVASCRIPT:alert(1)">Click</a>';
      expect(sanitizeHtml(input)).toBe('<a href="blocked:alert(1)">Click</a>');
    });

    it('should block JavaScript: in mixed case', () => {
      const input = '<a href="JaVaScRiPt:alert(1)">Click</a>';
      expect(sanitizeHtml(input)).toBe('<a href="blocked:alert(1)">Click</a>');
    });
  });

  // =========================================================================
  // Safe HTML preservation
  // =========================================================================

  describe('safe HTML preservation', () => {
    it('should preserve normal HTML tags', () => {
      const input = '<h1>Title</h1><p>Paragraph</p><ul><li>Item</li></ul>';
      expect(sanitizeHtml(input)).toBe(input);
    });

    it('should preserve HTML attributes', () => {
      const input = '<a href="https://example.com" target="_blank">Link</a>';
      expect(sanitizeHtml(input)).toBe(input);
    });

    it('should preserve inline styles', () => {
      const input = '<div style="color: red; font-size: 14px;">Styled</div>';
      expect(sanitizeHtml(input)).toBe(input);
    });

    it('should preserve img tags with safe attributes', () => {
      const input = '<img src="photo.jpg" alt="Photo" width="100">';
      expect(sanitizeHtml(input)).toBe(input);
    });

    it('should preserve data attributes', () => {
      const input = '<div data-testid="foo" data-value="bar">Content</div>';
      expect(sanitizeHtml(input)).toBe(input);
    });

    it('should preserve class and id attributes', () => {
      const input = '<div id="main" class="container">Content</div>';
      expect(sanitizeHtml(input)).toBe(input);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('should handle empty string', () => {
      expect(sanitizeHtml('')).toBe('');
    });

    it('should handle string with no HTML', () => {
      const input = 'Just plain text with no tags';
      expect(sanitizeHtml(input)).toBe(input);
    });

    it('should handle whitespace-only string', () => {
      expect(sanitizeHtml('   ')).toBe('   ');
    });

    it('should handle combined XSS vectors', () => {
      const input = '<div onclick="steal()"><script>alert(1)</script><a href="javascript:void(0)">link</a></div>';
      const result = sanitizeHtml(input);
      expect(result).not.toMatch(/<script/i);
      expect(result).not.toMatch(/onclick/i);
      expect(result).not.toMatch(/javascript\s*:/i);
      expect(result).toContain('<a href="blocked:void(0)">link</a>');
    });

    it('should handle script tags with newlines in content', () => {
      const input = '<script>\nalert(1)\n</script>';
      expect(sanitizeHtml(input)).toBe('');
    });
  });
});

// ===========================================================================
// sanitizeReportHtml — active-report normalization, not an XSS boundary
// ===========================================================================
//
// publishReport's storage write goes through sanitizeReportHtml, NOT
// sanitizeHtml. The strict variant was stripping Chart.js + Mermaid script
// tags from creator-mission reports, leaving empty <canvas> and bare
// <div class="mermaid"> elements. The lenient
// variant exists exactly for this case: scripts and event handlers remain in
// the stored document, then renderers strip them or contain them in an
// opaque-origin iframe. Authenticated-user and model output are both untrusted.

describe('sanitizeReportHtml', () => {
  it('preserves <script> tags so Chart.js and Mermaid render', () => {
    const input =
      '<canvas id="tcoChart"></canvas>' +
      '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>' +
      '<script>new Chart(document.getElementById("tcoChart"), { type: "bar" });</script>';
    const out = sanitizeReportHtml(input);
    expect(out).toContain('<canvas id="tcoChart">');
    expect(out).toContain('<script src="https://cdn.jsdelivr.net/npm/chart.js">');
    expect(out).toMatch(/new Chart\(document/);
  });

  it('preserves on* event handlers used by interactive reports', () => {
    const input = '<button onclick="filter(\'all\')">All</button>';
    expect(sanitizeReportHtml(input)).toContain('onclick="filter(\'all\')"');
  });

  it('still neutralizes javascript: protocol URLs as a minimal safety net', () => {
    const input = '<a href="javascript:steal()">click</a>';
    expect(sanitizeReportHtml(input)).toContain('href="blocked:steal()"');
  });

  it('passes through plain HTML unchanged', () => {
    const input = '<div class="card"><h1>Title</h1><p>Body</p></div>';
    expect(sanitizeReportHtml(input)).toBe(input);
  });

  it('handles empty string', () => {
    expect(sanitizeReportHtml('')).toBe('');
  });

  it('does not claim to remove executable HTML at the storage boundary', () => {
    const input = '<img src="x" onerror="parent.document.body.dataset.pwned=\'true\'">';
    expect(sanitizeReportHtml(input)).toContain('onerror=');
  });
});
