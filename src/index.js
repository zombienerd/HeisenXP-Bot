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
  countMessagesInWindow,

  addAllowedCommandChannel,
  removeAllowedCommandChannel,
  listAllowedCommandChannels,

  upsertLevelRole,
  deleteLevelRole,
  listLevelRoles,
  getRoleDropState,
  setRoleBelowSince,
} = require("./db");

const { renderLeaderboardPng } = require("./renderLeaderboard");

const MAX_XP_AWARD = 1_000_000_000;

// Cooldowns (in-memory)
const msgCooldown = new Map();      // key: guildId:userId => lastTs
const reactionCooldown = new Map(); // key: guildId:userId => lastTs

function key(guildId, userId) {
  return `${guildId}:${userId}`;
}

function isAdminOrMod(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

/**
 * Command channel restriction:
 * - If no allowed channels configured => allowed everywhere
 * - If configured => only allowed in those channels
 * - EXCEPTION: /setcommandchannel is allowed anywhere for admins to avoid lockout
 */
function commandsAllowed(interaction) {
  if (interaction.commandName === "setcommandchannel" && isAdminOrMod(interaction)) return true;
  const rows = listAllowedCommandChannels(interaction.guildId);
  if (!rows.length) return true;
  return rows.some(r => r.channel_id === interaction.channelId);
}

function levelFromXp(xp, factor) {
  const f = Math.max(1, Number(factor) || 100);
  return Math.floor(Math.sqrt(Math.max(0, xp) / f));
}

function validateXpValue(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) {
    return `${label} XP must be a finite non-negative number.`;
  }
  if (value > MAX_XP_AWARD) {
    return `XP value too large. Maximum value per ${label.toLowerCase()} is ${MAX_XP_AWARD.toLocaleString()}.`;
  }
  return null;
}

/**
 * Role sync: grant roles when level >= required, remove if below for drop_grace_days.
 * Logs failures instead of swallowing them.
 */
async function syncUserRolesForMember(member, xp, settings) {
  if (!member?.guild) return;

  const guildId = member.guild.id;
  const mappings = listLevelRoles(guildId);
  if (!mappings.length) return;

  const lvl = levelFromXp(xp, settings.level_xp_factor);
  const nowMs = Date.now();

  for (const map of mappings) {
    const roleId = map.role_id;
    const required = Number(map.level_required) || 0;
    const graceDays = Math.max(0, Number(map.drop_grace_days) || 0);
    const graceMs = graceDays * 24 * 60 * 60 * 1000;

    const hasRole = member.roles.cache.has(roleId);
    const qualifies = lvl >= required;

    if (qualifies) {
      // Ensure role
      if (!hasRole) {
        try {
          await member.roles.add(roleId, `HeisenXP: reached level ${lvl} (requires ${required})`);
        } catch (e) {
          console.error(
            `[roles] Failed to add role ${roleId} for user ${member.id} in guild ${guildId}:`,
            e?.message || e
          );
          console.error(
            `[roles] Common cause: bot's highest role is below the role it's trying to manage, or it lacks Manage Roles permission.`
          );
        }
      }
      // Clear below-since state if present
      const st = getRoleDropState(guildId, member.id, roleId);
      if (st?.below_since) {
        setRoleBelowSince(guildId, member.id, roleId, null);
      }
      continue;
    }

    // Below required:
    if (!hasRole) {
      // nothing to remove, clear state
      const st = getRoleDropState(guildId, member.id, roleId);
      if (st?.below_since) setRoleBelowSince(guildId, member.id, roleId, null);
      continue;
    }

    // Has role but below requirement: start/continue timer
    const st = getRoleDropState(guildId, member.id, roleId);
    if (!st || !st.below_since) {
      setRoleBelowSince(guildId, member.id, roleId, nowMs);
      continue;
    }

    if (graceMs === 0 || (nowMs - st.below_since) >= graceMs) {
      try {
        await member.roles.remove(roleId, `HeisenXP: below level ${required} for ${graceDays} day(s)`);
      } catch (e) {
        console.error(
          `[roles] Failed to remove role ${roleId} for user ${member.id} in guild ${guildId}:`,
          e?.message || e
        );
        console.error(
          `[roles] Common cause: bot's highest role is below the role it's trying to manage, or it lacks Manage Roles permission.`
        );
      } finally {
        setRoleBelowSince(guildId, member.id, roleId, null);
      }
    }
  }
}

/**
 * Apply decay to a user if enabled and below activity threshold.
 * Decay rule:
 * If messages in last window < decay_min_messages => reduce XP by decay_percent.
 */
