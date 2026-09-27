import { PermissionFlagsBits, type GuildMember, type Guild } from "discord.js";
import { config } from "../config.js";
import { isBlockedChannel, type ResolvedScope } from "../core/scopes.js";
import type { Place } from "./place.js";

/** Owners (OWNER_IDS) and members with Manage Server administer Claude in a guild. */
export function isAdmin(member: GuildMember | null | undefined, userId?: string): boolean {
  const id = member?.id ?? userId;
  if (id && config.ownerIds.includes(id)) return true;
  return !!member?.permissions.has(PermissionFlagsBits.ManageGuild);
}

export function isGuest(member: GuildMember | null | undefined, scope: ResolvedScope): boolean {
  if (!member || !scope.guestRoleIds.length) return false;
  return scope.guestRoleIds.some((r) => member.roles.cache.has(r));
}

/** When allowed roles are set, only members holding one (or admins) can use Claude. */
export function hasAllowedRole(member: GuildMember | null | undefined, scope: ResolvedScope): boolean {
  if (!scope.allowedRoleIds.length) return true;
  if (isAdmin(member)) return true;
  return !!member && scope.allowedRoleIds.some((r) => member.roles.cache.has(r));
}

export type AccessResult = { ok: true } | { ok: false; reason: string; silent?: boolean };

/** Whether Claude works in this place for this member at all. */
export function checkAccess(place: Place, scope: ResolvedScope, member: GuildMember | null | undefined): AccessResult {
  if (place.kind === "dm") {
    return config.allowDmsDefault ? { ok: true } : { ok: false, reason: "DMs with Claude are turned off on this bot." };
  }
  if (!scope.enabled) return { ok: false, reason: "Claude is turned off here.", silent: true };
  if (isBlockedChannel(scope, place.channelName)) return { ok: false, reason: "Claude is blocked in this channel.", silent: true };
  if (place.hasGuests && scope.guestMode === "restrict") {
    return { ok: false, reason: "Claude is off in channels that guests can see. An admin can change the guest policy with /claude-admin." };
  }
  if (!hasAllowedRole(member, scope)) return { ok: false, reason: "You don't have a role that can use Claude here. Ask an admin." };
  return { ok: true };
}

/** May this person change the channel's settings (model, instructions, respond automatically)? */
export function canEditChannel(member: GuildMember | null | undefined, scope: ResolvedScope): boolean {
  if (isAdmin(member)) return true;
  if (scope.memberEdits === "block") return false;
  return !!member && !isGuest(member, scope) && hasAllowedRole(member, scope);
}

/** May this person approve a tool call? Allowed, non-guest members. */
export function canApprove(member: GuildMember | null | undefined, scope: ResolvedScope): boolean {
  return !!member && !isGuest(member, scope) && hasAllowedRole(member, scope);
}

export async function fetchMember(guild: Guild | null | undefined, userId: string | null): Promise<GuildMember | null> {
  if (!guild || !userId) return null;
  return guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
}
