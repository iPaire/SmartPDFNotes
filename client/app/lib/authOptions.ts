import type { AuthOptions, SessionStrategy } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import bcrypt from 'bcrypt';
import prisma from './prisma';

export const authOptions: AuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" }
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const user = await prisma.user.findUnique({
          where: { email: credentials.email }
        });

        if (!user || !user.password) return null;

        const passwordValid = await bcrypt.compare(
          credentials.password,
          user.password
        );

        if (!passwordValid) return null;

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role || null,
          subscription: user.subscription || null,
          image: user.image || null,
          trialOffered: user.trialOffered || false,
          trialExpires: user.trialExpires?.toISOString() ?? null
        };
      }
    }),
    // Google sign-in is optional: enabled only when its credentials are set
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [
          GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          }),
        ]
      : []),
  ],

  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider === "google") {
        // user.email vine de la Google
        if (!user.email) return false;

        // Caută user-ul în DB după email
        let dbUser = await prisma.user.findUnique({
          where: { email: user.email }
        });

        if (!dbUser) {
          // Dacă nu există, creează unul nou
          dbUser = await prisma.user.create({
            data: {
              email: user.email,
              name: user.name || user.email.split("@")[0],
              role: "personal",
              subscription: "free",
              image: user.image,
              trialOffered: false,
              trialExpires: null,
              password: "", // Poți să pui un string gol pentru că nu se folosește parola în OAuth
            }
          });
        }

        // Modificăm user-ul din NextAuth cu datele din DB
        user.id = dbUser.id;
        user.role = dbUser.role;
        user.subscription = dbUser.subscription;
        user.trialOffered = dbUser.trialOffered;
        user.trialExpires = dbUser.trialExpires?.toISOString() ?? null;
      }
      return true;
    },

    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
        token.subscription = user.subscription;
        token.trialOffered = user.trialOffered;
        token.trialExpires = user.trialExpires;
      }

      if ((token.subscription === 'trial' || token.subscription === 'premium') && token.trialExpires) {
        const now = new Date();
        const trialExpires = new Date(token.trialExpires);

        if (now > trialExpires) {
          // Premium users keep their subscription after trial, trial users become free
          const newSubscription = token.subscription === 'premium' ? 'premium' : 'free';
          await prisma.user.update({
            where: { id: token.id as string },
            data: {
              subscription: newSubscription,
              trialExpires: null
            }
          });
          token.subscription = newSubscription;
          token.trialExpires = null;
        }
      }

      return token;
    },

    async session({ session, token }) {
      if (token.id) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: {
            id: true,
            role: true,
            subscription: true,
            name: true,
            email: true,
            image: true,
            trialOffered: true,
            trialExpires: true,
            stripeCustomerId: true,
            createdAt: true
          }
        });

        if (dbUser) {
          session.user = {
            ...session.user,
            ...dbUser,
            trialExpires: dbUser.trialExpires?.toISOString() ?? null,
            createdAt: dbUser.createdAt?.toISOString() ?? null
          };
        }
      }
      return session;
    },

    async redirect({ url, baseUrl }) {
      // Dacă URL-ul este relativ, fă-l absolut
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      // Dacă URL-ul este pe același domeniu, permite-l
      if (new URL(url).origin === baseUrl) return url;
      // Altfel, redirect la baseUrl
      return baseUrl;
    }
  },

  pages: {
    signIn: '/login',
  },

  secret: process.env.NEXTAUTH_SECRET!,
  session: {
    strategy: "jwt" as SessionStrategy,
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  events: {
    async signOut({ token }) {
      console.log('User signed out:', token);
    }
  },
  cookies: {
    sessionToken: {
      name: process.env.NODE_ENV === 'production' ? '__Secure-next-auth.session-token' : 'next-auth.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production'
      }
    }
  }
};
