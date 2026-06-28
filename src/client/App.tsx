import {
  Copy,
  LogIn,
  LogOut,
  Music2,
  RefreshCw,
  Trash2,
  Upload
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  ApiErrorResponse,
  ApiRange,
  AuthConfigResponse,
  AuthStartResponse,
  HistoryRange,
  HistoryRecord,
  RecentlyPlayedItem,
  SessionResponse,
  SpotifyArtist,
  SpotifyPaging,
  SpotifyProfile,
  SpotifyTrack
} from "../shared/types";

const DB_NAME = "spotistats-db";
const DB_VERSION = 1;
const HISTORY_STORE = "history";
const CLIENT_ID_KEY = "spotistats.clientId";

const apiRanges: Array<{ id: ApiRange; label: string }> = [
  { id: "short_term", label: "4 weeks" },
  { id: "medium_term", label: "6 months" },
  { id: "long_term", label: "Long term" }
];

const historyRanges: Array<{ id: HistoryRange; label: string; days: number | null }> = [
  { id: "all", label: "All time", days: null },
  { id: "365", label: "Last year", days: 365 },
  { id: "90", label: "Last 3 months", days: 90 },
  { id: "30", label: "Last month", days: 30 },
  { id: "7", label: "Last week", days: 7 }
];

interface Notice {
  type: "success" | "error" | "info";
  message: string;
}

interface HistoryStats {
  totalMs: number;
  recordCount: number;
  artistCount: number;
  trackCount: number;
  topArtist: ArtistStat | null;
  topArtists: ArtistStat[];
  topTracks: TrackStat[];
}

interface ArtistStat {
  name: string;
  ms: number;
  plays: number;
}

interface TrackStat {
  artist: string;
  track: string;
  ms: number;
  plays: number;
}

interface RecentStats {
  totalMs: number;
  playCount: number;
  artistCount: number;
  firstPlayed: Date | null;
}

