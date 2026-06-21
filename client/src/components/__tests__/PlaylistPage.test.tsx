import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import PlaylistPage from '../PlaylistPage';
import { renderWithProviders } from '../../test-utils';
import { PlaylistVideo } from '../../types/playlist';

jest.mock('axios', () => ({
  delete: jest.fn(),
  isAxiosError: jest.fn(() => false),
}));

const mockTriggerDownload = jest.fn();
const mockNavigate = jest.fn();
const mockToggleAutoDownload = jest.fn();
const mockMarkVideoDeleted = jest.fn();
const mockRefetchMeta = jest.fn();

const mockVideo: PlaylistVideo = {
  id: 1,
  playlist_id: 'PL1',
  youtube_id: 'vidA',
  position: 1,
  added_at: null,
  channel_id: null,
  ignored: false,
  ignored_at: null,
  title: 'Vid A',
  channel_name: 'Chan',
  duration: 60,
  published_at: null,
  thumbnail: null,
  downloaded: false,
  previously_downloaded: false,
  youtube_removed: false,
  video_id: null,
  file_path: null,
  file_size: null,
};

const mockMissingVideo: PlaylistVideo = {
  ...mockVideo,
  id: 2,
  youtube_id: 'vidB',
  position: 2,
  title: 'Vid B',
  previously_downloaded: true,
};

const mockPlaylist = {
  playlist_id: 'PL1',
  title: 'My Playlist',
  uploader: 'Owner',
  video_count: 1,
  lastFetched: null,
  thumbnail: null,
  public_on_servers: false,
  auto_download: false,
};

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ id: 'PL1' }),
  useNavigate: () => mockNavigate,
}));

jest.mock('../../hooks/useConfig', () => ({
  useConfig: () => ({ config: { preferredResolution: '1080' } }),
}));

jest.mock('../DownloadManager/ManualDownload/DownloadSettingsDialog', () => ({
  __esModule: true,
  default: ({
    open,
    onConfirm,
    missingVideoCount,
  }: {
    open: boolean;
    onConfirm: (s: unknown) => void;
    missingVideoCount?: number;
  }) => {
    const React = require('react');
    if (!open) return null;
    return React.createElement(
      'div',
      null,
      React.createElement(
        'div',
        { 'data-testid': 'mock-dialog-missing-count' },
        String(missingVideoCount)
      ),
      React.createElement(
        'button',
        { 'data-testid': 'mock-confirm-download', onClick: () => onConfirm(null) },
        'confirm'
      )
    );
  },
}));

jest.mock('../../hooks/useMediaQuery', () => ({
  useMediaQuery: () => true, // mobile: cards + a directly-clickable selection action
}));

jest.mock('../../hooks/usePlaylistDetail', () => ({
  usePlaylistDetail: () => ({
    playlist: mockPlaylist,
    videos: [mockVideo, mockMissingVideo],
    notDownloadedCount: 1,
    loading: false,
    loadingMore: false,
    hasMore: false,
    error: null,
    loadMore: jest.fn(),
    refetch: jest.fn(),
    refetchMeta: (...args: unknown[]) => mockRefetchMeta(...args),
    markVideoIgnored: jest.fn(),
    markVideoDeleted: (...args: unknown[]) => mockMarkVideoDeleted(...args),
    refresh: jest.fn(),
    sync: jest.fn(),
    regenerateM3U: jest.fn(),
    triggerDownload: (...args: unknown[]) => mockTriggerDownload(...args),
  }),
}));

jest.mock('../../hooks/usePlaylistMutations', () => ({
  usePlaylistMutations: () => ({
    pending: false,
    toggleSyncTarget: jest.fn(),
    togglePublic: jest.fn(),
    toggleAutoDownload: (...args: unknown[]) => mockToggleAutoDownload(...args),
    ignoreVideo: jest.fn(),
    unignoreVideo: jest.fn(),
  }),
}));

jest.mock('../../hooks/useMediaServerStatus', () => ({
  useMediaServerStatus: () => ({ status: {}, anyConfigured: true }),
}));

jest.mock('../PlaylistPage/components/PlaylistSyncChips', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../PlaylistPage/components/NoMediaServerWarning', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../PlaylistPage/components/PlaylistSettingsDialog', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../shared/SubscriptionsBackButton', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../shared/VideoModal', () => ({
  __esModule: true,
  default: ({
    video,
    onVideoDeleted,
  }: {
    video: { youtubeId: string };
    onVideoDeleted?: (ytId: string) => void;
  }) => {
    const React = require('react');
    return React.createElement(
      'button',
      {
        'data-testid': 'mock-modal-delete-video',
        onClick: () => onVideoDeleted?.(video.youtubeId),
      },
      'delete video'
    );
  },
}));

