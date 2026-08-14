'use client';

import { Suspense, useState } from 'react';
import { useAuth } from '@/components/providers/AuthProvider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Loader2, AlertCircle, Info, X } from 'lucide-react';
import { OctopusLogo } from '@/components/branding/OctopusLogo';
import { DEMO_USER_EMAIL, DEMO_USER_PASSWORD } from '@/lib/demo-credentials';
import { SessionEndedNotice } from '@/components/auth/SessionEndedNotice';

export default function LoginPage() {
  const { signIn, signInWithGoogle, loading: authLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [demoHintDismissed, setDemoHintDismissed] = useState(false);

  // Same gate as src/lib/firebase.ts — the demo user only exists in the
  // emulator's seeded Auth store, so the hint is meaningless outside it.
  const isEmulatorMode = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === 'true';

  const handleFillDemoCredentials = () => {
    setEmail(DEMO_USER_EMAIL);
    setPassword(DEMO_USER_PASSWORD);
    setError(null);
  };

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await signIn(email, password);
    } catch (err) {
      if (err instanceof Error) {
        // Parse Firebase error codes
        if (err.message.includes('auth/invalid-credential')) {
          setError('Invalid email or password');
        } else if (err.message.includes('auth/user-not-found')) {
          setError('No account found with this email');
        } else if (err.message.includes('auth/wrong-password')) {
          setError('Incorrect password');
        } else if (err.message.includes('auth/too-many-requests')) {
          setError('Too many failed attempts. Please try again later');
        } else {
          setError('Sign in failed. Please try again');
        }
      } else {
        setError('An unexpected error occurred');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    setLoading(true);

    try {
      await signInWithGoogle();
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('auth/popup-closed-by-user')) {
          setError('Sign in cancelled');
        } else if (err.message.includes('auth/popup-blocked')) {
          setError('Popup was blocked. Please allow popups for this site');
        } else {
          setError('Google sign in failed. Please try again');
        }
      } else {
        setError('An unexpected error occurred');
      }
    } finally {
      setLoading(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-[#39A9DB] via-[#5BC0DE] to-[#d63230] animate-gradient-slow" />
        <Loader2 className="h-8 w-8 animate-spin text-white relative z-10" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden">
      {/* Animated gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#39A9DB] via-[#5BC0DE] to-[#d63230] animate-gradient-slow" />

      {/* Floating orbs for depth */}
      <div className="absolute top-1/4 left-1/4 w-72 h-72 bg-white/20 rounded-full blur-3xl animate-float" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-[#39A9DB]/30 rounded-full blur-3xl animate-float-delayed" />
      <div className="absolute top-1/2 right-1/3 w-48 h-48 bg-[#d63230]/20 rounded-full blur-2xl animate-float" />

      {/* Footer */}
      <div className="absolute bottom-4 left-4 text-xs text-white/70">Open-source prototype</div>
      <div className="absolute bottom-4 right-4 text-xs text-white/70">v0.1 prototype</div>

      {/* Glassmorphism card */}
      <div className="w-full max-w-md relative z-10">
        <div className="backdrop-blur-xl bg-white/10 dark:bg-black/20 border border-white/20 rounded-2xl shadow-2xl p-8">
          {/* Header with logo */}
          <div className="text-center mb-6">
            <div className="flex justify-center mb-4">
              <OctopusLogo size="lg" />
            </div>
            <h1 className="text-2xl font-bold text-white">Radarist</h1>
            <p className="text-white/70 text-sm mt-1">Sign in to your account</p>
          </div>

          <div className="space-y-4">
            {/* UX-056 — the notice owns `useSearchParams`, which opts a page out of
                static prerendering unless it sits behind a Suspense boundary. */}
            <Suspense fallback={null}>
              <SessionEndedNotice />
            </Suspense>

            {isEmulatorMode && !demoHintDismissed && (
              <Alert className="bg-white/10 border-white/20 text-white [&>svg]:text-white">
                <button
                  type="button"
                  aria-label="Dismiss demo credentials hint"
                  className="absolute right-2 top-2 rounded-md p-1 text-white/70 hover:text-white hover:bg-white/10"
                  onClick={() => setDemoHintDismissed(true)}
                >
                  <X className="h-4 w-4" />
                </button>
                <Info className="h-4 w-4" />
                <AlertTitle className="pr-6">Local demo mode</AlertTitle>
                <AlertDescription className="text-white/80 space-y-2">
                  <p>
                    Sign in with <span className="font-mono text-white">{DEMO_USER_EMAIL}</span> /{' '}
                    <span className="font-mono text-white">{DEMO_USER_PASSWORD}</span>
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="bg-white/10 border-white/20 text-white hover:bg-white/20 hover:text-white"
                    onClick={handleFillDemoCredentials}
                    disabled={loading}
                  >
                    Fill demo credentials
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {error && (
              <Alert variant="destructive" className="bg-red-500/20 border-red-500/30 text-white">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Button
              variant="outline"
              className="w-full bg-white/10 border-white/20 text-white hover:bg-white/20 hover:text-white"
              onClick={handleGoogleSignIn}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
                  <path
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    fill="#4285F4"
                  />
                  <path
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    fill="#34A853"
                  />
                  <path
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    fill="#EA4335"
                  />
                </svg>
              )}
              Continue with Google
            </Button>

            <div className="relative">
              <Separator className="bg-white/20" />
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-transparent px-2 text-xs text-white/50">
                or
              </span>
            </div>

            <form onSubmit={handleEmailSignIn} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-white/90">
                  Email
                </Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="name@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={loading}
                  className="bg-white/10 border-white/20 text-white placeholder:text-white/40 focus:border-white/40 focus:ring-white/20"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="text-white/90">
                  Password
                </Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={loading}
                  className="bg-white/10 border-white/20 text-white placeholder:text-white/40 focus:border-white/40 focus:ring-white/20"
                />
              </div>
              <Button
                type="submit"
                className="w-full bg-white text-[#39A9DB] hover:bg-white/90 font-semibold"
                disabled={loading}
              >
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Sign in
              </Button>
            </form>

            <p className="text-center text-sm text-white/70">
              Don&apos;t have an account?{' '}
              <a href="/signup" className="text-white hover:underline font-medium">
                Sign up
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
