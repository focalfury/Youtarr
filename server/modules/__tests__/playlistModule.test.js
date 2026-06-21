jest.mock('child_process');
jest.mock('../../logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../models', () => ({
  Playlist: { findOne: jest.fn(), create: jest.fn(), update: jest.fn(), findAll: jest.fn(), max: jest.fn() },
  PlaylistVideo: { findAll: jest.fn(), bulkCreate: jest.fn(), update: jest.fn(), destroy: jest.fn() },
  PlaylistSyncState: { destroy: jest.fn() },
  Channel: { findAll: jest.fn(), findOne: jest.fn() },
}));
jest.mock('../channelModule', () => ({
  upsertChannel: jest.fn(),
}));
jest.mock('../downloadModule', () => ({
  doPlaylistDownloads: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../youtubeApi', () => ({
  isAvailable: jest.fn(() => false),
  getApiKey: jest.fn(() => null),
  client: { getVideoMetadata: jest.fn() },
}));
jest.mock('fs-extra', () => ({
  existsSync: jest.fn(() => false),
  readdirSync: jest.fn(() => []),
  copySync: jest.fn(),
  outputFileSync: jest.fn(),
  remove: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('axios', () => ({
  get: jest.fn(),
}));
jest.mock('../configModule', () => ({
  getConfig: jest.fn(() => ({})),
  getImagePath: jest.fn(() => '/mock/images'),
  directoryPath: '/library',
}));
jest.mock('../nfoGenerator', () => ({
  writeVideoNfoFile: jest.fn(),
  writeShowNfoFile: jest.fn(),
}));
jest.mock('../filesystem', () => ({
  sanitizeNameLikeYtDlp: jest.fn((name) => name),
}));
jest.mock('../plexModule', () => ({
  renameSeasonInPlex: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('sequelize', () => ({
  Op: { ne: 'ne' },
}));

const { EventEmitter } = require('events');

describe('playlistModule', () => {
  let playlistModule;
  let Playlist;
  let PlaylistVideo;
  let PlaylistSyncState;
  let Channel;
  let channelModule;
  let downloadModule;
  let childProcess;
  let youtubeApi;
  let fs;
  let axios;
  let nfoGenerator;
  let configModule;
  let plexModule;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    // Set up spawn on the mock BEFORE requiring playlistModule so the
    // destructured `const { spawn } = require('child_process')` in the module
    // captures our jest.fn().
    childProcess = require('child_process');
    childProcess.spawn = jest.fn();
    // Now require the module — its top-level destructure picks up the mock.
    playlistModule = require('../playlistModule');
    ({ Playlist, PlaylistVideo, PlaylistSyncState, Channel } = require('../../models'));
    channelModule = require('../channelModule');
    downloadModule = require('../downloadModule');
    youtubeApi = require('../youtubeApi');
    fs = require('fs-extra');
    axios = require('axios');
    nfoGenerator = require('../nfoGenerator');
    configModule = require('../configModule');
    plexModule = require('../plexModule');
  });

  describe('getPlaylistInfo', () => {
    test('returns parsed metadata for a valid playlist URL', async () => {
      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      childProcess.spawn.mockReturnValue(mockChild);

      const promise = playlistModule.getPlaylistInfo(
        'https://www.youtube.com/playlist?list=PLabc123'
      );

      const metadata = {
        id: 'PLabc123',
        title: 'Test Playlist',
        uploader: 'Test User',
        description: 'desc',
        thumbnail: 'https://img',
        playlist_count: 12,
        webpage_url: 'https://www.youtube.com/playlist?list=PLabc123',
      };
      mockChild.stdout.emit('data', JSON.stringify(metadata));
      mockChild.emit('close', 0);

      const result = await promise;
      expect(result).toEqual({
        playlist_id: 'PLabc123',
        title: 'Test Playlist',
        uploader: 'Test User',
        description: 'desc',
        thumbnail: 'https://img',
        video_count: 12,
        url: 'https://www.youtube.com/playlist?list=PLabc123',
      });
    });

    test('throws PLAYLIST_NOT_FOUND on unavailable playlist', async () => {
      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      childProcess.spawn.mockReturnValue(mockChild);

      const promise = playlistModule.getPlaylistInfo('https://www.youtube.com/playlist?list=nope');
      mockChild.stderr.emit('data', 'ERROR: The playlist does not exist');
      mockChild.emit('close', 1);

      await expect(promise).rejects.toThrow('PLAYLIST_NOT_FOUND');
    });
  });

  describe('upsertPlaylist', () => {
    test('creates a new playlist when none exists', async () => {
      Playlist.findOne.mockResolvedValue(null);
      Playlist.create.mockResolvedValue({ id: 1, playlist_id: 'PLabc' });

      const result = await playlistModule.upsertPlaylist({
        playlist_id: 'PLabc', title: 'X', url: 'https://u',
      }, { enabled: true });

      expect(Playlist.create).toHaveBeenCalledWith(expect.objectContaining({
        playlist_id: 'PLabc', title: 'X', enabled: true,
      }));
      expect(result.id).toBe(1);
    });

    test('updates existing playlist', async () => {
      const existing = { id: 2, playlist_id: 'PLabc', update: jest.fn().mockResolvedValue(true) };
      Playlist.findOne.mockResolvedValue(existing);

      await playlistModule.upsertPlaylist({
        playlist_id: 'PLabc', title: 'Updated',
      }, { enabled: true });

      expect(existing.update).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Updated', enabled: true,
      }));
    });
  });

  describe('fetchAllPlaylistVideos', () => {
    test('parses yt-dlp flat-playlist output and upserts rows in position order', async () => {
      Playlist.findOne.mockResolvedValue({
        id: 1, playlist_id: 'PLabc', url: 'https://u',
        min_duration: null, max_duration: null, title_filter_regex: null,
        update: jest.fn().mockResolvedValue(true),
      });
      PlaylistVideo.findAll.mockResolvedValue([]);
      PlaylistVideo.bulkCreate.mockResolvedValue([]);

      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      childProcess.spawn.mockReturnValue(mockChild);

      const promise = playlistModule.fetchAllPlaylistVideos('PLabc');

      // Playlist.findOne is async — wait for it to resolve before emitting events
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const lines = [
        JSON.stringify({ id: 'v1', title: 'Video 1', channel_id: 'UC1', uploader: 'A', duration: 300 }),
        JSON.stringify({ id: 'v2', title: 'Video 2', channel_id: 'UC2', uploader: 'B', duration: 200 }),
      ].join('\n') + '\n';
      mockChild.stdout.emit('data', lines);
      mockChild.emit('close', 0);

      await promise;

      expect(PlaylistVideo.bulkCreate).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            playlist_id: 'PLabc',
            youtube_id: 'v1',
            position: 1,
            channel_id: 'UC1',
            channel_name: 'A',
            title: 'Video 1',
            duration: 300,
            thumbnail: 'https://i.ytimg.com/vi/v1/hqdefault.jpg',
          }),
          expect.objectContaining({
            playlist_id: 'PLabc',
            youtube_id: 'v2',
            position: 2,
            channel_id: 'UC2',
            channel_name: 'B',
            title: 'Video 2',
            duration: 200,
          }),
        ]),
        expect.objectContaining({ updateOnDuplicate: expect.any(Array) })
      );
    });

    test('applies min_duration filter', async () => {
      Playlist.findOne.mockResolvedValue({
        id: 1, playlist_id: 'PLabc', url: 'https://u',
        min_duration: 250, max_duration: null, title_filter_regex: null,
        update: jest.fn().mockResolvedValue(true),
      });
      PlaylistVideo.findAll.mockResolvedValue([]);
      PlaylistVideo.bulkCreate.mockResolvedValue([]);

      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      childProcess.spawn.mockReturnValue(mockChild);
      const promise = playlistModule.fetchAllPlaylistVideos('PLabc');

      // Playlist.findOne is async — wait for it to resolve before emitting events
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const lines = [
        JSON.stringify({ id: 'v1', title: 'Short Video', duration: 100 }),
        JSON.stringify({ id: 'v2', title: 'Long Video', duration: 300 }),
      ].join('\n') + '\n';
      mockChild.stdout.emit('data', lines);
      mockChild.emit('close', 0);
      await promise;

      const call = PlaylistVideo.bulkCreate.mock.calls[0][0];
      expect(call.map((v) => v.youtube_id)).toEqual(['v2']);
    });

    test('backfills playlist thumbnail from first video when null', async () => {
      const update = jest.fn().mockResolvedValue(true);
      Playlist.findOne.mockResolvedValue({
        id: 1, playlist_id: 'PLabc', url: 'https://u',
        thumbnail: null,
        min_duration: null, max_duration: null, title_filter_regex: null,
        update,
      });
      PlaylistVideo.findAll.mockResolvedValue([]);
      PlaylistVideo.bulkCreate.mockResolvedValue([]);

      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      childProcess.spawn.mockReturnValue(mockChild);
      const promise = playlistModule.fetchAllPlaylistVideos('PLabc');
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      mockChild.stdout.emit('data', JSON.stringify({ id: 'firstVid', title: 'a' }) + '\n');
      mockChild.emit('close', 0);
      await promise;

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          thumbnail: 'https://i.ytimg.com/vi/firstVid/hqdefault.jpg',
        })
      );
    });

    test('does not overwrite existing playlist thumbnail', async () => {
      const update = jest.fn().mockResolvedValue(true);
      Playlist.findOne.mockResolvedValue({
        id: 1, playlist_id: 'PLabc', url: 'https://u',
        thumbnail: 'https://existing.example/thumb.jpg',
        min_duration: null, max_duration: null, title_filter_regex: null,
        update,
      });
      PlaylistVideo.findAll.mockResolvedValue([]);
      PlaylistVideo.bulkCreate.mockResolvedValue([]);

      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      childProcess.spawn.mockReturnValue(mockChild);
      const promise = playlistModule.fetchAllPlaylistVideos('PLabc');
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      mockChild.stdout.emit('data', JSON.stringify({ id: 'firstVid', title: 'a' }) + '\n');
      mockChild.emit('close', 0);
      await promise;

      const passed = update.mock.calls[0][0];
      expect(passed).not.toHaveProperty('thumbnail');
    });

    test('leaves channel fields null instead of substituting the playlist owner when per-video channel fields are absent', async () => {
      Playlist.findOne.mockResolvedValue({
        id: 1, playlist_id: 'PLabc', url: 'https://u',
        min_duration: null, max_duration: null, title_filter_regex: null,
        update: jest.fn().mockResolvedValue(true),
      });
      PlaylistVideo.findAll.mockResolvedValue([]);
      PlaylistVideo.bulkCreate.mockResolvedValue([]);

      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      childProcess.spawn.mockReturnValue(mockChild);
      const promise = playlistModule.fetchAllPlaylistVideos('PLabc');
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      mockChild.stdout.emit(
        'data',
        JSON.stringify({ id: 'vid1', title: 'No Channel Entry', duration: 120, playlist_channel_id: 'UCowner', playlist_channel: 'OwnerName' }) + '\n'
      );
      mockChild.emit('close', 0);
      await promise;

      const rows = PlaylistVideo.bulkCreate.mock.calls[0][0];
      expect(rows.find((r) => r.youtube_id === 'vid1')).toMatchObject({
        channel_id: null,
        channel_name: null,
      });
    });

    test('carries forward stored channel attribution when a stripped fetch omits it', async () => {
      Playlist.findOne.mockResolvedValue({
        id: 1, playlist_id: 'PLabc', url: 'https://u',
        min_duration: null, max_duration: null, title_filter_regex: null,
        update: jest.fn().mockResolvedValue(true),
      });
      // A previous good fetch captured the artist attribution for this video.
      PlaylistVideo.findAll.mockResolvedValue([
        { youtube_id: 'vid1', published_at: null, channel_id: 'UCartist', channel_name: 'Artist' },
      ]);
      PlaylistVideo.bulkCreate.mockResolvedValue([]);

      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      childProcess.spawn.mockReturnValue(mockChild);
      const promise = playlistModule.fetchAllPlaylistVideos('PLabc');
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      mockChild.stdout.emit(
        'data',
        JSON.stringify({ id: 'vid1', title: 'Stripped Entry', duration: 120, playlist_channel_id: 'UCowner', playlist_channel: 'OwnerName' }) + '\n'
      );
      mockChild.emit('close', 0);
      await promise;

      const rows = PlaylistVideo.bulkCreate.mock.calls[0][0];
      expect(rows.find((r) => r.youtube_id === 'vid1')).toMatchObject({
        channel_id: 'UCartist',
        channel_name: 'Artist',
      });
    });

    test('stores per-video channel attribution, ignoring playlist-owner fields', async () => {
      Playlist.findOne.mockResolvedValue({
        id: 1, playlist_id: 'PLabc', url: 'https://u',
        min_duration: null, max_duration: null, title_filter_regex: null,
        update: jest.fn().mockResolvedValue(true),
      });
      PlaylistVideo.findAll.mockResolvedValue([]);
      PlaylistVideo.bulkCreate.mockResolvedValue([]);

      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      childProcess.spawn.mockReturnValue(mockChild);
      const promise = playlistModule.fetchAllPlaylistVideos('PLabc');
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      mockChild.stdout.emit(
        'data',
        JSON.stringify({ id: 'vid2', title: 'Has Own Channel', duration: 180, channel_id: 'UCreal', uploader: 'RealName', playlist_channel_id: 'UCowner', playlist_channel: 'OwnerName' }) + '\n'
      );
      mockChild.emit('close', 0);
      await promise;

      const rows = PlaylistVideo.bulkCreate.mock.calls[0][0];
      expect(rows.find((r) => r.youtube_id === 'vid2')).toMatchObject({
        channel_id: 'UCreal',
        channel_name: 'RealName',
      });
    });

    test('excludes private/unavailable entries from the stored rows', async () => {
      Playlist.findOne.mockResolvedValue({
        id: 1, playlist_id: 'PLabc', url: 'https://u',
        min_duration: null, max_duration: null, title_filter_regex: null,
        update: jest.fn().mockResolvedValue(true),
      });
      PlaylistVideo.findAll.mockResolvedValue([]);
      PlaylistVideo.bulkCreate.mockResolvedValue([]);

      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      childProcess.spawn.mockReturnValue(mockChild);
      const promise = playlistModule.fetchAllPlaylistVideos('PLabc');
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const lines = [
        JSON.stringify({ id: 'v1', title: 'Public Video', duration: 300, playlist_count: 4 }),
        JSON.stringify({ id: 'v2', title: null, duration: null, playlist_count: 4 }),
        JSON.stringify({ id: 'v3', title: '[Private video]', duration: null, playlist_count: 4 }),
        JSON.stringify({ id: 'v4', title: '[Deleted video]', duration: null, playlist_count: 4 }),
      ].join('\n') + '\n';
      mockChild.stdout.emit('data', lines);
      mockChild.emit('close', 0);
      await promise;

      const rows = PlaylistVideo.bulkCreate.mock.calls[0][0];
      expect(rows.map((r) => r.youtube_id)).toEqual(['v1']);
    });

    test('prunes tracked rows that are now private or removed from the playlist', async () => {
      const { Op } = require('sequelize');
      Playlist.findOne.mockResolvedValue({
        id: 1, playlist_id: 'PLabc', url: 'https://u',
        min_duration: null, max_duration: null, title_filter_regex: null,
        update: jest.fn().mockResolvedValue(true),
      });
      PlaylistVideo.findAll.mockResolvedValue([]);
      PlaylistVideo.bulkCreate.mockResolvedValue([]);
      PlaylistVideo.destroy.mockResolvedValue(0);

      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      childProcess.spawn.mockReturnValue(mockChild);
      const promise = playlistModule.fetchAllPlaylistVideos('PLabc');
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      // YouTube now reports a 2-video playlist: v1 public, v2 went private.
      // v3 (previously tracked) is fully removed and absent from the fetch.
      const lines = [
        JSON.stringify({ id: 'v1', title: 'Public Video', duration: 300, playlist_count: 2 }),
        JSON.stringify({ id: 'v2', title: null, duration: null, playlist_count: 2 }),
      ].join('\n') + '\n';
      mockChild.stdout.emit('data', lines);
      mockChild.emit('close', 0);
      await promise;

      expect(PlaylistVideo.destroy).toHaveBeenCalledWith({
        where: { playlist_id: 'PLabc', youtube_id: { [Op.notIn]: ['v1'] } },
      });
    });

    test('does not prune when the fetch looks incomplete (fewer entries than reported)', async () => {
      Playlist.findOne.mockResolvedValue({
        id: 1, playlist_id: 'PLabc', url: 'https://u',
        min_duration: null, max_duration: null, title_filter_regex: null,
        update: jest.fn().mockResolvedValue(true),
      });
      PlaylistVideo.findAll.mockResolvedValue([]);
      PlaylistVideo.bulkCreate.mockResolvedValue([]);
      PlaylistVideo.destroy.mockResolvedValue(0);

      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      childProcess.spawn.mockReturnValue(mockChild);
      const promise = playlistModule.fetchAllPlaylistVideos('PLabc');
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      // Only 1 of 10 entries came back: a partial fetch must not delete anything.
      mockChild.stdout.emit('data', JSON.stringify({ id: 'v1', title: 'Public Video', duration: 300, playlist_count: 10 }) + '\n');
      mockChild.emit('close', 0);
      await promise;

      expect(PlaylistVideo.destroy).not.toHaveBeenCalled();
    });

    test('does not prune when the fetch returns no entries', async () => {
      Playlist.findOne.mockResolvedValue({
        id: 1, playlist_id: 'PLabc', url: 'https://u',
        min_duration: null, max_duration: null, title_filter_regex: null,
        update: jest.fn().mockResolvedValue(true),
      });
      PlaylistVideo.findAll.mockResolvedValue([]);
      PlaylistVideo.bulkCreate.mockResolvedValue([]);
      PlaylistVideo.destroy.mockResolvedValue(0);

      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      childProcess.spawn.mockReturnValue(mockChild);
      const promise = playlistModule.fetchAllPlaylistVideos('PLabc');
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      mockChild.emit('close', 0);
      await promise;

      expect(PlaylistVideo.destroy).not.toHaveBeenCalled();
    });

    test('sets playlist video_count to the available (non-private) count', async () => {
      const update = jest.fn().mockResolvedValue(true);
      Playlist.findOne.mockResolvedValue({
        id: 1, playlist_id: 'PLabc', url: 'https://u',
        thumbnail: 'https://existing.example/thumb.jpg',
        min_duration: null, max_duration: null, title_filter_regex: null,
        update,
      });
      PlaylistVideo.findAll.mockResolvedValue([]);
      PlaylistVideo.bulkCreate.mockResolvedValue([]);
      PlaylistVideo.destroy.mockResolvedValue(0);

      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      childProcess.spawn.mockReturnValue(mockChild);
      const promise = playlistModule.fetchAllPlaylistVideos('PLabc');
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const lines = [
        JSON.stringify({ id: 'v1', title: 'Public Video', duration: 300, playlist_count: 2 }),
        JSON.stringify({ id: 'v2', title: null, duration: null, playlist_count: 2 }),
      ].join('\n') + '\n';
      mockChild.stdout.emit('data', lines);
      mockChild.emit('close', 0);
      await promise;

      expect(update).toHaveBeenCalledWith(expect.objectContaining({ video_count: 1 }));
    });
  });

  describe('isUnavailableTitle', () => {
    test('treats null, empty, and placeholder titles as unavailable', () => {
      expect(playlistModule.isUnavailableTitle(null)).toBe(true);
      expect(playlistModule.isUnavailableTitle('')).toBe(true);
      expect(playlistModule.isUnavailableTitle('   ')).toBe(true);
      expect(playlistModule.isUnavailableTitle('[Private video]')).toBe(true);
      expect(playlistModule.isUnavailableTitle('[Deleted video]')).toBe(true);
    });

    test('treats a real title as available', () => {
      expect(playlistModule.isUnavailableTitle('I survived 100 days as a shapeshifter')).toBe(false);
    });
  });

  describe('ensureSourceChannel', () => {
    test('creates hidden channel with seeded settings from the playlist', async () => {
      channelModule.upsertChannel.mockResolvedValue({ id: 9, channel_id: 'UC9' });

      const playlist = {
        default_sub_folder: '__Learning',
        video_quality: '720',
        min_duration: 60,
        max_duration: null,
        title_filter_regex: null,
        audio_format: null,
        default_rating: 'PG-13',
      };

      await playlistModule.ensureSourceChannel(
        { channel_id: 'UC9', uploader: 'Creator X', url: 'https://www.youtube.com/channel/UC9' },
        playlist
      );

      expect(channelModule.upsertChannel).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'UC9', title: 'Creator X', uploader: 'Creator X', url: 'https://www.youtube.com/channel/UC9' }),
        false,
        null,
        expect.objectContaining({
          sub_folder: '__Learning',
          video_quality: '720',
          min_duration: 60,
          default_rating: 'PG-13',
        })
      );
    });

    test('seeds title and uploader from the channel name so the row is not left nameless', async () => {
      channelModule.upsertChannel.mockResolvedValue({ id: 9, channel_id: 'UCabc' });

      await playlistModule.ensureSourceChannel(
        { channel_id: 'UCabc', uploader: 'Little Mix' },
        {}
      );

      expect(channelModule.upsertChannel).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'UCabc', title: 'Little Mix', uploader: 'Little Mix' }),
        false,
        null,
        expect.any(Object)
      );
    });

    test('synthesizes a channel URL when only channel_id is provided', async () => {
      channelModule.upsertChannel.mockResolvedValue({ id: 9, channel_id: 'UCabc' });

      await playlistModule.ensureSourceChannel({ channel_id: 'UCabc' }, {});

      expect(channelModule.upsertChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'UCabc',
          url: 'https://www.youtube.com/channel/UCabc',
          uploader: null,
        }),
        false,
        null,
        expect.any(Object)
      );
    });

    test('seeds null (explicit root) when the playlist subfolder is null', async () => {
      channelModule.upsertChannel.mockResolvedValue({ id: 9, channel_id: 'UCabc' });

      await playlistModule.ensureSourceChannel(
        { channel_id: 'UCabc' },
        { default_sub_folder: null }
      );

      expect(channelModule.upsertChannel).toHaveBeenCalledWith(
        expect.any(Object),
        false,
        null,
        expect.objectContaining({ sub_folder: null })
      );
    });

    test('passes the global-default sentinel through to the seeded channel', async () => {
      const { GLOBAL_DEFAULT_SENTINEL } = require('../filesystem/constants');
      channelModule.upsertChannel.mockResolvedValue({ id: 9, channel_id: 'UCabc' });

      await playlistModule.ensureSourceChannel(
        { channel_id: 'UCabc' },
        { default_sub_folder: GLOBAL_DEFAULT_SENTINEL }
      );

      expect(channelModule.upsertChannel).toHaveBeenCalledWith(
        expect.any(Object),
        false,
        null,
        expect.objectContaining({ sub_folder: GLOBAL_DEFAULT_SENTINEL })
      );
    });

    test('uses playlist default_sub_folder when set', async () => {
      channelModule.upsertChannel.mockResolvedValue({ id: 9, channel_id: 'UCabc' });

      await playlistModule.ensureSourceChannel(
        { channel_id: 'UCabc' },
        { default_sub_folder: 'Learning' }
      );

      expect(channelModule.upsertChannel).toHaveBeenCalledWith(
        expect.any(Object),
        false,
        null,
        expect.objectContaining({ sub_folder: 'Learning' })
      );
    });
  });

  describe('backfillDownloadedVideoChannels', () => {
    test('backfills channel_id on playlist rows from the downloaded video metadata', async () => {
      PlaylistVideo.findAll.mockResolvedValue([
        { playlist_id: 'PL1', youtube_id: 'v1', channel_id: null },
      ]);
      Channel.findAll.mockResolvedValue([{ channel_id: 'UCreal' }]);
      Playlist.findAll.mockResolvedValue([]);

      await playlistModule.backfillDownloadedVideoChannels([
        { youtubeId: 'v1', channel_id: 'UCreal', youTubeChannelName: 'Real Ch' },
      ]);

      expect(PlaylistVideo.update).toHaveBeenCalledWith(
        { channel_id: 'UCreal' },
        { where: { youtube_id: 'v1', channel_id: null } }
      );
    });

    test('auto-creates a hidden channel seeded from playlist settings when the channel is untracked', async () => {
      PlaylistVideo.findAll.mockResolvedValue([
        { playlist_id: 'PL1', youtube_id: 'v1', channel_id: null },
      ]);
      Channel.findAll.mockResolvedValue([]);
      Playlist.findAll.mockResolvedValue([
        { playlist_id: 'PL1', default_sub_folder: 'Library1', video_quality: '1080' },
      ]);
      channelModule.upsertChannel.mockResolvedValue({ id: 5, channel_id: 'UCnew' });

      await playlistModule.backfillDownloadedVideoChannels([
        { youtubeId: 'v1', channel_id: 'UCnew', youTubeChannelName: 'Marvelous Videos' },
      ]);

      expect(channelModule.upsertChannel).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'UCnew', uploader: 'Marvelous Videos' }),
        false,
        null,
        expect.objectContaining({ sub_folder: 'Library1', video_quality: '1080' })
      );
      expect(PlaylistVideo.update).toHaveBeenCalledWith(
        { channel_id: 'UCnew' },
        { where: { youtube_id: 'v1', channel_id: null } }
      );
    });

    test('does not create a channel that is already tracked', async () => {
      PlaylistVideo.findAll.mockResolvedValue([
        { playlist_id: 'PL1', youtube_id: 'v1', channel_id: null },
      ]);
      Channel.findAll.mockResolvedValue([{ channel_id: 'UCtracked' }]);

      await playlistModule.backfillDownloadedVideoChannels([
        { youtubeId: 'v1', channel_id: 'UCtracked', youTubeChannelName: 'Tracked Ch' },
      ]);

      expect(channelModule.upsertChannel).not.toHaveBeenCalled();
    });

    test('creates an untracked channel only once when it owns several downloaded videos', async () => {
      PlaylistVideo.findAll.mockResolvedValue([
        { playlist_id: 'PL1', youtube_id: 'v1', channel_id: null },
        { playlist_id: 'PL1', youtube_id: 'v2', channel_id: null },
      ]);
      Channel.findAll.mockResolvedValue([]);
      Playlist.findAll.mockResolvedValue([
        { playlist_id: 'PL1', default_sub_folder: 'Library1', video_quality: '1080' },
      ]);
      channelModule.upsertChannel.mockResolvedValue({ id: 5, channel_id: 'UCnew' });

      await playlistModule.backfillDownloadedVideoChannels([
        { youtubeId: 'v1', channel_id: 'UCnew', youTubeChannelName: 'Marvelous Videos' },
        { youtubeId: 'v2', channel_id: 'UCnew', youTubeChannelName: 'Marvelous Videos' },
      ]);

      expect(channelModule.upsertChannel).toHaveBeenCalledTimes(1);
    });

    test('skips downloaded videos that are not part of any playlist', async () => {
      PlaylistVideo.findAll.mockResolvedValue([]);

      await playlistModule.backfillDownloadedVideoChannels([
        { youtubeId: 'v1', channel_id: 'UCnew', youTubeChannelName: 'X' },
      ]);

      expect(PlaylistVideo.update).not.toHaveBeenCalled();
      expect(channelModule.upsertChannel).not.toHaveBeenCalled();
    });

    test('ignores downloaded videos that have no channel_id', async () => {
      await playlistModule.backfillDownloadedVideoChannels([
        { youtubeId: 'v1', channel_id: null, youTubeChannelName: 'X' },
      ]);

      expect(PlaylistVideo.findAll).not.toHaveBeenCalled();
      expect(channelModule.upsertChannel).not.toHaveBeenCalled();
    });

    test('does nothing for empty input', async () => {
      await playlistModule.backfillDownloadedVideoChannels([]);

      expect(PlaylistVideo.findAll).not.toHaveBeenCalled();
    });

    test('does not rewrite channel_id that is already correct', async () => {
      PlaylistVideo.findAll.mockResolvedValue([
        { playlist_id: 'PL1', youtube_id: 'v1', channel_id: 'UCreal' },
      ]);
      Channel.findAll.mockResolvedValue([{ channel_id: 'UCreal' }]);

      await playlistModule.backfillDownloadedVideoChannels([
        { youtubeId: 'v1', channel_id: 'UCreal', youTubeChannelName: 'Real Ch' },
      ]);

      expect(PlaylistVideo.update).not.toHaveBeenCalled();
    });

    test('does not overwrite or create a channel when channel_id is already set, even if the downloaded id differs', async () => {
      // Playlist sync captured the owner channel; the .info.json reports the
      // auto-generated upload channel (VEVO/Topic). The stored owner id wins, so
      // no overwrite and no new channel.
      PlaylistVideo.findAll.mockResolvedValue([
        { playlist_id: 'PL1', youtube_id: 'v1', channel_id: 'UCowner' },
      ]);
      Channel.findAll.mockResolvedValue([]);
      Playlist.findAll.mockResolvedValue([
        { playlist_id: 'PL1', default_sub_folder: 'Library1', video_quality: '1080' },
      ]);

      await playlistModule.backfillDownloadedVideoChannels([
        { youtubeId: 'v1', channel_id: 'UCupload', youTubeChannelName: 'Artist - Topic' },
      ]);

      expect(PlaylistVideo.update).not.toHaveBeenCalled();
      expect(channelModule.upsertChannel).not.toHaveBeenCalled();
    });
  });

  describe('playlistAutoDownload', () => {
    test('invokes downloadModule.doPlaylistDownloads for each enabled playlist', async () => {
      Playlist.findAll.mockResolvedValue([
        { id: 1, playlist_id: 'PL1' },
        { id: 2, playlist_id: 'PL2' },
      ]);
      await playlistModule.playlistAutoDownload();
      expect(downloadModule.doPlaylistDownloads).toHaveBeenCalledTimes(2);
    });

    test('downloads each enabled auto_download playlist with refresh + recent limit', async () => {
      const pl1 = { playlist_id: 'PL1', title: 'One' };
      const pl2 = { playlist_id: 'PL2', title: 'Two' };
      Playlist.findAll.mockResolvedValue([pl1, pl2]);

      await playlistModule.playlistAutoDownload();

      expect(Playlist.findAll).toHaveBeenCalledWith({
        where: { enabled: true, auto_download: true },
      });
      expect(downloadModule.doPlaylistDownloads).toHaveBeenCalledTimes(2);
      expect(downloadModule.doPlaylistDownloads).toHaveBeenNthCalledWith(
        1,
        pl1,
        { refreshFirst: true, limitToRecent: true, overrideSettings: {} }
      );
      expect(downloadModule.doPlaylistDownloads).toHaveBeenNthCalledWith(
        2,
        pl2,
        { refreshFirst: true, limitToRecent: true, overrideSettings: {} }
      );
    });

    test('threads manual override settings through to each playlist download', async () => {
      const pl1 = { playlist_id: 'PL1', title: 'One' };
      const pl2 = { playlist_id: 'PL2', title: 'Two' };
      Playlist.findAll.mockResolvedValue([pl1, pl2]);

      await playlistModule.playlistAutoDownload({ resolution: '720', videoCount: 3 });

      expect(downloadModule.doPlaylistDownloads).toHaveBeenNthCalledWith(
        1,
        pl1,
        { refreshFirst: true, limitToRecent: true, overrideSettings: { resolution: '720', videoCount: 3 } }
      );
      expect(downloadModule.doPlaylistDownloads).toHaveBeenNthCalledWith(
        2,
        pl2,
        { refreshFirst: true, limitToRecent: true, overrideSettings: { resolution: '720', videoCount: 3 } }
      );
    });
  });

  describe('fetchAllPlaylistVideos published_at backfill', () => {
    function mockFlatPlaylist(entries) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      childProcess.spawn.mockReturnValue(child);
      setImmediate(() => {
        entries.forEach((e) => child.stdout.emit('data', JSON.stringify(e) + '\n'));
        child.emit('close', 0);
      });
    }

    beforeEach(() => {
      Playlist.findOne.mockResolvedValue({
        playlist_id: 'PL1',
        url: 'https://youtube.com/playlist?list=PL1',
        title_filter_regex: null,
        min_duration: null,
        max_duration: null,
        thumbnail: 'x',
        update: jest.fn().mockResolvedValue(undefined),
      });
      PlaylistVideo.findAll.mockResolvedValue([]);
      PlaylistVideo.bulkCreate.mockResolvedValue([]);
    });

    test('fills published_at from the YouTube API for videos missing a date', async () => {
      youtubeApi.isAvailable.mockReturnValue(true);
      youtubeApi.getApiKey.mockReturnValue('key123');
      youtubeApi.client.getVideoMetadata.mockResolvedValue([
        { id: 'a', uploadDate: '20240115' },
      ]);
      mockFlatPlaylist([{ id: 'a', title: 'A' }]);

      await playlistModule.fetchAllPlaylistVideos('PL1');

      expect(youtubeApi.client.getVideoMetadata).toHaveBeenCalledWith('key123', ['a']);
      const rows = PlaylistVideo.bulkCreate.mock.calls[0][0];
      expect(rows.find((r) => r.youtube_id === 'a').published_at).toBe('20240115');
    });

    test('does not call the API when it is unavailable', async () => {
      const logger = require('../../logger');
      youtubeApi.isAvailable.mockReturnValue(false);
      mockFlatPlaylist([{ id: 'a', title: 'A' }]);

      await playlistModule.fetchAllPlaylistVideos('PL1');

      expect(youtubeApi.client.getVideoMetadata).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      const rows = PlaylistVideo.bulkCreate.mock.calls[0][0];
      expect(rows.find((r) => r.youtube_id === 'a').published_at).toBeNull();
    });

    test('does not call the API for videos that already have a published date', async () => {
      youtubeApi.isAvailable.mockReturnValue(true);
      youtubeApi.getApiKey.mockReturnValue('key123');
      mockFlatPlaylist([{ id: 'a', title: 'A', upload_date: '20231201' }]);

      await playlistModule.fetchAllPlaylistVideos('PL1');

      expect(youtubeApi.client.getVideoMetadata).not.toHaveBeenCalled();
      const rows = PlaylistVideo.bulkCreate.mock.calls[0][0];
      expect(rows.find((r) => r.youtube_id === 'a').published_at).toBe('20231201');
    });

    test('proceeds with null dates when the API call throws', async () => {
      youtubeApi.isAvailable.mockReturnValue(true);
      youtubeApi.getApiKey.mockReturnValue('key123');
      youtubeApi.client.getVideoMetadata.mockRejectedValue(new Error('quota'));
      mockFlatPlaylist([{ id: 'a', title: 'A' }]);

      await expect(playlistModule.fetchAllPlaylistVideos('PL1')).resolves.toBeDefined();
      const rows = PlaylistVideo.bulkCreate.mock.calls[0][0];
      expect(rows.find((r) => r.youtube_id === 'a').published_at).toBeNull();
    });

    test('preserves a stored published_at instead of overwriting it with null when the API is unavailable', async () => {
      youtubeApi.isAvailable.mockReturnValue(false);
      PlaylistVideo.findAll.mockResolvedValue([
        { youtube_id: 'a', published_at: '20240115' },
      ]);
      mockFlatPlaylist([{ id: 'a', title: 'A' }]);

      await playlistModule.fetchAllPlaylistVideos('PL1');

      expect(youtubeApi.client.getVideoMetadata).not.toHaveBeenCalled();
      const rows = PlaylistVideo.bulkCreate.mock.calls[0][0];
      expect(rows.find((r) => r.youtube_id === 'a').published_at).toBe('20240115');
    });

    test('only queries the API for ids still missing after the DB preserve step', async () => {
      youtubeApi.isAvailable.mockReturnValue(true);
      youtubeApi.getApiKey.mockReturnValue('key123');
      PlaylistVideo.findAll.mockResolvedValue([
        { youtube_id: 'a', published_at: '20240115' },
      ]);
      youtubeApi.client.getVideoMetadata.mockResolvedValue([
        { id: 'b', uploadDate: '20240220' },
      ]);
      mockFlatPlaylist([
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
      ]);

      await playlistModule.fetchAllPlaylistVideos('PL1');

      expect(youtubeApi.client.getVideoMetadata).toHaveBeenCalledWith('key123', ['b']);
      const rows = PlaylistVideo.bulkCreate.mock.calls[0][0];
      expect(rows.find((r) => r.youtube_id === 'a').published_at).toBe('20240115');
      expect(rows.find((r) => r.youtube_id === 'b').published_at).toBe('20240220');
    });
  });

  describe('backfillSeasonPosters', () => {
    const playlist = { playlist_id: 'PL1', season_number: 1, channel_id: 'ch1', title: 'My Playlist', thumbnail: 'https://img.example.com/thumb.jpg' };

    beforeEach(() => {
      Channel.findOne.mockResolvedValue({ folder_name: 'My Channel', uploader: 'My Channel' });
      // Return false for Season##.jpg (doesn't exist yet) and cached thumbnail (not downloaded yet);
      // return true for outputDir and seasonFolderPath so the early-exit checks pass.
      fs.existsSync.mockImplementation((p) => !/Season\d+\.jpg$/.test(p) && !p.includes('playlistthumb'));
      axios.get.mockResolvedValue({ data: Buffer.from('img') });
    });

    it('downloads playlist thumbnail and copies as Season01.jpg', async () => {
      await playlistModule.backfillSeasonPosters([playlist]);

      expect(axios.get).toHaveBeenCalledWith(playlist.thumbnail, expect.objectContaining({ responseType: 'arraybuffer' }));
      expect(fs.copySync).toHaveBeenCalledWith(
        expect.stringContaining('playlistthumb-PL1.jpg'),
        expect.stringContaining('Season01.jpg')
      );
    });

    it('skips playlist with no season_number', async () => {
      await playlistModule.backfillSeasonPosters([{ ...playlist, season_number: null }]);
      expect(Channel.findOne).not.toHaveBeenCalled();
    });

    it('skips playlist with no channel_id and no uploader', async () => {
      await playlistModule.backfillSeasonPosters([{ ...playlist, channel_id: null }]);
      expect(Channel.findOne).not.toHaveBeenCalled();
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('uses uploader as channel folder name when channel_id is null', async () => {
      await playlistModule.backfillSeasonPosters([{ ...playlist, channel_id: null, uploader: 'My Channel' }]);

      expect(Channel.findOne).not.toHaveBeenCalled();
      expect(axios.get).toHaveBeenCalledWith(playlist.thumbnail, expect.objectContaining({ responseType: 'arraybuffer' }));
      expect(fs.copySync).toHaveBeenCalledWith(
        expect.stringContaining('playlistthumb-PL1.jpg'),
        expect.stringContaining('Season01.jpg')
      );
    });

    it('skips when writeSeasonPosters is false', async () => {
      configModule.getConfig.mockReturnValue({ writeSeasonPosters: false });

      await playlistModule.backfillSeasonPosters([playlist]);

      expect(axios.get).not.toHaveBeenCalled();
    });

    it('skips when Season01.jpg already exists', async () => {
      fs.existsSync.mockImplementation((p) => /Season\d+\.jpg$/.test(p) || p.includes('/library'));

      await playlistModule.backfillSeasonPosters([playlist]);

      expect(axios.get).not.toHaveBeenCalled();
    });

    it('falls back to episode thumbnail when thumbnail download fails', async () => {
      axios.get.mockRejectedValueOnce(new Error('network'));
      fs.readdirSync.mockReturnValue(['S01E001-Video.jpg']);

      await playlistModule.backfillSeasonPosters([playlist]);

      expect(fs.copySync).toHaveBeenCalledWith(
        expect.stringContaining('S01E001-Video.jpg'),
        expect.stringContaining('Season01.jpg')
      );
    });
  });

  describe('backfillShowNfoFiles', () => {
    const playlists = [
      { playlist_id: 'PL1', season_number: 1, channel_id: 'ch1', title: 'Season One' },
      { playlist_id: 'PL2', season_number: 2, channel_id: 'ch1', title: 'Season Two' },
    ];

    beforeEach(() => {
      Channel.findOne.mockResolvedValue({ folder_name: 'My Channel', uploader: 'My Channel', title: 'My Channel', description: '' });
      fs.existsSync.mockReturnValue(true);
      Playlist.findAll.mockResolvedValue([
        { season_number: 1, title: 'Season One' },
        { season_number: 2, title: 'Season Two' },
      ]);
    });

    it('writes tvshow.nfo with all seasons for the channel', async () => {
      await playlistModule.backfillShowNfoFiles(playlists);

      expect(nfoGenerator.writeShowNfoFile).toHaveBeenCalledWith(
        expect.stringContaining('My Channel'),
        expect.objectContaining({ title: 'My Channel' }),
        [
          { number: 1, title: 'Season One' },
          { number: 2, title: 'Season Two' },
        ]
      );
    });

    it('skips playlists with no season_number', async () => {
      await playlistModule.backfillShowNfoFiles([{ ...playlists[0], season_number: null }]);
      expect(nfoGenerator.writeShowNfoFile).not.toHaveBeenCalled();
    });

    it('skips when writeVideoNfoFiles is false', async () => {
      configModule.getConfig.mockReturnValue({ writeVideoNfoFiles: false });

      await playlistModule.backfillShowNfoFiles(playlists);

      expect(nfoGenerator.writeShowNfoFile).not.toHaveBeenCalled();
    });

    it('skips when channel folder does not exist on disk', async () => {
      fs.existsSync.mockReturnValue(false);

      await playlistModule.backfillShowNfoFiles(playlists);

      expect(nfoGenerator.writeShowNfoFile).not.toHaveBeenCalled();
    });

    it('writes tvshow.nfo using uploader scope when channel_id is null', async () => {
      const uploaderPlaylists = [
        { playlist_id: 'PL1', season_number: 1, channel_id: null, title: 'Season One', uploader: 'My Channel' },
        { playlist_id: 'PL2', season_number: 2, channel_id: null, title: 'Season Two', uploader: 'My Channel' },
      ];

      await playlistModule.backfillShowNfoFiles(uploaderPlaylists);

      expect(Channel.findOne).not.toHaveBeenCalled();
      expect(nfoGenerator.writeShowNfoFile).toHaveBeenCalledWith(
        expect.stringContaining('My Channel'),
        {},
        [
          { number: 1, title: 'Season One' },
          { number: 2, title: 'Season Two' },
        ]
      );
    });
  });

  describe('backfillPlexSeasonTitles', () => {
    const playlist = {
      playlist_id: 'PL1',
      season_number: 1,
      channel_id: 'ch1',
      title: 'Cataclysm: Aftershock',
      uploader: 'Rycon',
    };

    beforeEach(() => {
      Channel.findOne.mockResolvedValue({ folder_name: 'Rycon', uploader: 'Rycon' });
    });

    it('calls renameSeasonInPlex with resolved channel folder name and playlist title', async () => {
      await playlistModule.backfillPlexSeasonTitles([playlist]);

      expect(plexModule.renameSeasonInPlex).toHaveBeenCalledWith('Rycon', 1, 'Cataclysm: Aftershock');
    });

    it('skips playlist with no season_number', async () => {
      await playlistModule.backfillPlexSeasonTitles([{ ...playlist, season_number: null }]);
      expect(plexModule.renameSeasonInPlex).not.toHaveBeenCalled();
    });

    it('skips playlist with no title', async () => {
      await playlistModule.backfillPlexSeasonTitles([{ ...playlist, title: null }]);
      expect(plexModule.renameSeasonInPlex).not.toHaveBeenCalled();
    });

    it('skips playlist with no channel_id and no uploader', async () => {
      await playlistModule.backfillPlexSeasonTitles([{ ...playlist, channel_id: null, uploader: null }]);
      expect(plexModule.renameSeasonInPlex).not.toHaveBeenCalled();
    });

    it('uses uploader as folder name when channel_id is null', async () => {
      await playlistModule.backfillPlexSeasonTitles([{ ...playlist, channel_id: null, uploader: 'Rycon' }]);

      expect(Channel.findOne).not.toHaveBeenCalled();
      expect(plexModule.renameSeasonInPlex).toHaveBeenCalledWith('Rycon', 1, 'Cataclysm: Aftershock');
    });

    it('processes multiple playlists', async () => {
      const pl2 = { ...playlist, playlist_id: 'PL2', season_number: 2, title: 'Arc Two' };
      await playlistModule.backfillPlexSeasonTitles([playlist, pl2]);

      expect(plexModule.renameSeasonInPlex).toHaveBeenCalledTimes(2);
      expect(plexModule.renameSeasonInPlex).toHaveBeenCalledWith('Rycon', 1, 'Cataclysm: Aftershock');
      expect(plexModule.renameSeasonInPlex).toHaveBeenCalledWith('Rycon', 2, 'Arc Two');
    });
  });

  describe('deletePlaylist', () => {
    let mockPlaylist;

    beforeEach(() => {
      mockPlaylist = {
        id: 42,
        playlist_id: 'PLxyz',
        title: 'My Playlist',
        season_number: 1,
        channel_id: 'UCabc',
        uploader: 'TestChannel',
        destroy: jest.fn().mockResolvedValue(undefined),
      };
      PlaylistSyncState.destroy.mockResolvedValue(1);
      PlaylistVideo.destroy.mockResolvedValue(5);
      Playlist.findAll.mockResolvedValue([]);
      Channel.findOne.mockResolvedValue({ folder_name: 'TestChannel', uploader: 'TestChannel' });
    });

    it('deletes PlaylistSyncState, PlaylistVideo, and the playlist record', async () => {
      await playlistModule.deletePlaylist(mockPlaylist, {});

      expect(PlaylistSyncState.destroy).toHaveBeenCalledWith({ where: { playlist_id: 42 } });
      expect(PlaylistVideo.destroy).toHaveBeenCalledWith({ where: { playlist_id: 'PLxyz' } });
      expect(mockPlaylist.destroy).toHaveBeenCalled();
    });

    it('removes the M3U file', async () => {
      await playlistModule.deletePlaylist(mockPlaylist, {});

      const removedPaths = fs.remove.mock.calls.map(([p]) => p);
      expect(removedPaths.some(p => p.includes('__playlists__') && p.endsWith('.m3u'))).toBe(true);
    });

    it('removes the cached thumbnail', async () => {
      await playlistModule.deletePlaylist(mockPlaylist, {});

      const removedPaths = fs.remove.mock.calls.map(([p]) => p);
      expect(removedPaths.some(p => p.includes('playlistthumb-PLxyz.jpg'))).toBe(true);
    });

    it('rebuilds tvshow.nfo for the remaining seasons when season_number is set', async () => {
      const remaining = [{ channel_id: 'UCabc', uploader: null, season_number: 2, title: 'Arc Two' }];
      // Needs 2 findAll calls: one in deletePlaylist to get remaining playlists,
      // another inside backfillShowNfoFiles to get the full ordered season list.
      Playlist.findAll
        .mockResolvedValueOnce(remaining)
        .mockResolvedValueOnce(remaining);
      // backfillShowNfoFiles skips if the channel folder doesn't exist on disk.
      fs.existsSync.mockReturnValue(true);

      await playlistModule.deletePlaylist(mockPlaylist, {});

      expect(Playlist.findAll).toHaveBeenCalledWith({ where: { channel_id: 'UCabc' } });
      expect(nfoGenerator.writeShowNfoFile).toHaveBeenCalled();
    });

    it('skips tvshow.nfo rebuild when season_number is null', async () => {
      mockPlaylist.season_number = null;
      await playlistModule.deletePlaylist(mockPlaylist, {});

      expect(Playlist.findAll).not.toHaveBeenCalled();
      expect(nfoGenerator.writeShowNfoFile).not.toHaveBeenCalled();
    });

    it('skips tvshow.nfo rebuild when deleteFiles is true (channel folder is removed)', async () => {
      fs.existsSync.mockReturnValue(true);
      await playlistModule.deletePlaylist(mockPlaylist, { deleteFiles: true });

      expect(nfoGenerator.writeShowNfoFile).not.toHaveBeenCalled();
    });

    it('does not delete channel folder when deleteFiles is false', async () => {
      await playlistModule.deletePlaylist(mockPlaylist, { deleteFiles: false });

      const removedPaths = fs.remove.mock.calls.map(([p]) => p);
      // Only M3U and thumbnail should be removed — not a folder named after the channel.
      expect(removedPaths.some(p => p.includes('TestChannel') && !p.includes('__playlists__') && !p.includes('playlistthumb'))).toBe(false);
    });

    it('deletes the entire channel folder when deleteFiles is true', async () => {
      await playlistModule.deletePlaylist(mockPlaylist, { deleteFiles: true });

      const removedPaths = fs.remove.mock.calls.map(([p]) => p);
      // Should remove a path ending in the channel folder name (no season subfolder).
      expect(removedPaths.some(p => p.endsWith('TestChannel') || p.endsWith('TestChannel\\') || p.endsWith('TestChannel/'))).toBe(true);
    });

    it('uses uploader as folder name when channel lookup yields nothing', async () => {
      mockPlaylist.channel_id = null;

      await playlistModule.deletePlaylist(mockPlaylist, { deleteFiles: true });

      const removedPaths = fs.remove.mock.calls.map(([p]) => p);
      expect(removedPaths.some(p => p.endsWith('TestChannel') || p.endsWith('TestChannel\\') || p.endsWith('TestChannel/'))).toBe(true);
    });
  });
});
