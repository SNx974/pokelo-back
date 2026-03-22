require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Admin
  const adminPass = await bcrypt.hash('Admin1234!', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@pokelo.gg' },
    update: {},
    create: {
      username: 'PokeloAdmin',
      email: 'admin@pokelo.gg',
      passwordHash: adminPass,
      role: 'ADMIN',
      eloGlobal: 2000,
      elo2v2: 2000,
      elo5v5: 2000,
      region: 'EU',
    },
  });
  console.log(`✅ Admin: ${admin.username}`);

  // Sample players
  const players = [
    { username: 'AshKetchum', email: 'ash@pokelo.gg', elo: 1800, elo2v2: 1750, elo5v5: 1820, wins: 45, losses: 12 },
    { username: 'MistyWaterflower', email: 'misty@pokelo.gg', elo: 1650, elo2v2: 1700, elo5v5: 1600, wins: 38, losses: 20 },
    { username: 'BrockStone', email: 'brock@pokelo.gg', elo: 1500, elo2v2: 1480, elo5v5: 1520, wins: 30, losses: 25 },
    { username: 'GaryOak', email: 'gary@pokelo.gg', elo: 1950, elo2v2: 1900, elo5v5: 1980, wins: 60, losses: 8 },
    { username: 'MayBreeder', email: 'may@pokelo.gg', elo: 1350, elo2v2: 1320, elo5v5: 1380, wins: 22, losses: 30 },
    { username: 'LucasSnow', email: 'lucas@pokelo.gg', elo: 1100, elo2v2: 1050, elo5v5: 1150, wins: 15, losses: 35 },
    { username: 'IrisDragon', email: 'iris@pokelo.gg', elo: 1700, elo2v2: 1720, elo5v5: 1680, wins: 42, losses: 18 },
    { username: 'ClemonResearch', email: 'clement@pokelo.gg', elo: 1250, elo2v2: 1200, elo5v5: 1300, wins: 18, losses: 28 },
    { username: 'SerenaStyle', email: 'serena@pokelo.gg', elo: 1580, elo2v2: 1550, elo5v5: 1610, wins: 35, losses: 22 },
    { username: 'SawyerRival', email: 'sawyer@pokelo.gg', elo: 1420, elo2v2: 1400, elo5v5: 1440, wins: 28, losses: 27 },
  ];

  const userPass = await bcrypt.hash('Player1234!', 12);
  const createdUsers = [];

  for (const p of players) {
    const user = await prisma.user.upsert({
      where: { email: p.email },
      update: {},
      create: {
        username: p.username,
        email: p.email,
        passwordHash: userPass,
        eloGlobal: p.elo,
        elo2v2: p.elo2v2,
        elo5v5: p.elo5v5,
        wins: p.wins,
        losses: p.losses,
        totalMatches: p.wins + p.losses,
        region: ['EU', 'NA', 'ASIA'][Math.floor(Math.random() * 3)],
      },
    });
    createdUsers.push(user);
    console.log(`✅ Player: ${user.username} (Elo: ${user.eloGlobal})`);
  }

  // Team 1
  const team1 = await prisma.team.upsert({
    where: { name: 'Team Rocket Elite' },
    update: {},
    create: {
      name: 'Team Rocket Elite',
      tag: 'TRE',
      description: 'Les meilleurs vilains du circuit compétitif.',
      eloTeam: 1850,
      wins: 30,
      losses: 5,
      region: 'EU',
    },
  });

  await prisma.teamMember.upsert({
    where: { userId_teamId: { userId: createdUsers[0].id, teamId: team1.id } },
    update: {},
    create: { userId: createdUsers[0].id, teamId: team1.id, role: 'CAPTAIN' },
  });
  await prisma.teamMember.upsert({
    where: { userId_teamId: { userId: createdUsers[1].id, teamId: team1.id } },
    update: {},
    create: { userId: createdUsers[1].id, teamId: team1.id, role: 'MEMBER' },
  });
  console.log(`✅ Team: ${team1.name}`);

  // Team 2
  const team2 = await prisma.team.upsert({
    where: { name: 'Dragon Masters' },
    update: {},
    create: {
      name: 'Dragon Masters',
      tag: 'DM',
      description: 'Dragons uniquement. Les autres passez votre chemin.',
      eloTeam: 1620,
      wins: 20,
      losses: 12,
      region: 'EU',
    },
  });

  await prisma.teamMember.upsert({
    where: { userId_teamId: { userId: createdUsers[6].id, teamId: team2.id } },
    update: {},
    create: { userId: createdUsers[6].id, teamId: team2.id, role: 'CAPTAIN' },
  });

  // News
  await prisma.news.createMany({
    data: [
      {
        title: 'Bienvenue sur Pokélo !',
        content: 'La plateforme compétitive Pokémon est maintenant en ligne. Inscrivez-vous et commencez à grimper le ladder !',
        isPinned: true,
        isPublished: true,
        authorId: admin.id,
      },
      {
        title: 'Saison 1 — Classement ouvert',
        content: 'La Saison 1 est officiellement lancée. Les 10 premiers joueurs au ladder recevront un badge exclusif.',
        isPinned: false,
        isPublished: true,
        authorId: admin.id,
      },
      {
        title: 'Tournoi 2v2 — Inscriptions ouvertes',
        content: 'Le premier tournoi officiel 2v2 de Pokélo débute bientôt. Inscrivez votre équipe dès maintenant !',
        isPinned: false,
        isPublished: true,
        authorId: admin.id,
      },
    ],
    skipDuplicates: true,
  });
  console.log('✅ News créées');

  // Tournament
  await prisma.tournament.upsert({
    where: { id: 'tournament-season-1' },
    update: {},
    create: {
      id: 'tournament-season-1',
      name: 'Pokélo Championship S1',
      description: 'Premier championnat officiel Pokélo. 8 équipes, mode 5v5.',
      mode: 'FIVE_V_FIVE',
      maxTeams: 8,
      prizePool: '500€',
      status: 'UPCOMING',
      startDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  console.log('✅ Tournoi créé');

  console.log('\n🎉 Seed terminé !');
  console.log('Admin: admin@pokelo.gg / Admin1234!');
  console.log('Joueurs: ash@pokelo.gg / Player1234! (et autres)');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
