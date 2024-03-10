/* eslint-disable complexity */
import {ChatInputCommandInteraction, Guild, GuildMember, Message, TextBasedChannel} from 'discord.js';
import {URL} from 'node:url';
import {inject, injectable} from 'inversify';
import shuffle from 'array-shuffle';
import {TYPES} from '../types.js';
import GetSongs from '../services/get-songs.js';
import {SongMetadata, STATUS} from './player.js';
import PlayerManager from '../managers/player.js';
import {buildPlayingMessageEmbed} from '../utils/build-embed.js';
import {getMemberVoiceChannel, getMostPopularVoiceChannel} from '../utils/channels.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';

type QueueOptions = {
  query: string;
  addToFrontOfQueue: boolean;
  shuffleAdditions: boolean;
  shouldSplitChapters: boolean;
};

@injectable()
export default class AddQueryToQueue {
  constructor(@inject(TYPES.Services.GetSongs) private readonly getSongs: GetSongs, @inject(TYPES.Managers.Player) private readonly playerManager: PlayerManager) {
  }

  public async addToQueueFromInteraction({
    interaction,
    query,
    addToFrontOfQueue,
    shuffleAdditions,
    shouldSplitChapters,
  }: QueueOptions & {
    interaction: ChatInputCommandInteraction;
  }) {
    if (!interaction.guild) {
      throw new Error('interaction.guild is null');
    }

    if (!interaction.member) {
      throw new Error('interaction.member is null');
    }

    if (!interaction.channel) {
      throw new Error('interaction.channel is null');
    }

    await interaction.deferReply();

    const {embeds, message: content} = await this.addToQueue({
      guild: interaction.guild,
      member: interaction.member as GuildMember,
      channel: interaction.channel,
      query,
      addToFrontOfQueue,
      shuffleAdditions,
      shouldSplitChapters,
    });

    await interaction.editReply({embeds, content});
  }

  public async addToQueueFromMessage({
    message,
    query,
    addToFrontOfQueue,
    shuffleAdditions,
    shouldSplitChapters,
  }: QueueOptions & {
    message: Message;
  }) {
    if (!message.guild) {
      throw new Error('message.guild is null');
    }

    if (!message.member) {
      throw new Error('message.member is null');
    }

    if (!message.channel) {
      throw new Error('message.channel is null');
    }

    const reaction = await message.react('🧑‍💻');
    await message.channel.sendTyping();
    let loading = true;

    const interval = setInterval(async () => {
      if (!loading) {
        return;
      }

      await message.channel.sendTyping();
    }, 11000);

    const {embeds, message: content} = await this.addToQueue({
      guild: message.guild,
      member: message.member,
      channel: message.channel,
      query,
      addToFrontOfQueue,
      shuffleAdditions,
      shouldSplitChapters,
    });

    loading = false;
    clearInterval(interval);
    await message.reply({embeds, content});
    await reaction.remove();
  }

  public async addToQueue({
    guild,
    member,
    channel,
    query,
    addToFrontOfQueue,
    shuffleAdditions,
    shouldSplitChapters,
  }: {
    guild: Guild;
    member: GuildMember;
    channel: TextBasedChannel;
    query: string;
    addToFrontOfQueue: boolean;
    shuffleAdditions: boolean;
    shouldSplitChapters: boolean;
  }) {
    const player = this.playerManager.get(guild.id);
    const wasPlayingSong = player.getCurrent() !== null;
    const [targetVoiceChannel] = getMemberVoiceChannel(member) ?? getMostPopularVoiceChannel(guild);
    const settings = await getGuildSettings(guild.id);

    const {newSongs, foundMsg} = await this.getNewSongs({
      query,
      shuffleAdditions,
      shouldSplitChapters,
      playlistLimit: settings.playlistLimit,
    });

    const embeds = [];
    let extraMsg = foundMsg;

    newSongs.forEach(song => {
      player.add({
        ...song,
        addedInChannelId: channel.id,
        requestedBy: member.user.id,
      }, {immediate: addToFrontOfQueue ?? false});
    });

    let statusMsg = '';

    if (player.voiceConnection === null) {
      await player.connect(targetVoiceChannel);

      // Resume / start playback
      await player.play();

      if (wasPlayingSong) {
        statusMsg = 'resuming playback';
      }

      embeds.push(buildPlayingMessageEmbed(player));
    } else if (player.status === STATUS.IDLE) {
      // Player is idle, start playback instead
      await player.play();
    }

    // Build response message
    if (statusMsg !== '') {
      if (extraMsg === '') {
        extraMsg = statusMsg;
      } else {
        extraMsg = `${statusMsg}, ${extraMsg}`;
      }
    }

    if (extraMsg !== '') {
      extraMsg = ` (${extraMsg})`;
    }

    return {
      embeds,
      message: this.getMessage({newSongs, addToFrontOfQueue, extraMsg}),
    };
  }