function maybeApplyDecay(guildId, userId, currentXp, settings) {
  if (!settings.decay_enabled) return 0;

  const windowDays = Math.max(1, Number(settings.decay_window_days) || 7);
  const minMsgs = Math.max(0, Number(settings.decay_min_messages) || 0);
  const pct = Math.max(0, Math.min(0.95, Number(settings.decay_percent) || 0));

  const msgCount = countMessagesInWindow(guildId, userId, windowDays);
  if (msgCount >= minMsgs) return 0;

  const loss = Math.floor(currentXp * pct);
  return loss > 0 ? -loss : 0;
}

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

client.once(Events.ClientReady, () => {
  console.log(`HeisenXP-Bot logged in as ${client.user.tag}`);

  // Voice ticker: every minute award voice XP to eligible users
  setInterval(async () => {
    try {
      for (const guild of client.guilds.cache.values()) {
        const settings = getGuildSettings(guild.id);
        const perMin = Number(settings.voice_xp_per_min) || 0;
        if (perMin <= 0) continue;

        // Iterate only users in voice
        for (const vs of guild.voiceStates.cache.values()) {
          const member = vs.member;
          const ch = vs.channel;

          if (!member || !ch) continue;
          if (member.user.bot) continue;

          // Ignore muted/deafened (self or server)
          if (vs.selfMute || vs.selfDeaf || vs.serverMute || vs.serverDeaf) continue;

          // Ignore alone-in-channel idling
          if ((ch.members?.size || 0) <= 1) continue;

          const newXp = addXp(guild.id, member.id, perMin);
          logActivity(guild.id, member.id, "voice_minute", 1);

          await syncUserRolesForMember(member, newXp, settings);
        }
      }
    } catch (e) {
      console.error("[voiceTicker] error:", e?.message || e);
    }
  }, 60_000);
});

// Message XP
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild) return;
    if (message.author?.bot) return;

    const settings = getGuildSettings(message.guild.id);
    const gain = Number(settings.msg_xp) || 0;
    const cdSec = Math.max(0, Number(settings.msg_cooldown_sec) || 0);
    if (gain <= 0) return;

    const k = key(message.guild.id, message.author.id);
    const last = msgCooldown.get(k) || 0;
    const nowMs = Date.now();
    if (cdSec > 0 && (nowMs - last) < cdSec * 1000) return;

    msgCooldown.set(k, nowMs);

    const newXp = addXp(message.guild.id, message.author.id, gain);
    logActivity(message.guild.id, message.author.id, "message", 1);

    // decay check can be expensive; keep it simple: apply at most once per message cooldown window
    const decayDelta = maybeApplyDecay(message.guild.id, message.author.id, newXp, settings);
    const finalXp = decayDelta ? addXp(message.guild.id, message.author.id, decayDelta) : newXp;

    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (member) await syncUserRolesForMember(member, finalXp, settings);
  } catch (e) {
    console.error("[MessageCreate] error:", e?.message || e);
  }
});

// Reaction XP (add)
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (!reaction.message?.guild) return;
    if (user?.bot) return;

    // Ensure partials are resolved
    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    if (reaction.message.partial) {
      try { await reaction.message.fetch(); } catch { /* ignore */ }
    }

    const guild = reaction.message.guild;
    const settings = getGuildSettings(guild.id);
    const gain = Number(settings.reaction_xp) || 0;
    const cdSec = Math.max(0, Number(settings.reaction_cooldown_sec) || 0);
    if (gain <= 0) return;

    const k = key(guild.id, user.id);
    const last = reactionCooldown.get(k) || 0;
    const nowMs = Date.now();
    if (cdSec > 0 && (nowMs - last) < cdSec * 1000) return;

    reactionCooldown.set(k, nowMs);

    const newXp = addXp(guild.id, user.id, gain);
    logActivity(guild.id, user.id, "reaction", 1);

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (member) await syncUserRolesForMember(member, newXp, settings);
  } catch (e) {
    console.error("[ReactionAdd] error:", e?.message || e);
  }
});

