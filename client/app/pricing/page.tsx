"use client";
import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { getClientStripe } from '@/lib/stripe';
import { useTranslations, useLocale } from 'next-intl';
import { analyticsEvents } from '@/lib/analytics';

// Mapeo de idiomas a monedas y precios
type Currency = 'usd' | 'ron' | 'eur';

const LOCALE_TO_CURRENCY: Record<string, Currency> = {
  'en': 'usd',
  'ro': 'ron',
  'es': 'eur',
  'de': 'eur',
  'fr': 'eur',
};

// Prețurile pentru fiecare valută
const PRICES_BY_CURRENCY = {
  usd: {
    FREE: 0,
    PREMIUM_MONTHLY: 10,
    PREMIUM_MONTHLY_REDUCED: 7,
    PREMIUM_ANNUAL: 100,
  },
  ron: {
    FREE: 0,
    PREMIUM_MONTHLY: 50,
    PREMIUM_MONTHLY_REDUCED: 35,
    PREMIUM_ANNUAL: 500,
  },
  eur: {
    FREE: 0,
    PREMIUM_MONTHLY: 10,
    PREMIUM_MONTHLY_REDUCED: 7,
    PREMIUM_ANNUAL: 100,
  },
};

// Price IDs por moneda
const PRICE_IDS_BY_CURRENCY = {
  usd: {
    PREMIUM: process.env.NEXT_PUBLIC_STRIPE_PREMIUM_PRICE_ID_USD || 'price_1RakRCPRCTOomzu9UZva09Sy',
    PREMIUM_ANNUAL: process.env.NEXT_PUBLIC_STRIPE_PREMIUM_ANNUAL_PRICE_ID_USD || 'price_1SHXBCPRCTOomzu9Xc01pKZt',
  },
  eur: {
    PREMIUM: process.env.NEXT_PUBLIC_STRIPE_PREMIUM_PRICE_ID_EUR || 'price_1RakRZPRCTOomzu98xVshiPb',
    PREMIUM_ANNUAL: process.env.NEXT_PUBLIC_STRIPE_PREMIUM_ANNUAL_PRICE_ID_EUR || 'price_1SHXAnPRCTOomzu9q2Z3XYa9',
  },
  ron: {
    PREMIUM: process.env.NEXT_PUBLIC_STRIPE_PREMIUM_PRICE_ID_RON || 'price_1RakRPPRCTOomzu9EO4334yX',
    PREMIUM_ANNUAL: process.env.NEXT_PUBLIC_STRIPE_PREMIUM_ANNUAL_PRICE_ID_RON || 'price_1SHXYGPRCTOomzu9NprKyB7B',
  },
};

