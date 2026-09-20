"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { analyticsEvents } from '@/lib/analytics';


import { getErrorMessage } from '@/lib/errors';
export default function RegisterPage() {
  const t = useTranslations('auth');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false); // Adăugăm starea pentru succes
  const router = useRouter();

  function validateEmail(email: string) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    // Validări de bază
    if (password !== confirmPassword) {
      setError(t('passwordsDontMatch'));
      setLoading(false);
      return;
    }

    if (password.length < 6) {
      setError(t('passwordTooShort'));
      setLoading(false);
      return;
    }

    if (!validateEmail(email)) {
      setError(t('invalidEmail'));
      setLoading(false);
      return;
    }


    try {
      // Trimite cererea de înregistrare la API
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, email, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Eroare la înregistrare');
      }

      // Afișează mesaj de succes
      setSuccess(true);
      setError(null);
      
      // Track successful registration
      analyticsEvents.userRegister('email');
      
      // Resetează formularul
      setName('');
      setEmail('');
      setPassword('');
      setConfirmPassword('');
      
      // Redirecționează automat după 2 secunde
      setTimeout(() => {
        router.push('/login');
      }, 2000);
    } catch (err) {
      setError(getErrorMessage(err) || 'Eroare la înregistrare');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-[80vh] bg-gray-50">
      <div className="w-full max-w-md bg-white shadow-md rounded-xl p-8">
        <h1 className="text-2xl font-bold mb-6 text-center text-blue-600">{t('createNewAccount')}</h1>
        
        {error && (
          <div className="mb-4 p-3 bg-red-100 text-red-700 rounded-md text-center">
            {error}
          </div>
        )}
        
        {success && (
          <div className="mb-4 p-3 bg-green-100 text-green-700 rounded-md text-center">
            {t('accountCreatedSuccess')}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('fullName')}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-md bg-gray-100 text-gray-800 placeholder-gray-500 focus:outline-none focus:ring focus:border-blue-400"
              placeholder={t('fullNamePlaceholder')}
              required
              disabled={loading || success}
            />
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('email')}</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-md bg-gray-100 text-gray-800 placeholder-gray-500 focus:outline-none focus:ring focus:border-blue-400"
              placeholder={t('emailPlaceholder')}
              required
              disabled={loading || success}
            />
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('password')}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-md bg-gray-100 text-gray-800 placeholder-gray-500 focus:outline-none focus:ring focus:border-blue-400"
              placeholder={t('passwordPlaceholder')}
              required
              minLength={6}
              disabled={loading || success}
            />
            <p className="mt-1 text-xs text-gray-500">{t('minimum6Characters')}</p>
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('confirmPassword')}</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-md bg-gray-100 text-gray-800 placeholder-gray-500 focus:outline-none focus:ring focus:border-blue-400"
              placeholder={t('confirmPasswordPlaceholder')}
              required
              disabled={loading || success}
            />
          </div>

          <div className="mb-4 flex items-center">
            <input
              type="checkbox"
              id="terms"
              required
              className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500"
              disabled={loading || success}
            />
            <label htmlFor="terms" className="ml-2 text-sm text-gray-600">
              {t('agreeTerms')} <Link href="/termeni" className="text-blue-600 hover:underline">{t('termsAndConditions')}</Link>
            </label>
          </div>

          <button
            type="submit"
            disabled={loading || success}
            className={`w-full ${
              loading || success ? 'bg-blue-400' : 'bg-blue-600 hover:bg-blue-700'
            } text-white font-semibold py-2 rounded-md transition flex items-center justify-center`}
          >
            {loading ? (
              <>
                <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                {t('loading')}
              </>
            ) : (
              success ? t('accountCreated') : t('register')
            )}
          </button>
        </form>

        <div className="mt-6 text-center border-t pt-6">
          <p className="text-gray-600 text-sm">
            {t('alreadyHaveAccountLogin')} {' '}
            <Link 
              href="/login"
              className="text-blue-600 hover:text-blue-800 font-medium"
            >
              {t('authenticate')}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}