export function App() {
  const [config, setConfig] = useState<AuthConfigResponse | null>(null);
  const [clientId, setClientId] = useState(() => localStorage.getItem(CLIENT_ID_KEY) || "");
  const [authenticated, setAuthenticated] = useState(false);
  const [profile, setProfile] = useState<SpotifyProfile | null>(null);
  const [topArtists, setTopArtists] = useState<SpotifyArtist[]>([]);
  const [topTracks, setTopTracks] = useState<SpotifyTrack[]>([]);
  const [recent, setRecent] = useState<RecentlyPlayedItem[]>([]);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [apiRange, setApiRange] = useState<ApiRange>("medium_term");
  const [historyRange, setHistoryRange] = useState<HistoryRange>("all");
  const [isLoadingSpotify, setIsLoadingSpotify] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const historyStats = useMemo(() => getHistoryStats(history, historyRange), [history, historyRange]);
  const recentStats = useMemo(() => getRecentStats(recent), [recent]);

  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => {
    localStorage.setItem(CLIENT_ID_KEY, clientId.trim());
  }, [clientId]);

  async function boot() {
    try {
      const [configResponse, sessionResponse, historyRecords] = await Promise.all([
        apiGet<AuthConfigResponse>("/api/auth/config"),
        apiGet<SessionResponse>("/api/session"),
        loadHistory()
      ]);
      const params = new URLSearchParams(window.location.search);
      const authError = params.get("authError");
      const connected = params.get("connected");

      setConfig(configResponse);
      setHistory(historyRecords);
      setAuthenticated(sessionResponse.authenticated);

      if (sessionResponse.clientId) {
        setClientId(sessionResponse.clientId);
      }

      if (authError) {
        setNotice({ type: "error", message: authError });
      } else if (connected) {
        setNotice({ type: "success", message: "Spotify connected." });
      }

      if (authError || connected) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }

      if (sessionResponse.authenticated) {
        await loadSpotifyData();
      }
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
    }
  }

  async function startLogin() {
    const trimmedClientId = clientId.trim();

    if (!trimmedClientId) {
      setNotice({ type: "error", message: "Paste your Spotify app Client ID before logging in." });
      return;
    }

    try {
      const payload = await apiPost<AuthStartResponse>("/api/auth/start", { clientId: trimmedClientId });
      window.location.href = payload.authorizeUrl;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
    }
  }

  async function loadSpotifyData(nextRange: ApiRange = apiRange) {
    setIsLoadingSpotify(true);

    try {
      const query = new URLSearchParams({ time_range: nextRange });
      const [profilePayload, artistsPayload, tracksPayload, recentPayload] = await Promise.all([
        apiGet<SpotifyProfile>("/api/me"),
        apiGet<SpotifyPaging<SpotifyArtist>>(`/api/top/artists?${query.toString()}`),
        apiGet<SpotifyPaging<SpotifyTrack>>(`/api/top/tracks?${query.toString()}`),
        apiGet<SpotifyPaging<RecentlyPlayedItem>>("/api/recent")
      ]);

      setAuthenticated(true);
      setProfile(profilePayload);
      setTopArtists(artistsPayload.items || []);
      setTopTracks(tracksPayload.items || []);
      setRecent(recentPayload.items || []);
      setNotice({ type: "success", message: `Spotify stats updated for ${apiRangeLabel(nextRange)}.` });
    } catch (error) {
      if (isReauthorizationError(error)) {
        setAuthenticated(false);
        setProfile(null);
        setTopArtists([]);
        setTopTracks([]);
        setRecent([]);
      }

      setNotice({ type: "error", message: errorMessage(error) });
    } finally {
      setIsLoadingSpotify(false);
    }
  }

  async function logout() {
    try {
      await apiPost<SessionResponse>("/api/auth/logout", {});
    } finally {
      setAuthenticated(false);
      setProfile(null);
      setTopArtists([]);
      setTopTracks([]);
      setRecent([]);
      setNotice({ type: "info", message: "Signed out of Spotify." });
    }
  }

  async function copyRedirectUri() {
    if (!config) return;

    try {
      await navigator.clipboard.writeText(config.redirectUri);
      setNotice({ type: "success", message: "Redirect URI copied." });
    } catch {
      setNotice({ type: "error", message: "Could not copy. Select the redirect URI field instead." });
    }
  }

  async function importHistoryFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);

    if (!files.length) {
      return;
    }

    setIsImporting(true);
    setNotice({ type: "info", message: `Reading ${files.length} file${files.length === 1 ? "" : "s"}...` });

    try {
      const normalized: HistoryRecord[] = [];
      const errors: string[] = [];

      for (const file of files) {
        try {
          const text = await file.text();
          const data = JSON.parse(text) as unknown;

          if (!Array.isArray(data)) {
            throw new Error("Expected a JSON array.");
          }

          normalized.push(...data.map(normalizeHistoryRecord).filter(isHistoryRecord));
        } catch (fileError) {
          errors.push(`${file.name}: ${errorMessage(fileError)}`);
        }
      }

      if (!normalized.length) {
        throw new Error(errors[0] || "No playable listening records found.");
      }

      const deduped = dedupeRecords(normalized);
      await saveHistory(deduped);
      setHistory(await loadHistory());
      setHistoryRange("all");
      setNotice({
        type: errors.length ? "info" : "success",
        message: `Imported ${formatNumber(deduped.length)} plays from ${files.length} file${files.length === 1 ? "" : "s"}.`
      });
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
    } finally {
      setIsImporting(false);
      event.target.value = "";
    }
  }

  async function clearImportedHistory() {
    const confirmed = window.confirm("Clear imported listening history from this browser?");

    if (!confirmed) {
      return;
    }

    await clearHistory();
    setHistory([]);
    setNotice({ type: "info", message: "Imported history cleared." });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Spotistats home">
          <span className="brand-mark"><Music2 size={20} /></span>
          <span>
            <strong>Spotistats</strong>
            <small>full-stack Spotify listening dashboard</small>
          </span>
        </a>

        {authenticated ? (
          <div className="session">
            {profile?.images?.[0]?.url ? <img src={profile.images[0].url} alt="" className="avatar" /> : <span className="avatar avatar-fallback">{initials(profile?.display_name || profile?.id || "S")}</span>}
            <span className="session-name">{profile?.display_name || profile?.id || "Spotify"}</span>
            <button className="ghost-button" type="button" onClick={() => void loadSpotifyData()}>
              <RefreshCw size={16} /> Refresh
            </button>
            <button className="ghost-button" type="button" onClick={() => void logout()}>
              <LogOut size={16} /> Sign out
            </button>
          </div>
        ) : null}
      </header>

      {notice ? (
        <div className={`notice notice-${notice.type}`} role="status">
          <span>{notice.message}</span>
          <button type="button" className="notice-close" aria-label="Dismiss" onClick={() => setNotice(null)}>x</button>
        </div>
      ) : null}

      {authenticated ? (
        <Dashboard
          topArtists={topArtists}
          topTracks={topTracks}
          recent={recent}
          history={history}
          historyStats={historyStats}
          recentStats={recentStats}
          apiRange={apiRange}
          historyRange={historyRange}
          isLoadingSpotify={isLoadingSpotify}
          isImporting={isImporting}
          onRangeChange={(range) => {
            setApiRange(range);
            void loadSpotifyData(range);
          }}
          onHistoryRangeChange={setHistoryRange}
          onHistoryImport={(event) => void importHistoryFiles(event)}
          onClearHistory={() => void clearImportedHistory()}
        />
      ) : (
        <AuthPanel
          clientId={clientId}
          config={config}
          onClientIdChange={setClientId}
          onLogin={() => void startLogin()}
          onCopyRedirect={() => void copyRedirectUri()}
        />
      )}
    </div>
  );
}

