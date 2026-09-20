import "react";
// Global type declarations

declare global {
  interface Window {
    gtag: (
      command: 'config' | 'event' | 'js',
      targetId: string | Date,
      config?: {
        page_path?: string;
        event_category?: string;
        event_label?: string;
        value?: number;
        send_to?: string;
        user_properties?: Record<string, string | number>;
        transaction_id?: string;
        currency?: string;
        items?: Array<{
          item_id: string;
          item_name: string;
          category: string;
          quantity: number;
          price: number;
        }>;
        anonymize_ip?: boolean;
        allow_google_signals?: boolean;
        allow_ad_personalization_signals?: boolean;
      }
    ) => void;
  }
}

export {};

// Enable the styled-jsx `<style jsx global>` attributes on <style>
declare module "react" {
  interface StyleHTMLAttributes<T> extends HTMLAttributes<T> {
    jsx?: boolean;
    global?: boolean;
  }
}