// Slash commands
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

    // /xp [user] (ephemeral)
    if (interaction.commandName === "xp") {
      const target = interaction.options.getUser("user") ?? interaction.user;
      const xp = getXp(guildId, target.id);
      const level = levelFromXp(xp, settings.level_xp_factor);

      await interaction.reply({
        content: `${target.username}: **${xp} XP** (Level **${level}**)`,
                              flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // /leaderboard (PUBLIC) PNG top 10
    if (interaction.commandName === "leaderboard") {
      const rows = topUsers(guildId, 10);
      if (!rows.length) {
        await interaction.reply({
          content: "No leaderboard data yet.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      let members = null;
      try {
        members = await interaction.guild.members.fetch({ user: rows.map(r => r.user_id) });
      } catch {
        members = null;
      }

      const factor = Math.max(1, Number(settings.level_xp_factor) || 100);

      const entries = rows.map((r, idx) => {
        const m = members?.get?.(r.user_id);
        const name = m?.displayName || m?.user?.username || `User ${r.user_id}`;
        const level = levelFromXp(r.xp, factor);
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

    // Admin/mod gate from here down where appropriate
    const admin = isAdminOrMod(interaction);

    // /settings (admin/mod)
    if (interaction.commandName === "settings") {
      if (!admin) {
        await interaction.reply({ content: "You don’t have permission to use this.", flags: MessageFlags.Ephemeral });
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
        `**Decay:** enabled=${!!settings.decay_enabled}, threshold=${settings.decay_min_messages} msgs / ${settings.decay_window_days} days, percent=${Math.round((Number(settings.decay_percent) || 0) * 100)}%\n` +
        `**Level curve factor:** ${settings.level_xp_factor} (Level L starts at L²×factor)\n` +
        `**Commands allowed in:** ${chanText}\n` +
        `**Level→Role mappings:**\n${roleText}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // /setxp (admin/mod)
    if (interaction.commandName === "setxp") {
      if (!admin) {
        await interaction.reply({ content: "You don’t have permission to use this.", flags: MessageFlags.Ephemeral });
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
        await interaction.reply({ content: errors.join("\n"), flags: MessageFlags.Ephemeral });
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

    // /setdecay (admin/mod)
    if (interaction.commandName === "setdecay") {
      if (!admin) {
        await interaction.reply({ content: "You don’t have permission to use this.", flags: MessageFlags.Ephemeral });
        return;
      }

      const enabled = interaction.options.getBoolean("enabled");
      const messages = interaction.options.getInteger("messages");
      const days = interaction.options.getInteger("days");
      const percent = interaction.options.getNumber("percent"); // 0..95

      const patch = {};

      if (enabled !== null) patch.decay_enabled = enabled ? 1 : 0;
      if (messages !== null) patch.decay_min_messages = Math.max(0, messages);
      if (days !== null) patch.decay_window_days = Math.max(1, days);
      if (percent !== null) patch.decay_percent = Math.max(0, Math.min(0.95, percent / 100));

      const updated = updateGuildSettings(guildId, patch);

      await interaction.reply({
        content:
        `Updated decay settings:\n` +
        `- enabled: **${!!updated.decay_enabled}**\n` +
        `- threshold: **${updated.decay_min_messages} messages** in **${updated.decay_window_days} days**\n` +
        `- percent: **${Math.round((Number(updated.decay_percent) || 0) * 100)}%**`,
                              flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // /leveltorole (admin/mod)
    if (interaction.commandName === "leveltorole") {
      if (!admin) {
        await interaction.reply({ content: "You don’t have permission to use this.", flags: MessageFlags.Ephemeral });
        return;
      }

      const sub = interaction.options.getSubcommand();

      if (sub === "set") {
        const role = interaction.options.getRole("role", true);
        const level = interaction.options.getInteger("level", true);
        const dropdays = interaction.options.getInteger("dropdays", true);

        upsertLevelRole(guildId, role.id, Math.max(0, level), Math.max(0, dropdays));

        await interaction.reply({
          content: `Mapped ${role} to **Lvl ${level}** (remove after **${dropdays}** day(s) below).`,
                                flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "remove") {
        const role = interaction.options.getRole("role", true);
        deleteLevelRole(guildId, role.id);

        await interaction.reply({
          content: `Removed mapping for ${role}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "list") {
        const rows = listLevelRoles(guildId);
        if (!rows.length) {
          await interaction.reply({
            content: "No level→role mappings configured.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const lines = rows.map(r => `- <@&${r.role_id}> @ **Lvl ${r.level_required}** (drop after **${r.drop_grace_days}d**)`);
        await interaction.reply({
          content: `**Level→Role mappings:**\n${lines.join("\n")}`,
                                flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    // /setcommandchannel (admin/mod)
    if (interaction.commandName === "setcommandchannel") {
      if (!admin) {
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

    // Fallback so Discord never times out
    await interaction.reply({
      content: `Unhandled command: \`/${interaction.commandName}\` (handler missing).`,
                            flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    console.error("Interaction handler error:", err);

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
