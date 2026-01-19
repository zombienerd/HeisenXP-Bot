// src/index.js
require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  MessageFlags,
} = require("discord.js");

const {
  getGuildSettings,
  updateGuildSettings,
  addXp,
  getXp,
  topUsers,
  logActivity,
  countMessagesInWindow,
  addAllowedCommandChannel,
  removeAllowedCommandChannel,
  listAllowedCommandChannels,
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

/**
 * Utility: check if command is allowed in this channel
 */
function commandAllowed(interaction) {
  const allowed = listAllowedCommandChannels(interaction.guildId);
  if (!allowed.length) return true;
  return allowed.some(r => r.channel_id === interaction.channelId);
}

/**
 * Utility: validate XP values from /setxp
 */
function validateXpValue(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) {
    return `${label} XP must be a finite non-negative number.`;
  }
  if (value > MAX_XP_AWARD) {
    return `${label} XP value too large. Maximum allowed is ${MAX_XP_AWARD.toLocaleString()}.`;
  }
  return null;
}

client.once(Events.ClientReady, () => {
  console.log(`HeisenXP-Bot logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  if (!commandAllowed(interaction)) {
    await interaction.reply({
      content: "Commands are not allowed in this channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildId = interaction.guildId;
  const settings = getGuildSettings(guildId);

  // ===========================
  // /xp
  // ===========================
  if (interaction.commandName === "xp") {
    const user = interaction.options.getUser("user") ?? interaction.user;
    const xp = getXp(guildId, user.id);
    const level = Math.floor(Math.sqrt(xp / settings.level_xp_factor));

    await interaction.reply({
      content: `**${user.username}**\nXP: ${xp}\nLevel: ${level}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // ===========================
  // /leaderboard (image)
  // ===========================
  if (interaction.commandName === "leaderboard") {
    const rows = topUsers(guildId, 10);
    if (!rows.length) {
      await interaction.reply({
        content: "No leaderboard data yet.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const members = await interaction.guild.members.fetch({
      user: rows.map(r => r.user_id),
    });

    const entries = rows.map((r, idx) => {
      const member = members.get(r.user_id);
      const name =
      member?.displayName ||
      member?.user?.username ||
      `User ${r.user_id}`;

      const level = Math.floor(Math.sqrt(r.xp / settings.level_xp_factor));

      return {
        rank: idx + 1,
        name,
        xp: r.xp,
        level,
      };
    });

    const png = renderLeaderboardPng(entries, settings.level_xp_factor);

    await interaction.reply({
      files: [{ attachment: png, name: "leaderboard.png" }],
    });
    return;
  }

  // ===========================
  // /setxp (ADMIN)
  // ===========================
  if (interaction.commandName === "setxp") {
    const msgXp = interaction.options.getInteger("message");
    const reactXp = interaction.options.getInteger("reaction");
    const voiceXp = interaction.options.getInteger("voice");

    const errors = [
      validateXpValue(msgXp, "Message"),
          validateXpValue(reactXp, "Reaction"),
          validateXpValue(voiceXp, "Voice"),
    ].filter(Boolean);

    if (errors.length) {
      await interaction.reply({
        content: errors.join("\n"),
                              flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const patch = {};
    if (msgXp !== null) patch.msg_xp = msgXp;
    if (reactXp !== null) patch.reaction_xp = reactXp;
    if (voiceXp !== null) patch.voice_xp_per_min = voiceXp;

    const updated = updateGuildSettings(guildId, patch);

    await interaction.reply({
      content: `XP settings updated:\n` +
      `• Message XP: ${updated.msg_xp}\n` +
      `• Reaction XP: ${updated.reaction_xp}\n` +
      `• Voice XP / min: ${updated.voice_xp_per_min}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // ===========================
  // /setcommandchannel
  // ===========================
  if (interaction.commandName === "setcommandchannel") {
    const sub = interaction.options.getSubcommand();
    const channel = interaction.options.getChannel("channel");

    if (sub === "add") {
      addAllowedCommandChannel(guildId, channel.id);
      await interaction.reply({
        content: `Commands are now allowed in ${channel}.`,
        flags: MessageFlags.Ephemeral,
      });
    } else if (sub === "remove") {
      removeAllowedCommandChannel(guildId, channel.id);
      await interaction.reply({
        content: `Commands are no longer allowed in ${channel}.`,
        flags: MessageFlags.Ephemeral,
      });
    } else if (sub === "list") {
      const rows = listAllowedCommandChannels(guildId);
      const text = rows.length
      ? rows.map(r => `<#${r.channel_id}>`).join("\n")
      : "Commands are allowed in all channels.";

      await interaction.reply({
        content: text,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