function AuthPanel({
  clientId,
  config,
  onClientIdChange,
  onLogin,
  onCopyRedirect
}: {
  clientId: string;
  config: AuthConfigResponse | null;
  onClientIdChange: (value: string) => void;
  onLogin: () => void;
  onCopyRedirect: () => void;
}) {
  return (
    <main className="auth-layout">
      <section className="auth-visual" aria-label="Spotistats preview">
        <div className="cover-grid" aria-hidden="true">
          {Array.from({ length: 18 }, (_, index) => <span className={`cover-tile tile-${index + 1}`} key={index} />)}
        </div>
        <div className="auth-copy">
          <p className="eyebrow">Spotify account insights</p>
          <h1>Your listening patterns, pulled into one sharp view.</h1>
          <p>Top artists, favorite tracks, recent plays, and exact time-listened stats when you import Spotify history files.</p>
        </div>
      </section>

      <section className="auth-panel" aria-labelledby="connect-heading">
        <p className="eyebrow">Connect</p>
        <h2 id="connect-heading">Spotify Login</h2>
        <label className="field">
          <span>Client ID</span>
          <input value={clientId} onChange={(event) => onClientIdChange(event.target.value)} spellCheck={false} autoComplete="off" placeholder="Paste your Spotify app client ID" />
        </label>
        <label className="field">
          <span>Redirect URI</span>
          <input value={config?.redirectUri || "Loading redirect URI..."} readOnly />
        </label>
        <div className="button-row">
          <button className="primary-button" type="button" onClick={onLogin}>
            <LogIn size={17} /> Log in with Spotify
          </button>
          <button className="secondary-button" type="button" onClick={onCopyRedirect} disabled={!config}>
            <Copy size={17} /> Copy redirect URI
          </button>
        </div>
        <dl className="setup-list">
          <div>
            <dt>Scopes</dt>
            <dd>{config?.scopes.join(", ") || "Loading scopes..."}</dd>
          </div>
          <div>
            <dt>Token handling</dt>
            <dd>Expired refresh tokens are discarded before asking you to sign in again.</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}

function Dashboard({
  topArtists,
  topTracks,
  recent,
  history,
  historyStats,
  recentStats,
  apiRange,
  historyRange,
  isLoadingSpotify,
  isImporting,
  onRangeChange,
  onHistoryRangeChange,
  onHistoryImport,
  onClearHistory
}: {
  topArtists: SpotifyArtist[];
  topTracks: SpotifyTrack[];
  recent: RecentlyPlayedItem[];
  history: HistoryRecord[];
  historyStats: HistoryStats;
  recentStats: RecentStats;
  apiRange: ApiRange;
  historyRange: HistoryRange;
  isLoadingSpotify: boolean;
  isImporting: boolean;
  onRangeChange: (range: ApiRange) => void;
  onHistoryRangeChange: (range: HistoryRange) => void;
  onHistoryImport: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onClearHistory: () => void;
}) {
  return (
    <main className="dashboard">
      <section className="summary-grid" aria-label="Listening summary">
        <Metric label="Imported minutes" value={formatDuration(historyStats.totalMs)} helper={historyStats.recordCount ? `${formatNumber(historyStats.recordCount)} plays` : "No history import"} />
        <Metric label="Top imported artist" value={historyStats.topArtist?.name || "Waiting for data"} helper={historyStats.topArtist ? formatDuration(historyStats.topArtist.ms) : "Import Spotify JSON"} />
        <Metric label="Recent sample" value={formatDuration(recentStats.totalMs)} helper={recentStats.playCount ? `${recentStats.playCount} Spotify API plays` : "Refresh Spotify"} />
        <Metric label="Top API artist" value={topArtists[0]?.name || "Loading"} helper={apiRangeLabel(apiRange)} />
      </section>

      <section className="workspace">
        <div className="panel panel-live">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Spotify API</p>
              <h2>Top music</h2>
            </div>
            <SegmentedControl options={apiRanges} selected={apiRange} onChange={onRangeChange} />
          </div>
          {isLoadingSpotify ? <Loading label="Loading Spotify stats" /> : <SpotifyStats topArtists={topArtists} topTracks={topTracks} />}
        </div>

        <div className="panel panel-history">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Local history</p>
              <h2>Time listened</h2>
            </div>
            <SegmentedControl options={historyRanges} selected={historyRange} onChange={onHistoryRangeChange} />
          </div>
          <HistoryImporter isImporting={isImporting} hasHistory={Boolean(history.length)} onImport={onHistoryImport} onClear={onClearHistory} />
          <HistoryStatsView stats={historyStats} hasHistory={Boolean(history.length)} range={historyRange} />
        </div>
      </section>

      <section className="panel panel-recent">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Recent plays</p>
            <h2>Last Spotify sample</h2>
          </div>
          <span className="muted">{recent.length ? `${recent.length} plays` : "No plays loaded"}</span>
        </div>
        <RecentStatsView recent={recent} stats={recentStats} />
      </section>
    </main>
  );
}

function Metric({ label, value, helper }: { label: string; value: string; helper: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{helper}</small>
    </article>
  );
}

function SegmentedControl<T extends string>({
  options,
  selected,
  onChange
}: {
  options: Array<{ id: T; label: string }>;
  selected: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((option) => (
        <button type="button" className={option.id === selected ? "active" : ""} onClick={() => onChange(option.id)} key={option.id}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="loading-state" aria-live="polite">
      <span className="loader" />
      <span>{label}</span>
    </div>
  );
}

function SpotifyStats({ topArtists, topTracks }: { topArtists: SpotifyArtist[]; topTracks: SpotifyTrack[] }) {
  if (!topArtists.length && !topTracks.length) {
    return (
      <div className="empty-state">
        <h3>No Spotify stats yet</h3>
        <p>Refresh after logging in, or reconnect if Spotify asks for permission again.</p>
      </div>
    );
  }

  return (
    <div className="live-columns">
      <section aria-labelledby="artists-heading">
        <h3 id="artists-heading">Artists</h3>
        <div className="rank-grid">
          {topArtists.slice(0, 12).map((artist, index) => <ArtistCard artist={artist} index={index} key={artist.id || artist.name} />)}
        </div>
      </section>
      <section aria-labelledby="tracks-heading">
        <h3 id="tracks-heading">Tracks</h3>
        <div className="track-list">
          {topTracks.slice(0, 12).map((track, index) => <TrackRow track={track} index={index} key={track.id || `${track.name}-${index}`} />)}
        </div>
      </section>
    </div>
  );
}

function ArtistCard({ artist, index }: { artist: SpotifyArtist; index: number }) {
  const image = artist.images?.[0]?.url;
  const genres = artist.genres?.length ? artist.genres.slice(0, 2).join(", ") : "Artist";
  const spotifyUrl = artist.external_urls?.spotify || "#";

  return (
    <a className="artist-card" href={spotifyUrl} target="_blank" rel="noreferrer">
      <span className="rank">#{index + 1}</span>
      {image ? <img src={image} alt="" /> : <span className="image-fallback">{initials(artist.name)}</span>}
      <strong>{artist.name}</strong>
      <small>{genres}</small>
    </a>
  );
}

function TrackRow({ track, index }: { track: SpotifyTrack; index: number }) {
  const image = track.album?.images?.[1]?.url || track.album?.images?.[0]?.url;
  const artists = track.artists?.map((artist) => artist.name).join(", ") || "Unknown artist";
  const spotifyUrl = track.external_urls?.spotify || "#";

  return (
    <a className="track-row" href={spotifyUrl} target="_blank" rel="noreferrer">
      <span className="track-rank">{index + 1}</span>
      {image ? <img src={image} alt="" /> : <span className="track-art">{initials(track.name)}</span>}
      <span>
        <strong>{track.name}</strong>
        <small>{artists}</small>
      </span>
      <em>{formatDuration(track.duration_ms || 0)}</em>
    </a>
  );
}

function HistoryImporter({
  isImporting,
  hasHistory,
  onImport,
  onClear
}: {
  isImporting: boolean;
  hasHistory: boolean;
  onImport: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
}) {
  return (
    <div className="importer">
      <label className="file-drop">
        <input type="file" accept=".json,application/json" multiple onChange={onImport} />
        <span><Upload size={17} /> {isImporting ? "Importing..." : "Import Spotify JSON"}</span>
        <small>Extended Streaming History or StreamingHistory_music files</small>
      </label>
      <button className="secondary-button" type="button" onClick={onClear} disabled={!hasHistory}>
        <Trash2 size={17} /> Clear import
      </button>
    </div>
  );
}

function HistoryStatsView({ stats, hasHistory, range }: { stats: HistoryStats; hasHistory: boolean; range: HistoryRange }) {
  if (!hasHistory) {
    return (
      <div className="empty-state">
        <h3>No imported history</h3>
        <p>Spotify's live API does not expose exact all-time minutes, so imported Spotify data powers this section.</p>
      </div>
    );
  }

  return (
    <>
      <div className="history-summary">
        <div>
          <strong>{formatDuration(stats.totalMs)}</strong>
          <span>{formatNumber(stats.recordCount)} plays in {historyRangeLabel(range)}</span>
        </div>
        <div>
          <strong>{formatNumber(stats.artistCount)}</strong>
          <span>artists</span>
        </div>
        <div>
          <strong>{formatNumber(stats.trackCount)}</strong>
          <span>tracks</span>
        </div>
      </div>
      <div className="history-columns">
        <section aria-labelledby="history-artists-heading">
          <h3 id="history-artists-heading">Artist minutes</h3>
          <BarList items={stats.topArtists} type="artist" />
        </section>
        <section aria-labelledby="history-tracks-heading">
          <h3 id="history-tracks-heading">Song minutes</h3>
          <BarList items={stats.topTracks} type="track" />
        </section>
      </div>
    </>
  );
}

function BarList({ items, type }: { items: Array<ArtistStat | TrackStat>; type: "artist" | "track" }) {
  if (!items.length) {
    return <p className="muted">No plays in this range.</p>;
  }

  const max = Math.max(...items.map((item) => item.ms), 1);

  return (
    <div className="bar-list">
      {items.slice(0, 12).map((item, index) => {
        const isTrack = type === "track";
        const trackItem = item as TrackStat;
        const artistItem = item as ArtistStat;
        const width = Math.max((item.ms / max) * 100, 3);
        const title = isTrack ? trackItem.track : artistItem.name;
        const subtitle = isTrack ? trackItem.artist : `${formatNumber(artistItem.plays)} plays`;

        return (
          <div className="bar-row" key={`${title}-${index}`}>
            <span className="bar-rank">{index + 1}</span>
            <span className="bar-copy">
              <strong>{title}</strong>
              <small>{subtitle}</small>
            </span>
            <span className="bar-value">{formatDuration(item.ms)}</span>
            <span className="bar-track" aria-hidden="true"><span style={{ width: `${width}%` }} /></span>
          </div>
        );
      })}
    </div>
  );
}

function RecentStatsView({ recent, stats }: { recent: RecentlyPlayedItem[]; stats: RecentStats }) {
  if (!recent.length) {
    return (
      <div className="empty-state compact">
        <h3>No recent plays loaded</h3>
        <p>Refresh after Spotify login to load the latest recently played tracks.</p>
      </div>
    );
  }

  return (
    <div className="recent-layout">
      <div className="history-summary slim">
        <div>
          <strong>{formatDuration(stats.totalMs)}</strong>
          <span>track-length estimate</span>
        </div>
        <div>
          <strong>{formatNumber(stats.artistCount)}</strong>
          <span>artists sampled</span>
        </div>
        <div>
          <strong>{stats.firstPlayed ? formatDate(stats.firstPlayed) : "Now"}</strong>
          <span>oldest play</span>
        </div>
      </div>
      <div className="track-list recent-list">
        {recent.slice(0, 10).map((item, index) => <RecentRow item={item} index={index} key={`${item.played_at}-${index}`} />)}
      </div>
    </div>
  );
}

function RecentRow({ item, index }: { item: RecentlyPlayedItem; index: number }) {
  const track = item.track;
  const image = track.album?.images?.[2]?.url || track.album?.images?.[1]?.url || track.album?.images?.[0]?.url;
  const artists = track.artists?.map((artist) => artist.name).join(", ") || "Unknown artist";

  return (
    <div className="track-row">
      <span className="track-rank">{index + 1}</span>
      {image ? <img src={image} alt="" /> : <span className="track-art">{initials(track.name || "?")}</span>}
      <span>
        <strong>{track.name || "Unknown track"}</strong>
        <small>{artists}</small>
      </span>
      <em>{formatRelativeDate(item.played_at)}</em>
    </div>
  );
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path);
  return readApiResponse<T>(response);
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return readApiResponse<T>(response);
}

async function readApiResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const apiError = payload as ApiErrorResponse;
    throw Object.assign(new Error(apiError.message || response.statusText), { code: apiError.code });
  }

  return payload as T;
}

