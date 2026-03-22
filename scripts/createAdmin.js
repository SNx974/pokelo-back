/**
 * Script de création/mise à jour du compte admin principal.
 * Usage: node scripts/createAdmin.js
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const email    = 'pokélo@gmail.com';
  const password = 'Lolilol974';
  const username = 'Pokélo';

  const hash = await bcrypt.hash(password, 12);

  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: hash, role: 'ADMIN' },
    create: {
      username,
      email,
      passwordHash: hash,
      role: 'ADMIN',
      eloGlobal: 2000,
      elo2v2: 2000,
      elo5v5: 2000,
      region: 'EU',
    },
  });

  console.log(`✅ Compte admin créé/mis à jour :`);
  console.log(`   Email    : ${user.email}`);
  console.log(`   Username : ${user.username}`);
  console.log(`   Rôle     : ${user.role}`);
  console.log(`   Password : ${password}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
