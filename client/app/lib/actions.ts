// lib/actions.ts
'use server';

import prisma from '@/lib/prisma';
import bcrypt from 'bcrypt';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/authOptions';

export async function updateProfile(data: { name: string; email: string }) {
  const session = await getServerSession(authOptions);
  
  if (!session) {
    return { error: 'Nu sunteți autentificat' };
  }

  try {
    // Check if email is being changed to an existing email
    if (data.email !== session.user.email) {
      const existingUser = await prisma.user.findUnique({
        where: { email: data.email },
      });
      
      if (existingUser) {
        return { error: 'Această adresă de email este deja folosită' };
      }
    }

    // Update user
    await prisma.user.update({
      where: { id: session.user.id },
      data: {
        name: data.name,
        email: data.email,
      },
    });

    return { success: true };
  } catch (error) {
    console.error('Update profile error:', error);
    return { error: 'Eroare la actualizarea profilului' };
  }
}

export async function changePassword(data: { 
  currentPassword: string; 
  newPassword: string 
}) {
  const session = await getServerSession(authOptions);
  
  if (!session) {
    return { error: 'Nu sunteți autentificat' };
  }

  try {
    // Get user with password
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
    });

    if (!user) {
      return { error: 'Utilizatorul nu a fost găsit' };
    }

    // Verify current password
    const passwordValid = await bcrypt.compare(
      data.currentPassword,
      user.password
    );

    if (!passwordValid) {
      return { error: 'Parola actuală este incorectă' };
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(data.newPassword, 10);

    // Update password
    await prisma.user.update({
      where: { id: session.user.id },
      data: { password: hashedPassword },
    });

    return { success: true };
  } catch (error) {
    console.error('Change password error:', error);
    return { error: 'Eroare la schimbarea parolei' };
  }
}