function isReauthorizationError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "reauthorization_required";
}

function normalizeHistoryRecord(record: unknown): HistoryRecord | null {
  if (!record || typeof record !== "object") {
    return null;
  }

  const value = record as Record<string, unknown>;
  const playedAt = parsePlayedAt(value.ts || value.endTime);
  const msPlayed = Number(value.ms_played ?? value.msPlayed ?? 0);
  const track = value.master_metadata_track_name || value.trackName;
  const artist = value.master_metadata_album_artist_name || value.artistName;
  const album = value.master_metadata_album_album_name || value.albumName || "";
  const uri = value.spotify_track_uri || "";

  if (!playedAt || !Number.isFinite(msPlayed) || msPlayed <= 0 || !track || !artist) {
    return null;
  }

  return {
    playedAt: playedAt.toISOString(),
    msPlayed,
    track: String(track),
    artist: String(artist),
    album: String(album || ""),
    uri: String(uri || "")
  };
}

function isHistoryRecord(record: HistoryRecord | null): record is HistoryRecord {
  return record !== null;
}

function parsePlayedAt(value: unknown): Date | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) {
    return new Date(`${value.replace(" ", "T")}:00Z`);
  }

  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dedupeRecords(records: HistoryRecord[]): HistoryRecord[] {
  const seen = new Set<string>();
  const deduped: HistoryRecord[] = [];

  for (const record of records) {
    const key = `${record.playedAt}|${record.artist}|${record.track}|${record.msPlayed}`;

    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(record);
    }
  }

  return deduped.sort((a, b) => new Date(b.playedAt).getTime() - new Date(a.playedAt).getTime());
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(HISTORY_STORE)) {
        const store = db.createObjectStore(HISTORY_STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("playedAt", "playedAt");
        store.createIndex("artist", "artist");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadHistory(): Promise<HistoryRecord[]> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(HISTORY_STORE, "readonly");
    const request = transaction.objectStore(HISTORY_STORE).getAll();

    request.onsuccess = () => resolve(request.result as HistoryRecord[]);
    request.onerror = () => reject(request.error);
  });
}