export default function PricingPage() {
  const t = useTranslations('pricing');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const [isMobile, setIsMobile] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const { data: session } = useSession();
  const router = useRouter();

  // Obtener los price IDs según el idioma/moneda
  const currency = LOCALE_TO_CURRENCY[locale] || 'eur';
  const PRICE_IDS = PRICE_IDS_BY_CURRENCY[currency];
  const prices = PRICES_BY_CURRENCY[currency];
  const currencySymbol = t('currencySymbol');

  useEffect(() => {
    const checkIfMobile = () => setIsMobile(window.innerWidth < 768);
    checkIfMobile();
    window.addEventListener('resize', checkIfMobile);
    return () => window.removeEventListener('resize', checkIfMobile);
  }, []);

  // Verifică dacă utilizatorul are dreptul la reducere
  const hasDiscount = () => {
    if (!session || !session.user || !session.user.createdAt) return false;
    
    const accountCreationDate = new Date(session.user.createdAt);
    const today = new Date();
    const monthsSinceCreation = 
      (today.getFullYear() - accountCreationDate.getFullYear()) * 12 +
      (today.getMonth() - accountCreationDate.getMonth());
      
    return monthsSinceCreation < 2;
  };

  const handleCheckout = async (priceId: string) => {
    if (!session) {
      router.push('/login');
      return;
    }

    // Track subscription upgrade attempt with detailed analytics
    const planType = priceId === PRICE_IDS.PREMIUM ? 'premium_monthly' : 'premium_annual';
    const planPrice = priceId === PRICE_IDS.PREMIUM
      ? (hasDiscount() ? prices.PREMIUM_MONTHLY_REDUCED : prices.PREMIUM_MONTHLY)
      : prices.PREMIUM_ANNUAL;

    // Get currency code based on current currency
    const currencyCode = currency.toUpperCase();

    // Track the purchase button click with currency
    analyticsEvents.purchaseButtonClick(planType, planPrice, currencyCode);
    analyticsEvents.subscriptionUpgrade(planType);

    setSelectedPlan(priceId);
    
    try {
      const response = await fetch('/api/checkout_sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create checkout session');
      }

      const { sessionId } = await response.json();
      const stripe = await getClientStripe();
      
      if (stripe) {
        const { error } = await stripe.redirectToCheckout({ sessionId });
        
        if (error) {
          throw error;
        }
      }
    } catch (error) {
      console.error('Checkout error:', error);
      alert('Eroare: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      setSelectedPlan(null);
    }
  };

  const handleFreePlan = () => {
    // Track free plan selection
    analyticsEvents.buttonClick('start_free_plan', 'pricing_page');
    router.push(session ? '/upload' : '/login');
  };

  const isLoading = (plan: string) => selectedPlan === plan;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-gray-100 py-8 px-4 sm:py-16">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl sm:text-4xl font-bold text-center mb-8 sm:mb-12 text-blue-600">
          {t('subscriptionPlans')}
        </h1>

        {isMobile ? (
          <div className="space-y-6">
            {/* Plan gratuit */}
            <div className="bg-white shadow-lg rounded-xl p-5 border border-gray-300">
              <h2 className="text-xl font-semibold text-gray-800 mb-3">{t('free')}</h2>
              <p className="text-ink-soft mb-3 text-sm">{t('freeDescription')}</p>
              <ul className="text-sm text-gray-700 list-disc ml-5 mb-4 space-y-1">
                <li>3 {t('pdfLimitMonth')}</li>
                <li>{t('aiSummary')}</li>
                <li>{t('quizTests')}</li>
              </ul>
              <p className="font-bold text-gray-800 text-lg mb-4">{currencySymbol}{prices.FREE} / {t('month')}</p>
              <button 
                onClick={handleFreePlan}
                className="w-full py-2 px-4 rounded-lg border border-gray-300 text-gray-800 font-medium hover:bg-gray-300 hover:text-white"
              >
                {t('startNow')}
              </button>
            </div>

            {/* Plan Premium Lunar */}
            <div className="relative">
              {hasDiscount() && (
                <div className="absolute -top-3 right-4 bg-purple-500 text-white px-3 py-1 rounded-lg font-bold z-10 transform rotate-3 shadow-md text-xs">
                  {t('reduced')}
                </div>
              )}
              <div className={`bg-white shadow-xl rounded-xl p-5 border-2 ${hasDiscount() ? 'border-purple-500' : 'border-yellow-500'}`}>
                <h2 className="text-xl font-semibold text-gray-800 mb-3">{t('premiumMonthly')}</h2>
                <p className="text-ink-soft mb-3 text-sm">{t('premiumMonthlyDescription')}</p>
                <ul className="text-sm text-gray-700 list-disc ml-5 mb-4 space-y-1">
                  <li>50 {t('pdfLimitMonth')}</li>
                  <li>{t('aiSummary')} + {t('quizTests')}</li>
                  <li>Generare quiz-uri personalizate</li>
                </ul>
                
                {hasDiscount() ? (
                  <div>
                    <div className="mb-2">
                      <span className="font-bold text-gray-800 text-lg">{currencySymbol}{prices.PREMIUM_MONTHLY_REDUCED} / {t('month')}</span>
                      <span className="ml-2 text-xs text-ink-faint line-through">{currencySymbol}{prices.PREMIUM_MONTHLY}</span>
                    </div>
                    <p className="text-xs text-ink-soft mb-4">{t('firstTwoMonths')} {currencySymbol}{prices.PREMIUM_MONTHLY}/{t('month')}</p>
                  </div>
                ) : (
                  <p className="font-bold text-gray-800 text-lg mb-4">{currencySymbol}{prices.PREMIUM_MONTHLY} / {t('month')}</p>
                )}
                
                <button 
                  onClick={() => handleCheckout(PRICE_IDS.PREMIUM)}
                  disabled={isLoading(PRICE_IDS.PREMIUM)}
                  className={`w-full py-2 px-4 rounded-lg border font-medium 
                    ${isLoading(PRICE_IDS.PREMIUM)
                      ? 'bg-purple-300 cursor-not-allowed text-white'
                      : `text-${hasDiscount() ? 'purple' : 'yellow'}-500 border-${hasDiscount() ? 'purple' : 'yellow'}-500 hover:bg-${hasDiscount() ? 'purple' : 'yellow'}-500 hover:text-white`}`}
                >
                  {isLoading(PRICE_IDS.PREMIUM) ? t('processing') : t('choosePremium')}
                </button>
              </div>
            </div>

            {/* Plan Premium Anual */}
            <div className="relative">
              <div className="absolute -top-3 right-4 bg-yellow-500 text-white px-3 py-1 rounded-lg font-bold z-10 transform rotate-3 shadow-md text-xs">
                {t('recommended')}
              </div>
              <div className="bg-white shadow-xl rounded-xl p-5 border-2 border-yellow-500">
                <h2 className="text-xl font-semibold text-gray-800 mb-3">{t('premiumAnnual')}</h2>
                <p className="text-ink-soft mb-3 text-sm">{t('premiumAnnualDescription')}</p>
                <ul className="text-sm text-gray-700 list-disc ml-5 mb-4 space-y-1">
                  <li>200 {t('pdfLimitMonth')}</li>
                  <li>Tot ce este în {t('premiumMonthly')}</li>
                  <li>Profesor AI (video lecții personalizate)</li>
                  <li>{t('save17Percent')}</li>
                </ul>
                <p className="font-bold text-gray-800 text-lg mb-4">{currencySymbol}{prices.PREMIUM_ANNUAL} / {t('year')}</p>
                <button
                  onClick={() => handleCheckout(PRICE_IDS.PREMIUM_ANNUAL)}
                  disabled={isLoading(PRICE_IDS.PREMIUM_ANNUAL)}
                  className={`w-full py-2 px-4 rounded-lg border font-medium
                    ${isLoading(PRICE_IDS.PREMIUM_ANNUAL)
                      ? 'bg-yellow-300 cursor-not-allowed text-white'
                      : 'text-yellow-500 border-yellow-500 hover:bg-yellow-500 hover:text-white'}`}
                >
                  {isLoading(PRICE_IDS.PREMIUM_ANNUAL) ? t('processing') : t('choosePremiumAnnual')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Plan gratuit */}
            <div className="bg-white shadow-lg rounded-xl p-6 border border-gray-300 transition-all hover:shadow-xl">
              <h2 className="text-xl font-semibold text-gray-800 mb-4">{t('free')}</h2>
              <p className="text-ink-soft mb-4">{t('freeDescription')}</p>
              <ul className="text-sm text-gray-700 list-disc ml-5 mb-4 space-y-2">
                <li>3 {t('pdfLimitMonth')}</li>
                <li>{t('maxFileSize')} 10MB</li>
                <li>{t('selfAssessmentQuestions')}</li>
              </ul>
              <p className="font-bold text-gray-800 text-lg mb-6">{currencySymbol}{prices.FREE} / {t('month')}</p>
              <button 
                onClick={handleFreePlan}
                className="w-full py-3 px-4 rounded-lg border border-gray-300 text-gray-800 font-medium hover:bg-gray-300 hover:text-white"
              >
                {t('startNow')}
              </button>
            </div>

            {/* Plan Premium Lunar */}
            <div className="relative">
              {hasDiscount() && (
                <div className="absolute -top-3 right-4 bg-purple-500 text-white px-4 py-2 rounded-lg font-bold z-10 transform rotate-3 shadow-md">
                  {t('reduced')}
                </div>
              )}
              <div className={`bg-white shadow-xl rounded-xl p-6 border-2 transition-all hover:shadow-2xl ${hasDiscount() ? 'border-purple-500' : 'border-yellow-500'}`}>
                <h2 className="text-xl font-semibold text-gray-800 mb-4">{t('premiumMonthly')}</h2>
                <p className="text-ink-soft mb-4">{t('premiumMonthlyDescription')}</p>
                <ul className="text-sm text-gray-700 list-disc ml-5 mb-4 space-y-2">
                  <li>50 {t('pdfLimitMonth')}</li>
                  <li>{t('maxFileSize')} 50MB</li>
                  <li>Quiz 5 {t('questions')}</li>
                </ul>
                
                {hasDiscount() ? (
                  <div>
                    <div className="mb-2">
                      <span className="font-bold text-gray-800 text-lg">{currencySymbol}{prices.PREMIUM_MONTHLY_REDUCED} / {t('month')}</span>
                      <span className="ml-2 text-sm text-ink-faint line-through">{currencySymbol}{prices.PREMIUM_MONTHLY}</span>
                    </div>
                    <p className="text-sm text-ink-soft mb-6">{t('firstTwoMonths')} {currencySymbol}{prices.PREMIUM_MONTHLY}/{t('month')}</p>
                  </div>
                ) : (
                  <p className="font-bold text-gray-800 text-lg mb-6">{currencySymbol}{prices.PREMIUM_MONTHLY} / {t('month')}</p>
                )}
                
                <button 
                  onClick={() => handleCheckout(PRICE_IDS.PREMIUM)}
                  disabled={isLoading(PRICE_IDS.PREMIUM)}
                  className={`w-full py-3 px-4 rounded-lg border font-medium 
                    ${isLoading(PRICE_IDS.PREMIUM)
                      ? 'bg-purple-300 cursor-not-allowed text-white'
                      : `text-${hasDiscount() ? 'purple' : 'yellow'}-500 border-${hasDiscount() ? 'purple' : 'yellow'}-500 hover:bg-${hasDiscount() ? 'purple' : 'yellow'}-500 hover:text-white`}`}
                >
                  {isLoading(PRICE_IDS.PREMIUM) ? t('processing') : t('choosePremium')}
                </button>
              </div>
            </div>

            {/* Plan Premium Anual */}
            <div className="relative md:col-span-2">
              <div className="absolute -top-3 right-4 bg-yellow-500 text-white px-4 py-2 rounded-lg font-bold z-10 transform rotate-3 shadow-md">
                {t('recommended')}
              </div>
              <div className="bg-white shadow-xl rounded-xl p-6 border-2 border-yellow-500 transition-all hover:shadow-2xl">
                <h2 className="text-xl font-semibold text-gray-800 mb-4">{t('premiumAnnual')}</h2>
                <p className="text-ink-soft mb-4">{t('premiumAnnualDescription')}</p>
                <ul className="text-sm text-gray-700 list-disc ml-5 mb-4 space-y-2">
                  <li>200 {t('pdfLimitMonth')}</li>
                  <li>{t('maxFileSize')} 250MB</li>
                  <li>Quiz 20 {t('questions')}</li>
                  <li>{t('aiAdvancedAnswers')}</li>
                  <li>{t('save17Percent')}</li>
                </ul>
                <p className="font-bold text-gray-800 text-lg mb-6">{currencySymbol}{prices.PREMIUM_ANNUAL} / {t('year')}</p>
                <button 
                  onClick={() => handleCheckout(PRICE_IDS.PREMIUM_ANNUAL)}
                  disabled={isLoading(PRICE_IDS.PREMIUM_ANNUAL)}
                  className={`w-full py-3 px-4 rounded-lg border font-medium 
                    ${isLoading(PRICE_IDS.PREMIUM_ANNUAL)
                      ? 'bg-yellow-300 cursor-not-allowed text-white'
                      : 'text-yellow-500 border-yellow-500 hover:bg-yellow-500 hover:text-white'}`}
                >
                  {isLoading(PRICE_IDS.PREMIUM_ANNUAL) ? t('processing') : t('choosePremiumAnnual')}
                </button>
              </div>
            </div>
          </div>
        )}
        
        <div className="mt-10 sm:mt-12 text-center text-ink-soft">
          <p className="mb-3 sm:mb-4 text-sm sm:text-base">{t('allPlansInclude')}</p>
          <div className="flex flex-wrap justify-center gap-2 sm:gap-3 text-xs sm:text-sm">
            <span className="bg-gray-100 px-2 py-1 sm:px-3 sm:py-1 rounded-full">{t('aiSummary')}</span>
            <span className="bg-gray-100 px-2 py-1 sm:px-3 sm:py-1 rounded-full">{t('exportPdfWord')}</span>
            <span className="bg-gray-100 px-2 py-1 sm:px-3 sm:py-1 rounded-full">{t('technicalSupport')}</span>
            <span className="bg-gray-100 px-2 py-1 sm:px-3 sm:py-1 rounded-full">{t('freeUpdates')}</span>
          </div>
          <p className="mt-4 text-xs text-ink-faint">{t('pricesInEuro')}</p>
        </div>
      </div>
    </div>
  );
}