  private getMessage({
    newSongs,
    addToFrontOfQueue,
    extraMsg,
  }: {
    newSongs: SongMetadata[];
    addToFrontOfQueue: boolean;
    extraMsg: string;
  }) {
    if (newSongs.length === 1) {
      return `**${newSongs[0].title}** added to the${addToFrontOfQueue ? ' front of the' : ''} queue${extraMsg}`;
    }

    return `**${newSongs[0].title}** and ${newSongs.length - 1} other songs were added to the queue${extraMsg}`;
  }

  private async getNewSongs({
    query,
    shuffleAdditions,
    shouldSplitChapters,
    playlistLimit,
  }: {
    query: string;
    shuffleAdditions: boolean;
    shouldSplitChapters: boolean;
    playlistLimit: number;
  }) {
    const newSongs: SongMetadata[] = [];
    let foundMsg = '';

    // Test if it's a complete URL
    try {
      const url = new URL(query);

      const YOUTUBE_HOSTS = [
        'www.youtube.com',
        'youtu.be',
        'youtube.com',
        'music.youtube.com',
        'www.music.youtube.com',
      ];

      if (YOUTUBE_HOSTS.includes(url.host)) {
        // YouTube source
        if (url.searchParams.get('list')) {
          // YouTube playlist
          newSongs.push(...await this.getSongs.youtubePlaylist(url.searchParams.get('list')!, shouldSplitChapters));
        } else {
          const songs = await this.getSongs.youtubeVideo(url.href, shouldSplitChapters);

          if (songs) {
            newSongs.push(...songs);
          } else {
            throw new Error('that doesn\'t exist');
          }
        }
      } else if (url.protocol === 'spotify:' || url.host === 'open.spotify.com') {
        const [convertedSongs, nSongsNotFound, totalSongs] = await this.getSongs.spotifySource(query, playlistLimit, shouldSplitChapters);

        if (totalSongs > playlistLimit) {
          foundMsg = `a random sample of ${playlistLimit} songs was taken`;
        }

        if (totalSongs > playlistLimit && nSongsNotFound !== 0) {
          foundMsg += ' and ';
        }

        if (nSongsNotFound !== 0) {
          if (nSongsNotFound === 1) {
            foundMsg += '1 song was not found';
          } else {
            foundMsg += `${nSongsNotFound.toString()} songs were not found`;
          }
        }

        newSongs.push(...convertedSongs);
      } else {
        const song = await this.getSongs.httpLiveStream(query);

        if (song) {
          newSongs.push(song);
        } else {
          throw new Error('that doesn\'t exist');
        }
      }
    } catch (_: unknown) {
      // Not a URL, must search YouTube
      const songs = await this.getSongs.youtubeVideoSearch(query, shouldSplitChapters);

      if (songs) {
        newSongs.push(...songs);
      } else {
        throw new Error('that doesn\'t exist');
      }
    }

    if (newSongs.length === 0) {
      throw new Error('no songs found');
    }

    return {
      newSongs: shuffleAdditions ? shuffle(newSongs) : newSongs,
      foundMsg,
    };
  }
}