describe('PlaylistPage selected-download selection lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('keeps the selection when the download fails so the user can retry', async () => {
    const user = userEvent.setup();
    mockTriggerDownload.mockRejectedValue(new Error('download blew up'));

    renderWithProviders(<PlaylistPage token="t" />);

    await user.click(screen.getByRole('checkbox', { name: 'Select Vid A' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.click(screen.getByTestId('selection-action-download'));
    await user.click(await screen.findByTestId('mock-confirm-download'));

    expect(await screen.findByText('download blew up')).toBeInTheDocument();
    expect(mockTriggerDownload).toHaveBeenCalledWith(['vidA'], undefined);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  test('clears the selection and navigates after a successful download', async () => {
    const user = userEvent.setup();
    mockTriggerDownload.mockResolvedValue(undefined);

    renderWithProviders(<PlaylistPage token="t" />);

    await user.click(screen.getByRole('checkbox', { name: 'Select Vid A' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.click(screen.getByTestId('selection-action-download'));
    await user.click(await screen.findByTestId('mock-confirm-download'));

    await waitFor(() => expect(mockTriggerDownload).toHaveBeenCalledWith(['vidA'], undefined));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/downloads/activity'));
    await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument());
  });

  test('Download new opens the dialog and downloads all videos on confirm', async () => {
    const user = userEvent.setup();
    mockTriggerDownload.mockResolvedValue(undefined);

    renderWithProviders(<PlaylistPage token="t" />);

    await user.click(screen.getByRole('button', { name: /Download 1 new/i }));
    await user.click(await screen.findByTestId('mock-confirm-download'));

    await waitFor(() => expect(mockTriggerDownload).toHaveBeenCalledWith(undefined, undefined));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/downloads/activity'));
  });

  test('passes missingVideoCount 1 when a previously-downloaded video is selected', async () => {
    const user = userEvent.setup();

    renderWithProviders(<PlaylistPage token="t" />);

    await user.click(screen.getByRole('checkbox', { name: 'Select Vid B' }));
    await user.click(screen.getByTestId('selection-action-download'));

    expect(await screen.findByTestId('mock-dialog-missing-count')).toHaveTextContent('1');
  });

  test('passes missingVideoCount 0 when only never-downloaded videos are selected', async () => {
    const user = userEvent.setup();

    renderWithProviders(<PlaylistPage token="t" />);

    await user.click(screen.getByRole('checkbox', { name: 'Select Vid A' }));
    await user.click(screen.getByTestId('selection-action-download'));

    expect(await screen.findByTestId('mock-dialog-missing-count')).toHaveTextContent('0');
  });

  test('passes missingVideoCount 0 for Download new even when missing videos exist', async () => {
    const user = userEvent.setup();

    renderWithProviders(<PlaylistPage token="t" />);

    await user.click(screen.getByRole('button', { name: /Download 1 new/i }));

    expect(await screen.findByTestId('mock-dialog-missing-count')).toHaveTextContent('0');
  });

  test('toggling the auto-download switch turns the playlist setting on', async () => {
    const user = userEvent.setup();
    mockToggleAutoDownload.mockResolvedValue({ ...mockPlaylist, auto_download: true });

    renderWithProviders(<PlaylistPage token="t" />);

    await user.click(screen.getByRole('checkbox', { name: /Auto-download new videos/i }));

    await waitFor(() =>
      expect(mockToggleAutoDownload).toHaveBeenCalledWith('PL1', true)
    );
  });

  test('marks the row deleted in place and refreshes meta when the modal reports a deletion', async () => {
    const user = userEvent.setup();

    renderWithProviders(<PlaylistPage token="t" />);

    // Open the modal by clicking the video card, then delete from the modal.
    await user.click(screen.getByText('Vid A'));
    await user.click(await screen.findByTestId('mock-modal-delete-video'));

    expect(mockMarkVideoDeleted).toHaveBeenCalledWith('vidA');
    expect(mockRefetchMeta).toHaveBeenCalled();
  });

  test('renders the sort control defaulting to newest first', () => {
    renderWithProviders(<PlaylistPage token="t" />);

    const sortControl = screen.getByRole('button', { name: 'Sort' });
    expect(sortControl).toHaveTextContent('Newest first');
  });
});

describe('PlaylistPage delete dialog', () => {
  let mockAxios: { delete: jest.Mock; isAxiosError: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAxios = require('axios');
    mockAxios.delete.mockResolvedValue({});
  });

  test('clicking the delete button opens the confirmation dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlaylistPage token="t" />);

    await user.click(screen.getByRole('button', { name: /Delete playlist/i }));

    expect(await screen.findByText('Delete playlist?')).toBeInTheDocument();
  });

  test('Cancel closes the dialog without calling delete', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlaylistPage token="t" />);

    await user.click(screen.getByRole('button', { name: /Delete playlist/i }));
    await screen.findByText('Delete playlist?');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText('Delete playlist?')).not.toBeInTheDocument());
    expect(mockAxios.delete).not.toHaveBeenCalled();
  });

  test('confirming delete calls DELETE /api/playlists/:id with deleteFiles=false and navigates', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlaylistPage token="t" />);

    await user.click(screen.getByRole('button', { name: /Delete playlist/i }));
    await screen.findByText('Delete playlist?');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mockAxios.delete).toHaveBeenCalledWith(
      '/api/playlists/PL1',
      expect.objectContaining({ data: { deleteFiles: false } })
    ));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/subscriptions?tab=playlists'));
  });

  test('on API failure shows error snackbar and does not navigate', async () => {
    const user = userEvent.setup();
    mockAxios.delete.mockRejectedValue(new Error('server error'));
    renderWithProviders(<PlaylistPage token="t" />);

    await user.click(screen.getByRole('button', { name: /Delete playlist/i }));
    await screen.findByText('Delete playlist?');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Failed to delete playlist')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
