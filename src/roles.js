const {
  now,
  listLevelRoles,
  getRoleDropState,
  setRoleBelowSince,
} = require("./db");

function logRoleError(action, err, { guildId, userId, roleId }) {
  // Don't spam: role ops are rare; this is valuable for self-hosters.
  console.error(
    `[roles] Failed to ${action} role ${roleId} for user ${userId} in guild ${guildId}: ${err?.message || err}`
  );
  console.error(
    "[roles] Common cause: the bot's highest role is below the role it is trying to manage, or it lacks Manage Roles permission."
  );
}

// Grant when level >= required.
// Remove only after user has been below required for > drop_grace_days.
async function syncMemberRoles(member, level) {
  const guildId = member.guild.id;
  const mappings = listLevelRoles(guildId);
  if (!mappings.length) return;

  for (const m of mappings) {
    const roleId = m.role_id;
    const required = m.level_required;
    const graceMs = Math.max(0, m.drop_grace_days) * 24 * 60 * 60 * 1000;

    const hasRole = member.roles.cache.has(roleId);
    const meets = level >= required;

    if (meets) {
      if (!hasRole) {
        try {
          await member.roles.add(roleId);
        } catch (err) {
          logRoleError("add", err, { guildId, userId: member.id, roleId });
        }
      }
      // clear drop timer regardless
      try {
        setRoleBelowSince(guildId, member.id, roleId, null);
      } catch {
        // DB errors should be rare; let them bubble in caller if needed
      }
      continue;
    }

    // below threshold
    const st = getRoleDropState(guildId, member.id, roleId);
    const belowSince = st?.below_since ?? null;

    if (!belowSince) {
      // Start timer only if they currently have the role.
      if (hasRole) {
        setRoleBelowSince(guildId, member.id, roleId, now());
      }
      continue;
    }

    if (hasRole && (now() - belowSince) > graceMs) {
      try {
        await member.roles.remove(roleId);
      } catch (err) {
        logRoleError("remove", err, { guildId, userId: member.id, roleId });
      }
      setRoleBelowSince(guildId, member.id, roleId, null);
    }
  }
}

module.exports = { syncMemberRoles };
