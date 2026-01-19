// src/index.js
require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  MessageFlags,
  AttachmentBuilder,
  PermissionFlagsBits,
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
} = require("./db");

const { renderLeaderboardPng } = require("./renderLeaderboard");

const MAX_XP_AWARD = 1_000_000_000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

function isAdminOrMod(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function commandsAllowed(interaction) {
  const rows = listAllowedCommandChannels(interaction.guildId);
  if (!rows.length) return true; // no restriction configured
  return rows.some(r => r.channel_id === interaction.channelId);
}

function validateXpValue(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) {
    return `${label} XP must be a finite non-negative number.`;
  }
  if (value > MAX_XP_AWARD) {
    return `${label} XP value too large. Maximum value per ${label.toLowerCase()} is ${MAX_XP_AWARD.toLocaleString()}.`;
  }
  return null;
}

client.once(Events.ClientReady, () => {
  console.log(`HeisenXP-Bot logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  try {
    if (!commandsAllowed(interaction)) {
      await interaction.reply({
        content: "Commands aren’t enabled in this channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildId = interaction.guildId;
    const settings = getGuildSettings(guildId);

    // ---------------- /xp (ephemeral) ----------------
    if (interaction.commandName === "xp") {
      const target = interaction.options.getUser("user") ?? interaction.user;
      const xp = getXp(guildId, target.id);

      // Level curve: level = floor(sqrt(xp/factor))
      const factor = Math.max(1, settings.level_xp_factor);
      const level = Math.floor(Math.sqrt(xp / factor));

      await interaction.reply({
        content: `${target.username}: **${xp} XP** (Level **${level}**)`,
                              flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // ---------------- /leaderboard (public PNG) ----------------
    if (interaction.commandName === "leaderboard") {
      const rows = topUsers(guildId, 10);
      if (!rows.length) {
        await interaction.reply({
          content: "No leaderboard data yet.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Fetch members once; if it fails, fall back to IDs
      let members = null;
      try {
        members = await interaction.guild.members.fetch({ user: rows.map(r => r.user_id) });
      } catch {
        members = null;
      }

      const factor = Math.max(1, settings.level_xp_factor);

      const entries = rows.map((r, idx) => {
        const m = members?.get?.(r.user_id);
        const name = m?.displayName || m?.user?.username || `User ${r.user_id}`;
        const level = Math.floor(Math.sqrt(r.xp / factor));
        return { rank: idx + 1, name, xp: r.xp, level };
      });

      const png = renderLeaderboardPng(entries, factor);
      const file = new AttachmentBuilder(png, { name: "heisenxp-leaderboard.png" });

      await interaction.reply({
        content: "**Leaderboard (Top 10)**",
                              files: [file],
      });
      return;
    }

    // ---------------- /settings (admin-only, ephemeral) ----------------
    if (interaction.commandName === "settings") {
      if (!isAdminOrMod(interaction)) {
        await interaction.reply({
          content: "You don’t have permission to use this.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const chans = listAllowedCommandChannels(guildId);
      const chanText = chans.length
      ? chans.map(r => `<#${r.channel_id}>`).join(", ")
      : "All channels (no restriction set)";

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
        `**Level curve factor:** ${settings.level_xp_factor} (Level L starts at L²×factor)\n` +
        `**Commands allowed in:** ${chanText}\n` +
        `**Level→Role mappings:**\n${roleText}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // ---------------- /setxp (admin-only, ephemeral; with max validation) ----------------
    if (interaction.commandName === "setxp") {
      if (!isAdminOrMod(interaction)) {
        await interaction.reply({
          content: "You don’t have permission to use this.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const msg = interaction.options.getInteger("message");
      const reaction = interaction.options.getInteger("reaction");
      const voice = interaction.options.getInteger("voice");
      const msgcooldown = interaction.options.getInteger("msgcooldown");
      const reactioncooldown = interaction.options.getInteger("reactioncooldown");

      const errors = [
        validateXpValue(msg, "Message"),
          validateXpValue(reaction, "Reaction"),
          validateXpValue(voice, "Voice"),
      ].filter(Boolean);

      if (errors.length) {
        await interaction.reply({
          content: errors.join("\n"),
                                flags: MessageFlags.Ephemeral,
        });
        return;
      }

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

    // ---------------- /setcommandchannel (admin-only, ephemeral) ----------------
    if (interaction.commandName === "setcommandchannel") {
      if (!isAdminOrMod(interaction)) {
        await interaction.reply({
          content: "You don’t have permission to use this.",
          flags: MessageFlags.Ephemeral,
        });
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

    // ---------------- Fallback so Discord never times out ----------------
    await interaction.reply({
      content: `Unhandled command: \`/${interaction.commandName}\` (handler missing).`,
                            flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    console.error("Interaction handler error:", err);

    // Try to respond even if we errored after deferring or replying
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "Something went wrong handling that command (check bot logs).",
                                   flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "Something went wrong handling that command (check bot logs).",
                                flags: MessageFlags.Ephemeral,
        });
      }
    } catch {
      // If Discord rejects the response (already timed out), nothing else we can do.
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
