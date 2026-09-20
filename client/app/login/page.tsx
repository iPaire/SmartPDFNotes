//app/login/page.tsx
"use client";

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn, getProviders } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { analyticsEvents } from '@/lib/analytics';

// Componenta care folosește useSearchParams
function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations('auth');
  const tc = useTranslations('common');

  useEffect(() => {
    // Social buttons are shown only for providers that are configured on the server
    getProviders().then((providers) => setGoogleEnabled(Boolean(providers?.google)));
  }, []);

  useEffect(() => {
    // Verifică dacă există parametrul 'registered' în URL
    if (searchParams.get('registered') === 'true') {
      setRegistered(true);
      
      // Ascunde mesajul după 5 secunde
      const timer = setTimeout(() => {
        setRegistered(false);
      }, 5000);
      
      return () => clearTimeout(timer);
    }
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    
    try {
      const normalizedEmail = email.toLowerCase();
      const result = await signIn('credentials', {
        redirect: false,
        email : normalizedEmail,
        password,
      });

      if (result?.error) {
        // Mesaje de eroare mai specifice
        if (result.error === 'CredentialsSignin') {
          setError(t('invalidCredentials'));
        } else {
          setError(result.error);
        }
      } else {
        // Track successful login
        analyticsEvents.userLogin('email');
        router.push('/dashboard');
      }
    } catch (err) {
      setError(t('serverError'));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = () => {
    analyticsEvents.userLogin('google');
    signIn('google', { callbackUrl: '/dashboard' });
  };

  return (
    <div className="flex items-center justify-center min-h-[80vh] bg-gray-50">
      <div className="w-full max-w-md bg-white shadow-md rounded-xl p-8">
        <h1 className="text-2xl font-bold mb-6 text-center text-blue-600">{t('loginTitle')}</h1>
        <p className="text-gray-600 text-center mb-6">{t('loginSubtitle')}</p>
        
        {registered && (
          <div className="mb-4 p-3 bg-green-100 text-green-700 rounded-md text-center">
            {t('accountRegistered')}
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 bg-red-100 text-red-700 rounded-md text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('email')}</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-md bg-gray-100 text-gray-800 placeholder-gray-500 focus:outline-none focus:ring focus:border-blue-400"
              placeholder={t('emailPlaceholder')}
              required
              disabled={loading}
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('password')}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-md bg-gray-100 text-gray-800 placeholder-gray-500 focus:outline-none focus:ring focus:border-blue-400"
              placeholder="••••••••"
              required
              minLength={6}
              disabled={loading}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className={`w-full ${
              loading ? 'bg-blue-400' : 'bg-blue-600 hover:bg-blue-700'
            } text-white font-semibold py-2 rounded-md transition flex items-center justify-center cursor-pointer`}
          >
            {loading ? (
              <>
                <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                {tc('loading')}
              </>
            ) : (
              tc('login')
            )}
          </button>
        </form>

        {googleEnabled && (
          <>
            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-300"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="bg-white px-4 text-gray-500">{t('orContinueWith')}</span>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <button
                onClick={handleGoogleSignIn}
                className="w-full flex items-center justify-center gap-3 bg-white border border-gray-300 text-gray-700 py-2.5 rounded-md hover:bg-gray-50 transition cursor-pointer"
                disabled={loading}
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <g transform="matrix(1, 0, 0, 1, 27.009001, -39.238998)">
                    <path fill="#4285F4" d="M -3.264 51.509 C -3.264 50.719 -3.334 49.969 -3.454 49.239 L -14.754 49.239 L -14.754 53.749 L -8.284 53.749 C -8.574 55.229 -9.424 56.479 -10.684 57.329 L -10.684 60.329 L -6.824 60.329 C -4.564 58.239 -3.264 55.159 -3.264 51.509 Z"/>
                    <path fill="#34A853" d="M -14.754 63.239 C -11.514 63.239 -8.804 62.159 -6.824 60.329 L -10.684 57.329 C -11.764 58.049 -13.134 58.489 -14.754 58.489 C -17.884 58.489 -20.534 56.379 -21.484 53.529 L -25.464 53.529 L -25.464 56.619 C -23.494 60.539 -19.444 63.239 -14.754 63.239 Z"/>
                    <path fill="#FBBC05" d="M -21.484 53.529 C -21.734 52.809 -21.864 52.039 -21.864 51.239 C -21.864 50.439 -21.724 49.669 -21.484 48.949 L -21.484 45.859 L -25.464 45.859 C -26.284 47.479 -26.754 49.299 -26.754 51.239 C -26.754 53.179 -26.284 54.999 -25.464 56.619 L -21.484 53.529 Z"/>
                    <path fill="#EA4335" d="M -14.754 43.989 C -12.984 43.989 -11.404 44.599 -10.154 45.789 L -6.734 42.369 C -8.804 40.429 -11.514 39.239 -14.754 39.239 C -19.444 39.239 -23.494 41.939 -25.464 45.859 L -21.484 48.949 C -20.534 46.099 -17.884 43.989 -14.754 43.989 Z"/>
                  </g>
                </svg>
              {t('signInWithGoogle')}
              </button>
            </div>
          </>
        )}

        <div className="mt-6 text-center">
          <button 
            onClick={() => router.push('/reset-password')}
            className="text-blue-600 hover:text-blue-800 text-sm cursor-pointer"
            disabled={loading}
          >
{t('forgotPassword')}
          </button>
          
          <div className="mt-4 border-t pt-4">
            <p className="text-gray-600 text-sm">
              {t('dontHaveAccount')} {' '}
              <button 
                onClick={() => router.push('/register')}
                className="text-blue-600 hover:text-blue-800 font-medium cursor-pointer"
                disabled={loading}
              >
{t('register')}
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// Componenta pentru loading state
function LoginLoading() {
  return (
    <div className="flex items-center justify-center min-h-[80vh] bg-gray-50">
      <div className="w-full max-w-md bg-white shadow-md rounded-xl p-8">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded mb-6"></div>
          <div className="space-y-4">
            <div className="h-4 bg-gray-200 rounded w-1/4"></div>
            <div className="h-10 bg-gray-200 rounded"></div>
            <div className="h-4 bg-gray-200 rounded w-1/4"></div>
            <div className="h-10 bg-gray-200 rounded"></div>
            <div className="h-10 bg-gray-200 rounded"></div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Componenta principală cu Suspense
export default function LoginPage() {
  return (
    <Suspense fallback={<LoginLoading />}>
      <LoginForm />
    </Suspense>
  );
}