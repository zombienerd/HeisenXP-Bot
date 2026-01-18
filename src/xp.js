function levelFromXp(xp, levelXpFactor) {
  const factor = Math.max(1, Number(levelXpFactor) || 100);
  return Math.floor(Math.sqrt(Math.max(0, xp) / factor));
}

module.exports = { levelFromXp };
