require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  PermissionFlagsBits,
} = require("discord.js");

const {
  getGuildSettings,
  updateGuildSettings,
  addXp,
  getXp,
  topUsers,
  logActivity,
  upsertLevelRole,
  deleteLevelRole,
  listLevelRoles,
  addAllowedCommandChannel,
  removeAllowedCommandChannel,
  listAllowedCommandChannels,
} = require("./db");
const { levelFromXp } = require("./xp");
const { syncMemberRoles } = require("./roles");
const { startDecayScheduler } = require("./decay");
const { startVoiceTicker } = require("./voiceTicker");

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

// In-memory cooldowns: per guild/user.
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
  if (!rows.length) return true; // no restriction configured
  const allowed = new Set(rows.map((r) => r.channel_id));
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

  const member = await message.guild.members
    .fetch(message.author.id)
    .catch(() => null);
  if (!member) return;

  await awardAndSync(member, settings.msg_xp, "message", settings);
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (!reaction.message.guild) return;
  if (user.bot) return;

  // Handle partials
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return;
    }
  }

  const guild = reaction.message.guild;
  const settings = getGuildSettings(guild.id);

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
    await interaction.reply({
      content: "Commands aren’t enabled in this channel.",
      ephemeral: true,
    });
    return;
  }

  const guildId = interaction.guild.id;
  const settings = getGuildSettings(guildId);

  if (interaction.commandName === "xp") {
    const target = interaction.options.getUser("user") ?? interaction.user;
    const xp = getXp(guildId, target.id);
    const lvl = levelFromXp(xp, settings.level_xp_factor);
    await interaction.reply({
      content: `<@${target.id}>: **${xp} XP** (Level **${lvl}**)`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "leaderboard") {
    const limitRaw = interaction.options.getInteger("limit") ?? 10;
    const limit = Math.max(1, Math.min(20, limitRaw));

    const rows = topUsers(guildId, limit);
    if (!rows.length) {
      await interaction.reply({
        content: "No leaderboard data yet.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Fetch members once to avoid repeated API calls
    const members = await interaction.guild.members.fetch({ user: rows.map(r => r.user_id) });

    const lines = rows.map((r, idx) => {
      const member = members.get(r.user_id);
      const name =
      member?.displayName ||
      member?.user?.username ||
      `User ${r.user_id}`;

      const lvl = levelFromXp(r.xp, settings.level_xp_factor);
      return `${idx + 1}. **${name}** — ${r.xp} XP (Lvl ${lvl})`;
    });

    await interaction.reply({
      content: `**Leaderboard (Top ${limit})**\n${lines.join("\n")}`,
    });

    return;
  }

  // --- Admin/mod only ---
  if (interaction.commandName === "setxp") {
    if (!isAdminOrMod(interaction)) {
      await interaction.reply({ content: "You don’t have permission to use this.", ephemeral: true });
      return;
    }

    const msg = interaction.options.getInteger("message");
    const reactionXp = interaction.options.getInteger("reaction");
    const voice = interaction.options.getInteger("voice");
    const msgCooldownSec = interaction.options.getInteger("msgcooldown");
    const reactionCooldownSec = interaction.options.getInteger("reactioncooldown");

    const patch = {};
    if (msg !== null) patch.msg_xp = msg;
    if (reactionXp !== null) patch.reaction_xp = reactionXp;
    if (voice !== null) patch.voice_xp_per_min = voice;
    if (msgCooldownSec !== null) patch.msg_cooldown_sec = msgCooldownSec;
    if (reactionCooldownSec !== null) patch.reaction_cooldown_sec = reactionCooldownSec;

    const updated = updateGuildSettings(guildId, patch);
    await interaction.reply({
      content:
        `Updated XP settings:\n` +
        `- msg_xp: **${updated.msg_xp}**\n` +
        `- reaction_xp: **${updated.reaction_xp}**\n` +
        `- voice_xp_per_min: **${updated.voice_xp_per_min}**\n` +
        `- msg_cooldown_sec: **${updated.msg_cooldown_sec}**\n` +
        `- reaction_cooldown_sec: **${updated.reaction_cooldown_sec}**`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "setdecay") {
    if (!isAdminOrMod(interaction)) {
      await interaction.reply({ content: "You don’t have permission to use this.", ephemeral: true });
      return;
    }

    const enabled = interaction.options.getBoolean("enabled");
    const messages = interaction.options.getInteger("messages");
    const days = interaction.options.getInteger("days");
    const percent = interaction.options.getNumber("percent");

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
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "leveltorole") {
    if (!isAdminOrMod(interaction)) {
      await interaction.reply({ content: "You don’t have permission to use this.", ephemeral: true });
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
        ephemeral: true,
      });
      return;
    }

    if (sub === "remove") {
      const role = interaction.options.getRole("role", true);
      deleteLevelRole(guildId, role.id);
      await interaction.reply({ content: `Removed mapping for <@&${role.id}>.`, ephemeral: true });
      return;
    }

    if (sub === "list") {
      const rows = listLevelRoles(guildId);
      if (!rows.length) {
        await interaction.reply({ content: "No level→role mappings configured.", ephemeral: true });
        return;
      }
      const lines = rows.map((r) =>
        `- <@&${r.role_id}>: Level **${r.level_required}** (remove after **${r.drop_grace_days}** day(s) below)`
      );
      await interaction.reply({ content: `**Level→Role mappings:**\n${lines.join("\n")}`, ephemeral: true });
      return;
    }
  }

  if (interaction.commandName === "setcommandchannel") {
    if (!isAdminOrMod(interaction)) {
      await interaction.reply({ content: "You don’t have permission to use this.", ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "add") {
      const ch = interaction.options.getChannel("channel", true);
      addAllowedCommandChannel(guildId, ch.id);
      await interaction.reply({
        content: `Commands are now allowed in <#${ch.id}>. If at least one channel is configured, commands are restricted to allowed channels only.`,
        ephemeral: true,
      });
      return;
    }

    if (sub === "remove") {
      const ch = interaction.options.getChannel("channel", true);
      removeAllowedCommandChannel(guildId, ch.id);
      await interaction.reply({ content: `Removed <#${ch.id}> from allowed command channels.`, ephemeral: true });
      return;
    }

    if (sub === "list") {
      const rows = listAllowedCommandChannels(guildId);
      if (!rows.length) {
        await interaction.reply({ content: "No allowed channels configured — commands are allowed everywhere.", ephemeral: true });
        return;
      }
      const lines = rows.map((r) => `- <#${r.channel_id}>`);
      await interaction.reply({ content: `**Allowed command channels:**\n${lines.join("\n")}`, ephemeral: true });
      return;
    }
  }

  if (interaction.commandName === "settings") {
    if (!isAdminOrMod(interaction)) {
      await interaction.reply({ content: "You don’t have permission to use this.", ephemeral: true });
      return;
    }

    const roleRows = listLevelRoles(guildId);
    const chanRows = listAllowedCommandChannels(guildId);

    const roleLines = roleRows.length
      ? roleRows
          .map(
            (r) =>
              `- <@&${r.role_id}>: Level **${r.level_required}**, remove after **${r.drop_grace_days}** day(s) below`
          )
          .join("\n")
      : "(none)";

    const chanLines = chanRows.length
      ? chanRows.map((r) => `- <#${r.channel_id}>`).join("\n")
      : "(none — commands allowed everywhere)";

    const msg =
      `**Guild Settings**\n` +
      `XP: msg **${settings.msg_xp}**, reaction **${settings.reaction_xp}**, voice/min **${settings.voice_xp_per_min}**\n` +
      `Cooldowns: msg **${settings.msg_cooldown_sec}s**, reaction **${settings.reaction_cooldown_sec}s**\n` +
      `Levels: factor **${settings.level_xp_factor}** (level ≈ floor(sqrt(xp/factor)))\n` +
      `Decay: **${!!settings.decay_enabled}**, threshold **${settings.decay_min_messages}/${settings.decay_window_days}d**, percent **${Math.round(settings.decay_percent * 100)}%**\n\n` +
      `**Level → Role mappings**\n${roleLines}\n\n` +
      `**Allowed command channels**\n${chanLines}`;

    await interaction.reply({ content: msg, ephemeral: true });
    return;
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
