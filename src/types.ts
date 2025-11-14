export type Choice = 'ud' | 'not_ud';

export interface Player {
  id: string; // socket id
  name: string;
  avatar: string;
  ready: boolean;
  alive: boolean;
  respondedAt?: number; // server timestamp ms
  response?: Choice;
}

export interface RoomSettings {
  roundMs: number;
  intermissionMs: number;
}

export interface Round {
  itemId: string;
  itemText: string;
  itemImage?: string;
  flies: boolean;
  roundStartTs: number;
  deadlineTs: number;
  responses: Record<string, Choice>;
}

export interface RoundResultsDetail {
  choice?: Choice;
  correct: boolean;
  inTime: boolean;
}

export interface RoundResultsSummary {
  itemText: string;
  flies: boolean;
  perPlayer: Record<string, RoundResultsDetail>;
}

export interface Room {
  code: string;
  hostId: string;
  status: 'lobby' | 'playing' | 'game_over';
  players: Record<string, Player>;
  round?: Round;
  winnerId?: string;
  settings: RoomSettings;
}
