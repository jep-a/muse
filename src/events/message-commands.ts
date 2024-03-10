import {Message} from 'discord.js';
import container from '../inversify.config';
import {TYPES} from '../types';
import PlayerManager from '../managers/player.js';
import Player, {STATUS} from '../services/player.js';
import AddQueryToQueue from '../services/add-query-to-queue';
import {buildPlayingMessageEmbed} from '../utils/build-embed';

/**
 * Handles running commands from normal messages that aren't
 * using slash commands. Also enables adding to the queue
 * from messages that just contain youtube or spotify urls
 */

const PREFIX = '!';

const SONG_URLS = [
  'www.youtube.com',
  'youtu.be',
  'youtube.com',
  'open.spotify.com',
];

type MessageCommandHandler = ({
  message,
  query,
  addQueryToQueue,
}: {
  message: Message;
  query: string;
  addQueryToQueue: AddQueryToQueue;
  player: Player;
}) => Promise<void> | void;

const commands: Record<string, MessageCommandHandler> = {
  skip: async ({message, player}) => {
    try {
      await player.forward(1);

      await message.reply({
        content: 'skipping',
        embeds: player.getCurrent() ? [buildPlayingMessageEmbed(player)] : [],
      });
    } catch (_: unknown) {
      await message.reply('no songs to skip');
    }
  },
  play: async ({message, query, addQueryToQueue}) => {
    await addQueryToQueue.addToQueueFromMessage({
      message,
      query,
      addToFrontOfQueue: false,
      shuffleAdditions: false,
      shouldSplitChapters: false,
    });
  },
  bumpplay: async ({message, query, addQueryToQueue}) => {
    await addQueryToQueue.addToQueueFromMessage({
      message,
      query,
      addToFrontOfQueue: true,
      shuffleAdditions: false,
      shouldSplitChapters: false,
    });
  },
  stop: async ({message, player}) => {
    if (!player.voiceConnection) {
      await message.reply('not connected');

      return;
    }

    if (player.status !== STATUS.PLAYING) {
      await message.reply('currently playing');

      return;
    }

    player.stop();
    await message.reply('stopped');
  },
  shuffle: async ({message, player}) => {
    if (player.isQueueEmpty()) {
      await message.reply('not enough songs to shuffle');

      return;
    }

    player.shuffle();

    await message.reply('shuffled');
  },
};

const escapeRegExp = (string: string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const commandRegExp = new RegExp(`^${PREFIX}(?<command>${Object.keys(commands).map(escapeRegExp).join('|')})\\s*(?<query>.*)$`);
const urlRegExp = new RegExp(`^(?<url>https:\\/\\/(?<host>${SONG_URLS.map(escapeRegExp).join('|')})).*$`);

export default async (message: Message): Promise<void> => {
  const addQueryToQueue = container.get<AddQueryToQueue>(TYPES.Services.AddQueryToQueue);
  const playerManager = container.get<PlayerManager>(TYPES.Managers.Player);

  if (!message.guild) {
    return;
  }

  const player = playerManager.get(message.guild.id);

  const commandMatch = message.content.match(commandRegExp);
  if (commandMatch?.groups?.command && commands[commandMatch.groups.command]) {
    await commands[commandMatch.groups.command]({
      message,
      query: commandMatch.groups.query,
      addQueryToQueue,
      player,
    });
  } else if (message.content.match(urlRegExp)) {
    // If song-like URL just dropped in, add to queue
    await addQueryToQueue.addToQueueFromMessage({
      message,
      query: message.content,
      addToFrontOfQueue: false,
      shuffleAdditions: false,
      shouldSplitChapters: false,
    });
  }
};

