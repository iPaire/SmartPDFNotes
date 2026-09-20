// app/api/settings/billing/route.ts
import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { stripe } from '@/lib/stripe';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/authOptions';
import prisma from '@/lib/prisma';

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!stripe) {
      return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 });
    }

    const customerId = req.nextUrl.searchParams.get('customerId');
    if (!customerId) {
      return NextResponse.json({ error: 'Customer ID is required' }, { status: 400 });
    }

    // Verifică dacă customerId se potrivește cu utilizatorul autentificat
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { stripeCustomerId: true, subscription: true }
    });

    if (!user || user.stripeCustomerId !== customerId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    // Get subscription
    let subscription = null;
    try {
      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 1,
        expand: ['data.items.data.price']
      });

      subscription = subscriptions.data[0] || null;
    } catch (error) {
      console.error('Error fetching Stripe subscription:', error);
    }

    // Get invoices
    let invoices: Stripe.Invoice[] = [];
    try {
      const invoiceResponse = await stripe.invoices.list({
        customer: customerId,
        limit: 12,
      });
      invoices = invoiceResponse.data;
    } catch (error) {
      console.error('Error fetching Stripe invoices:', error);
    }

    return NextResponse.json({ 
      subscription,
      invoices
    });
  } catch (error) {
    console.error('Error fetching billing data:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}