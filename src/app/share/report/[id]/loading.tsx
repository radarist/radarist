/**
 * @file app/share/report/[id]/loading.tsx
 * @description Loading skeleton for the public report share page
 *
 * Displays a minimal loading state while the report is being fetched.
 * Uses inline styles since this is a public page outside the main app shell.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

/**
 * Loading state for the share report page.
 * Minimal design — no app-specific components to keep the page lightweight.
 */
export default function Loading() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '50vh',
        padding: '4rem',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div
        style={{
          width: '2rem',
          height: '2rem',
          border: '3px solid #e5e7eb',
          borderTopColor: '#6b7280',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }}
      />
      <p style={{ marginTop: '1rem', color: '#6b7280', fontSize: '0.9rem' }}>
        Loading report...
      </p>
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
