import {
  ChannelType,
  PermissionFlagsBits,
  type Channel,
  type GuildBasedChannel,
  type Message,
} from "discord.js";
import { resolveScope, type ResolvedScope } from "../core/scopes.js";
import type { MemoryPlace } from "../core/memory.js";

/** Where a conversation with Claude lives. */
export interface Place {
  kind: "thread" | "channel" | "dm";
  guildId: string | null;
  /** The channel that owns config and memory: the parent for a thread, the DM channel for a DM. */
  channelId: string;
  threadId: string | null;
  channelName: string;
  /** Anyone in the guild can see it (@everyone can view). Private channels and private threads are not public. */
  isPublic: boolean;
  /** A guest role can see this channel. */
  hasGuests: boolean;
  /** DM partner, for DMs. */
  dmUserId: string | null;
}

export function isPublicChannel(ch: GuildBasedChannel): boolean {
  const target = ch.isThread() ? ch.parent : ch;
  if (!target) return false;
  if (ch.isThread() && ch.type === ChannelType.PrivateThread) return false;
  return target.permissionsFor(ch.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) ?? false;
}

/** Discord has no guest accounts; a configured guest role that can view the channel stands in for one. */
export function channelHasGuests(ch: GuildBasedChannel, guestRoleIds: string[]): boolean {
  if (!guestRoleIds.length) return false;
  const target = ch.isThread() ? ch.parent : ch;
  if (!target) return false;
  return guestRoleIds.some((id) => {
    const role = ch.guild.roles.cache.get(id);
    return role ? target.permissionsFor(role)?.has(PermissionFlagsBits.ViewChannel) ?? false : false;
  });
}

export function placeOf(channel: Channel, dmUserId?: string): Place | null {
  if (channel.type === ChannelType.DM) {
    return {
      kind: "dm", guildId: null, channelId: channel.id, threadId: null, channelName: "DM",
      isPublic: false, hasGuests: false, dmUserId: dmUserId ?? channel.recipientId ?? null,
    };
  }
  if (!("guild" in channel) || !channel.guild) return null;
  const ch = channel as GuildBasedChannel;
  const parentId = ch.isThread() ? ch.parentId : ch.id;
  if (!parentId) return null;
  const guestRoleIds = resolveScope(ch.guild.id, parentId).guestRoleIds;
  const parentName = ch.isThread() ? ch.parent?.name ?? "unknown" : ch.name;
  return {
    kind: ch.isThread() ? "thread" : "channel",
    guildId: ch.guild.id,
    channelId: parentId,
    threadId: ch.isThread() ? ch.id : null,
    channelName: parentName,
    isPublic: isPublicChannel(ch),
    hasGuests: channelHasGuests(ch, guestRoleIds),
    dmUserId: null,
  };
}

export function placeOfMessage(msg: Message): Place | null {
  return placeOf(msg.channel, msg.channel.type === ChannelType.DM ? msg.author.id : undefined);
}

export function scopeFor(place: Place): ResolvedScope {
  return resolveScope(place.guildId, place.kind === "dm" ? null : place.channelId, place.hasGuests);
}

export function memoryPlace(place: Place, scope: ResolvedScope): MemoryPlace {
  if (place.kind === "dm") return { guildId: null, placeId: place.dmUserId ?? place.channelId, kind: "dm" };
  return {
    guildId: place.guildId,
    placeId: place.channelId,
    kind: place.isPublic ? "public" : "private",
    noMemory: scope.channelOnly,
  };
}

export function describePlace(p: Place): string {
  if (p.kind === "dm") return "a direct message";
  const vis = p.isPublic ? "public" : "private";
  return p.kind === "thread" ? `a thread in #${p.channelName} (${vis})` : `#${p.channelName} (${vis}, top level)`;
}
