export type ApiRange = "short_term" | "medium_term" | "long_term";
export type HistoryRange = "all" | "365" | "90" | "30" | "7";

export interface SpotifyImage {
  url: string;
  height?: number;
  width?: number;
}

export interface SpotifyProfile {
  id: string;
  display_name?: string;
  email?: string;
  images?: SpotifyImage[];
}

export interface SpotifyArtist {
  id: string;
  name: string;
  genres?: string[];
  images?: SpotifyImage[];
  external_urls?: {
    spotify?: string;
  };
}

export interface SpotifyTrack {
  id: string;
  name: string;
  duration_ms: number;
  artists?: Array<{
    id: string;
    name: string;
  }>;
  album?: {
    name: string;
    images?: SpotifyImage[];
  };
  external_urls?: {
    spotify?: string;
  };
}

export interface RecentlyPlayedItem {
  played_at: string;
  track: SpotifyTrack;
}

export interface SpotifyPaging<T> {
  items: T[];
}

export interface SessionResponse {
  authenticated: boolean;
  clientId: string | null;
}

export interface AuthConfigResponse {
  redirectUri: string;
  scopes: string[];
}

export interface AuthStartResponse {
  authorizeUrl: string;
}

export interface ApiErrorResponse {
  code: string;
  message: string;
}

export interface HistoryRecord {
  id?: number;
  playedAt: string;
  msPlayed: number;
  track: string;
  artist: string;
  album: string;
  uri: string;
}
