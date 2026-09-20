// Server-side analytics logging utility
// This helps track conversions even when client-side tracking fails

import { Prisma } from '@prisma/client';
import prisma from './prisma';

export interface AnalyticsEvent {
  userId?: string;
  eventType: string;
  eventCategory: string;
  eventLabel?: string;
  eventValue?: number;
  metadata?: Prisma.InputJsonObject;
}

export async function logAnalyticsEvent(event: AnalyticsEvent) {
  try {
    // Log to database for backup analytics
    const logEntry = await prisma.analyticsLog.create({
      data: {
        userId: event.userId,
        eventType: event.eventType,
        eventCategory: event.eventCategory,
        eventLabel: event.eventLabel,
        eventValue: event.eventValue,
        metadata: event.metadata || {},
        timestamp: new Date(),
      },
    });

    console.log('Analytics event logged:', {
      id: logEntry.id,
      type: event.eventType,
      category: event.eventCategory,
    });

    return logEntry;
  } catch (error) {
    console.error('Failed to log analytics event:', error);
    // Don't throw - analytics failures shouldn't break the app
    return null;
  }
}

// Helper functions for common events
export async function logPurchaseClick(userId: string, plan: string, price: number) {
  return logAnalyticsEvent({
    userId,
    eventType: 'purchase_button_click',
    eventCategory: 'ecommerce',
    eventLabel: plan,
    eventValue: price,
    metadata: { plan, price },
  });
}

export async function logPurchaseCompleted(
  userId: string,
  plan: string,
  price: number,
  transactionId: string,
  currency: string
) {
  return logAnalyticsEvent({
    userId,
    eventType: 'purchase_completed',
    eventCategory: 'ecommerce',
    eventLabel: plan,
    eventValue: price,
    metadata: {
      plan,
      price,
      transactionId,
      currency,
      timestamp: new Date().toISOString(),
    },
  });
}

export async function logCheckoutAbandoned(userId: string, plan?: string) {
  return logAnalyticsEvent({
    userId,
    eventType: 'checkout_abandoned',
    eventCategory: 'ecommerce',
    eventLabel: plan || 'unknown',
    metadata: { plan },
  });
}

// Get analytics summary
export async function getAnalyticsSummary(startDate?: Date, endDate?: Date) {
  try {
    const whereClause: Prisma.AnalyticsLogWhereInput = {};

    if (startDate || endDate) {
      whereClause.timestamp = {};
      if (startDate) whereClause.timestamp.gte = startDate;
      if (endDate) whereClause.timestamp.lte = endDate;
    }

    const [totalClicks, totalPurchases, totalRevenue] = await Promise.all([
      // Total purchase button clicks
      prisma.analyticsLog.count({
        where: {
          ...whereClause,
          eventType: 'purchase_button_click',
        },
      }),

      // Total completed purchases
      prisma.analyticsLog.count({
        where: {
          ...whereClause,
          eventType: 'purchase_completed',
        },
      }),

      // Total revenue
      prisma.analyticsLog.aggregate({
        where: {
          ...whereClause,
          eventType: 'purchase_completed',
        },
        _sum: {
          eventValue: true,
        },
      }),
    ]);

    // Get breakdown by plan
    const purchasesByPlan = await prisma.analyticsLog.groupBy({
      by: ['eventLabel'],
      where: {
        ...whereClause,
        eventType: 'purchase_completed',
      },
      _count: {
        id: true,
      },
      _sum: {
        eventValue: true,
      },
    });

    const conversionRate = totalClicks > 0
      ? ((totalPurchases / totalClicks) * 100).toFixed(2)
      : '0.00';

    return {
      summary: {
        totalClicks,
        totalPurchases,
        totalRevenue: totalRevenue._sum.eventValue || 0,
        conversionRate: `${conversionRate}%`,
      },
      byPlan: purchasesByPlan.map(plan => ({
        plan: plan.eventLabel || 'unknown',
        purchases: plan._count.id,
        revenue: plan._sum.eventValue || 0,
      })),
    };
  } catch (error) {
    console.error('Failed to get analytics summary:', error);
    throw error;
  }
}