async function saveHistory(records: HistoryRecord[]): Promise<void> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(HISTORY_STORE, "readwrite");
    const store = transaction.objectStore(HISTORY_STORE);
    store.clear();
    records.forEach((record) => store.add(record));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function clearHistory(): Promise<void> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(HISTORY_STORE, "readwrite");
    transaction.objectStore(HISTORY_STORE).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function getHistoryStats(records: HistoryRecord[], rangeId: HistoryRange): HistoryStats {
  const filteredRecords = filterHistoryByRange(records, rangeId);
  const artistMap = new Map<string, ArtistStat>();
  const trackMap = new Map<string, TrackStat>();
  let totalMs = 0;

  for (const record of filteredRecords) {
    totalMs += record.msPlayed;

    const artistEntry = artistMap.get(record.artist) || { name: record.artist, ms: 0, plays: 0 };
    artistEntry.ms += record.msPlayed;
    artistEntry.plays += 1;
    artistMap.set(record.artist, artistEntry);

    const trackKey = `${record.artist}__${record.track}`;
    const trackEntry = trackMap.get(trackKey) || { artist: record.artist, track: record.track, ms: 0, plays: 0 };
    trackEntry.ms += record.msPlayed;
    trackEntry.plays += 1;
    trackMap.set(trackKey, trackEntry);
  }

  const topArtists = Array.from(artistMap.values()).sort(sortByMsThenPlays);
  const topTracks = Array.from(trackMap.values()).sort(sortByMsThenPlays);

  return {
    totalMs,
    recordCount: filteredRecords.length,
    artistCount: artistMap.size,
    trackCount: trackMap.size,
    topArtist: topArtists[0] || null,
    topArtists,
    topTracks
  };
}

