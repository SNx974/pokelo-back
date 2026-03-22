/**
 * Pokélo — Elo Service
 * Système Elo compétitif inspiré des jeux esport modernes
 */

const MIN_ELO = 100;
const MAX_ELO = 3000;

/**
 * K-Factor dynamique basé sur l'Elo et le nombre de matchs joués.
 * Plus un joueur est nouveau ou bas Elo → K plus élevé (progression rapide).
 * Plus un joueur est expérimenté ou haut Elo → K plus faible (stabilité).
 */
function getKFactor(elo, totalMatches) {
  if (totalMatches < 10) return 40; // Placement phase
  if (elo < 1200) return 32;
  if (elo < 1600) return 24;
  if (elo < 2000) return 20;
  return 16; // Grand Master
}

/**
 * Calcule la probabilité de victoire attendue d'un joueur A contre un joueur B.
 */
function expectedScore(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

/**
 * Calcule le changement d'Elo pour un match 1v1 ou un participant dans un match d'équipe.
 * @param {number} playerElo - Elo du joueur
 * @param {number} opponentElo - Elo moyen de l'adversaire
 * @param {boolean} won - Le joueur a-t-il gagné ?
 * @param {number} totalMatches - Nombre total de matchs joués
 * @returns {{ change: number, newElo: number }}
 */
function calculateEloChange(playerElo, opponentElo, won, totalMatches) {
  const k = getKFactor(playerElo, totalMatches);
  const expected = expectedScore(playerElo, opponentElo);
  const actual = won ? 1 : 0;

  const change = Math.round(k * (actual - expected));
  const newElo = Math.max(MIN_ELO, Math.min(MAX_ELO, playerElo + change));

  return { change: newElo - playerElo, newElo };
}

/**
 * Calcule les changements Elo pour tous les participants d'un match d'équipe.
 * @param {Array} team1 - [{ userId, elo, totalMatches }]
 * @param {Array} team2 - [{ userId, elo, totalMatches }]
 * @param {number} winnerTeam - 1 ou 2
 * @param {string} mode - 'TWO_V_TWO' | 'FIVE_V_FIVE'
 * @returns {Array} - [{ userId, eloBefore, eloAfter, change, isWinner }]
 */
function calculateMatchElo(team1, team2, winnerTeam, mode) {
  const avgElo1 = team1.reduce((s, p) => s + p.elo, 0) / team1.length;
  const avgElo2 = team2.reduce((s, p) => s + p.elo, 0) / team2.length;

  const results = [];

  const processTeam = (team, teamNum, opponentAvgElo) => {
    const won = teamNum === winnerTeam;
    for (const player of team) {
      const { change, newElo } = calculateEloChange(
        player.elo,
        opponentAvgElo,
        won,
        player.totalMatches,
      );
      results.push({
        userId: player.userId,
        eloBefore: player.elo,
        eloAfter: newElo,
        change,
        isWinner: won,
        team: teamNum,
      });
    }
  };

  processTeam(team1, 1, avgElo2);
  processTeam(team2, 2, avgElo1);

  return results;
}

/**
 * Retourne le rang Pokémon basé sur l'Elo.
 */
function getRank(elo) {
  if (elo < 900)  return { name: 'Rookie',      icon: '🥚', color: '#9E9E9E' };
  if (elo < 1100) return { name: 'Novice',       icon: '🐢', color: '#4CAF50' };
  if (elo < 1300) return { name: 'Pokéfan',      icon: '⚡', color: '#FFC107' };
  if (elo < 1500) return { name: 'Entraîneur',   icon: '🔥', color: '#FF9800' };
  if (elo < 1700) return { name: 'Expert',        icon: '💎', color: '#2196F3' };
  if (elo < 1900) return { name: 'Master',        icon: '🌟', color: '#9C27B0' };
  if (elo < 2100) return { name: 'Champion',      icon: '👑', color: '#FFCB05' };
  if (elo < 2300) return { name: 'Grand Master',  icon: '🏆', color: '#F44336' };
  return              { name: 'Légende',          icon: '🌌', color: '#E91E63' };
}

/**
 * Calcule le winrate d'un joueur.
 */
function calcWinrate(wins, losses) {
  const total = wins + losses;
  if (total === 0) return 0;
  return Math.round((wins / total) * 100 * 10) / 10;
}

module.exports = { calculateEloChange, calculateMatchElo, getRank, calcWinrate, getKFactor, expectedScore };
