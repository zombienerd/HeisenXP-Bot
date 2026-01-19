// src/index.js
require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  PermissionFlagsBits,
  MessageFlags,
  AttachmentBuilder,
} = require("discord.js");

const {
  getGuildSettings,
  updateGuildSettings,
  addXp,
  getXp,
  topUsers,
  logActivity,
  listAllowedCommandChannels,
  addAllowedCommandChannel,
  removeAllowedCommandChannel,
  listLevelRoles,
  upsertLevelRole,
  deleteLevelRole,
} = require("./db");

const { levelFromXp } = require("./xp");
const { syncMemberRoles } = require("./roles");
const { startDecayScheduler } = require("./decay");
const { startVoiceTicker } = require("./voiceTicker");
const { renderLeaderboardPng } = require("./renderLeaderboard");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// Cooldowns (per guild/user)
const msgCooldown = new Map();
const reactionCooldown = new Map();

function cooldownOk(map, key, seconds) {
  const now = Date.now();
  const last = map.get(key) ?? 0;
  if (now - last < seconds * 1000) return false;
  map.set(key, now);
  return true;
}

function isAdminOrMod(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function commandsAllowed(interaction) {
  const rows = listAllowedCommandChannels(interaction.guild.id);
  if (!rows.length) return true; // none configured => allowed everywhere
  const allowed = new Set(rows.map(r => r.channel_id));
  return allowed.has(interaction.channelId);
}

async function awardAndSync(member, delta, activityKind, settings) {
  const guildId = member.guild.id;
  const userId = member.id;

  const newXp = addXp(guildId, userId, delta);
  logActivity(guildId, userId, activityKind, 1);

  const lvl = levelFromXp(newXp, settings.level_xp_factor);
  await syncMemberRoles(member, lvl);

  return { xp: newXp, level: lvl };
}

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  startDecayScheduler(client);
  startVoiceTicker(client);
});

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild) return;
  if (message.author.bot) return;

  const settings = getGuildSettings(message.guild.id);

  const key = `${message.guild.id}:${message.author.id}`;
  if (!cooldownOk(msgCooldown, key, settings.msg_cooldown_sec)) return;

  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  await awardAndSync(member, settings.msg_xp, "message", settings);
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (!reaction.message.guild) return;
  if (user.bot) return;

  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }

  const guild = reaction.message.guild;
  const settings = getGuildSettings(guild.id);

  // per-guild reaction cooldown
  const key = `${guild.id}:${user.id}`;
  if (!cooldownOk(reactionCooldown, key, settings.reaction_cooldown_sec)) return;

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  await awardAndSync(member, settings.reaction_xp, "reaction", settings);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  if (!commandsAllowed(interaction)) {
    await interaction.reply({ content: "Commands aren’t enabled in this channel.", flags: MessageFlags.Ephemeral });
    return;
  }

  const guildId = interaction.guild.id;
  const settings = getGuildSettings(guildId);

  // ---------------- Public leaderboard image (Top 10 only) ----------------
  if (interaction.commandName === "leaderboard") {
    // Always top 10
    const rows = topUsers(guildId, 10);

    if (!rows.length) {
      await interaction.reply({ content: "No leaderboard data yet.", flags: MessageFlags.Ephemeral });
      return;
    }

    // Fetch members in one go; fall back to ID if missing
    const ids = rows.map(r => r.user_id);
    let members = null;
    try {
      members = await interaction.guild.members.fetch({ user: ids });
    } catch {
      members = null;
    }

    const entries = rows.map((r, idx) => {
      const m = members?.get?.(r.user_id);
      const name = m?.displayName || m?.user?.username || `User ${r.user_id}`;
      const lvl = levelFromXp(r.xp, settings.level_xp_factor);
      return { rank: idx + 1, name, xp: r.xp, level: lvl };
    });

    const png = renderLeaderboardPng(entries);
    const file = new AttachmentBuilder(png, { name: "heisenxp-leaderboard.png" });

    await interaction.reply({
      content: "**Leaderboard:**",
                            files: [file],
    });
    return;
  }

  // ---------------- XP (ephemeral) ----------------
  if (interaction.commandName === "xp") {
    const target = interaction.options.getUser("user") ?? interaction.user;
    const xp = getXp(guildId, target.id);
    const lvl = levelFromXp(xp, settings.level_xp_factor);

    await interaction.reply({
      content: `${target.username}: **${xp} XP** (Level **${lvl}**)`,
                            flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // ---------------- Settings overview (ephemeral, admin) ----------------
  if (interaction.commandName === "settings") {
    if (!isAdminOrMod(interaction)) {
      await interaction.reply({ content: "You don’t have permission to use this.", flags: MessageFlags.Ephemeral });
      return;
    }

    const chans = listAllowedCommandChannels(guildId);
    const chanText = chans.length ? chans.map(r => `<#${r.channel_id}>`).join(", ") : "All channels (no restriction set)";

    const roles = listLevelRoles(guildId);
    const roleText = roles.length
    ? roles.map(r => `<@&${r.role_id}> @ Lvl ${r.level_required} (drop after ${r.drop_grace_days}d)`).join("\n")
    : "(none configured)";

    await interaction.reply({
      content:
      `**HeisenXP-Bot Settings**\n` +
      `**XP:** msg=${settings.msg_xp}, reaction=${settings.reaction_xp}, voice/min=${settings.voice_xp_per_min}\n` +
      `**Cooldowns:** msg=${settings.msg_cooldown_sec}s, reaction=${settings.reaction_cooldown_sec}s\n` +
      `**Decay:** enabled=${!!settings.decay_enabled}, threshold=${settings.decay_min_messages} msgs / ${settings.decay_window_days} days, percent=${Math.round(settings.decay_percent * 100)}%\n` +
      `**Level curve factor:** ${settings.level_xp_factor} (XP needed = level² × factor)\n` +
      `**Commands allowed in:** ${chanText}\n` +
      `**Level→Role mappings:**\n${roleText}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // ---------------- Admin/mod commands ----------------
  if (interaction.commandName === "setxp") {
    if (!isAdminOrMod(interaction)) {
      await interaction.reply({ content: "You don’t have permission to use this.", flags: MessageFlags.Ephemeral });
      return;
    }

    const msg = interaction.options.getInteger("message");
    const reaction = interaction.options.getInteger("reaction");
    const voice = interaction.options.getInteger("voice");
    const msgcooldown = interaction.options.getInteger("msgcooldown");
    const reactioncooldown = interaction.options.getInteger("reactioncooldown");

    const patch = {};
    if (msg !== null) patch.msg_xp = msg;
    if (reaction !== null) patch.reaction_xp = reaction;
    if (voice !== null) patch.voice_xp_per_min = voice;
    if (msgcooldown !== null) patch.msg_cooldown_sec = msgcooldown;
    if (reactioncooldown !== null) patch.reaction_cooldown_sec = reactioncooldown;

    const updated = updateGuildSettings(guildId, patch);

    await interaction.reply({
      content:
      `Updated XP settings:\n` +
      `- msg_xp: **${updated.msg_xp}**\n` +
      `- reaction_xp: **${updated.reaction_xp}**\n` +
      `- voice_xp_per_min: **${updated.voice_xp_per_min}**\n` +
      `- msg_cooldown_sec: **${updated.msg_cooldown_sec}**\n` +
      `- reaction_cooldown_sec: **${updated.reaction_cooldown_sec}**`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "setdecay") {
    if (!isAdminOrMod(interaction)) {
      await interaction.reply({ content: "You don’t have permission to use this.", flags: MessageFlags.Ephemeral });
      return;
    }

    const enabled = interaction.options.getBoolean("enabled");
    const messages = interaction.options.getInteger("messages");
    const days = interaction.options.getInteger("days");
    const percent = interaction.options.getNumber("percent"); // 0..95

    const patch = {};
    if (enabled !== null) patch.decay_enabled = enabled ? 1 : 0;
    if (messages !== null) patch.decay_min_messages = messages;
    if (days !== null) patch.decay_window_days = days;
    if (percent !== null) patch.decay_percent = Math.max(0, Math.min(0.95, percent / 100));

    const updated = updateGuildSettings(guildId, patch);

    await interaction.reply({
      content:
      `Updated decay:\n` +
      `- enabled: **${!!updated.decay_enabled}**\n` +
      `- threshold: **${updated.decay_min_messages} messages / ${updated.decay_window_days} days**\n` +
      `- decay: **${Math.round(updated.decay_percent * 100)}%**`,
                            flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "leveltorole") {
    if (!isAdminOrMod(interaction)) {
      await interaction.reply({ content: "You don’t have permission to use this.", flags: MessageFlags.Ephemeral });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "set") {
      const role = interaction.options.getRole("role", true);
      const level = interaction.options.getInteger("level", true);
      const dropdays = interaction.options.getInteger("dropdays", true);

      upsertLevelRole(guildId, role.id, level, dropdays);

      await interaction.reply({
        content: `Mapped role <@&${role.id}> to **Level ${level}** with **${dropdays}** day(s) grace before removal.`,
                              flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "remove") {
      const role = interaction.options.getRole("role", true);
      deleteLevelRole(guildId, role.id);
      await interaction.reply({ content: `Removed mapping for <@&${role.id}>.`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === "list") {
      const rows = listLevelRoles(guildId);
      if (!rows.length) {
        await interaction.reply({ content: "No level→role mappings configured.", flags: MessageFlags.Ephemeral });
        return;
      }
      const lines = rows.map(r => `- <@&${r.role_id}>: Level **${r.level_required}** (remove after **${r.drop_grace_days}** day(s) below)`);
      await interaction.reply({ content: `**Level→Role mappings:**\n${lines.join("\n")}`, flags: MessageFlags.Ephemeral });
      return;
    }
  }

  if (interaction.commandName === "setcommandchannel") {
    if (!isAdminOrMod(interaction)) {
      await interaction.reply({ content: "You don’t have permission to use this.", flags: MessageFlags.Ephemeral });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "add") {
      const ch = interaction.options.getChannel("channel", true);
      addAllowedCommandChannel(guildId, ch.id);
      await interaction.reply({
        content: `Commands are now allowed in <#${ch.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "remove") {
      const ch = interaction.options.getChannel("channel", true);
      removeAllowedCommandChannel(guildId, ch.id);
      await interaction.reply({
        content: `Removed <#${ch.id}> from allowed command channels.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "list") {
      const rows = listAllowedCommandChannels(guildId);
      if (!rows.length) {
        await interaction.reply({
          content: "No allowed channels configured — commands are allowed in all channels.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const lines = rows.map(r => `- <#${r.channel_id}>`);
      await interaction.reply({
        content: `**Allowed command channels:**\n${lines.join("\n")}`,
                              flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
