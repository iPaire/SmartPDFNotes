import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface User {
    id: string;
    role?: string | null;
    subscription?: string | null;
    trialOffered?: boolean | null;
    trialExpires?: string | null;
  }

  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      role?: string | null;
      subscription?: string | null;
      trialOffered?: boolean | null;
      trialExpires?: string | null;
      stripeCustomerId?: string | null;
      createdAt?: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role?: string | null;
    subscription?: string | null;
    trialOffered?: boolean | null;
    trialExpires?: string | null;
  }
}