function getRecentStats(records: RecentlyPlayedItem[]): RecentStats {
  const artistMap = new Map<string, number>();
  let totalMs = 0;
  let firstPlayed: Date | null = null;

  for (const item of records) {
    const track = item.track;
    const ms = Number(track.duration_ms || 0);
    totalMs += ms;
    const artist = track.artists?.[0]?.name || "Unknown artist";
    artistMap.set(artist, (artistMap.get(artist) || 0) + ms);

    const playedAt = item.played_at ? new Date(item.played_at) : null;
    if (playedAt && (!firstPlayed || playedAt < firstPlayed)) {
      firstPlayed = playedAt;
    }
  }

  return {
    totalMs,
    playCount: records.length,
    artistCount: artistMap.size,
    firstPlayed
  };
}

function filterHistoryByRange(records: HistoryRecord[], rangeId: HistoryRange): HistoryRecord[] {
  const range = historyRanges.find((item) => item.id === rangeId);

  if (!range?.days) {
    return records;
  }

  const cutoff = Date.now() - range.days * 24 * 60 * 60 * 1000;
  return records.filter((record) => new Date(record.playedAt).getTime() >= cutoff);
}

function sortByMsThenPlays(a: { ms: number; plays: number }, b: { ms: number; plays: number }): number {
  return b.ms - a.ms || b.plays - a.plays;
}

function apiRangeLabel(range: ApiRange): string {
  return apiRanges.find((item) => item.id === range)?.label || "Spotify range";
}

function historyRangeLabel(range: HistoryRange): string {
  return historyRanges.find((item) => item.id === range)?.label || "selected range";
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(Number(ms || 0) / 60000);

  if (totalMinutes < 60) {
    return `${formatNumber(totalMinutes)} min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${formatNumber(hours)} hr ${minutes} min` : `${formatNumber(hours)} hr`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function formatRelativeDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const diffMs = Date.now() - date.getTime();
  const minutes = Math.round(diffMs / 60000);

  if (minutes < 60) {
    return `${Math.max(minutes, 1)}m ago`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return `${hours}h ago`;
  }

  return formatDate(date);
}

function initials(value: string): string {
  return String(value || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error.";
}
