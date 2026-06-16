'use strict';

// Adds channel_id and season_number to playlists so playlist downloads can be
// organized as Plex TV-show seasons (Channel = show, Playlist = season).
// Both are assigned lazily on first download (see downloadModule.doPlaylistDownloads)
// rather than backfilled here.
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('playlists');

    if (!table.channel_id) {
      await queryInterface.addColumn('playlists', 'channel_id', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
    if (!table.season_number) {
      await queryInterface.addColumn('playlists', 'season_number', {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('playlists');
    if (table.season_number) await queryInterface.removeColumn('playlists', 'season_number');
    if (table.channel_id) await queryInterface.removeColumn('playlists', 'channel_id');
  },
};
